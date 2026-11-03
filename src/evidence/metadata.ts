import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Lector de evidencia por METADATOS (sin OCR ni modelo): el asesor etiqueta cada archivo con un tipo del catálogo
 * (taxonomy/evidence-kinds.yaml) y aquí se valida presencia y tipo. La lectura del contenido de imágenes/PDF con el
 * modelo es una fase aparte.
 */
const KindDef = z.object({ label: z.string(), accept: z.array(z.string()).min(1), satisfies: z.array(z.string()).default([]) });
export const EvidenceCatalog = z.object({ version: z.number().int(), max_size_mb: z.number().positive().default(25), kinds: z.record(z.string(), KindDef) });
export type EvidenceCatalog = z.infer<typeof EvidenceCatalog>;

export function loadEvidenceCatalog(file = path.resolve(import.meta.dirname, '../../taxonomy/evidence-kinds.yaml')): EvidenceCatalog {
  return EvidenceCatalog.parse(parse(fs.readFileSync(file, 'utf8')));
}
let cached: EvidenceCatalog | undefined;
export const evidenceCatalog = () => (cached ??= loadEvidenceCatalog());

export interface EvidenceMeta { kind: string; filename?: string; mime?: string; size_bytes?: number; sha256?: string }
export interface MetadataReading {
  source: 'metadata';
  concepts: { operations: []; parts: [] };
  evidence_detected: string[];
  missing: Array<{ kind: string; reason: string }>;
  notes: string[];
}

const MIME: Record<string, string[]> = {
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'], png: ['image/png'], heic: ['image/heic', 'image/heif'], webp: ['image/webp'],
  pdf: ['application/pdf'], xml: ['application/xml', 'text/xml'], mp4: ['video/mp4'], mov: ['video/quicktime'],
};
const ext = (f?: string) => (f && f.includes('.') ? f.split('.').pop()!.toLowerCase() : '');

/** Problema de un archivo concreto, o null si es válido para el tipo con el que se etiquetó. */
export function validateFile(e: EvidenceMeta, cat: EvidenceCatalog = evidenceCatalog()): string | null {
  const def = cat.kinds[e.kind];
  if (!def) return `etiqueta desconocida "${e.kind}"`;
  // sin nombre de archivo = solo se conoce la etiqueta (historial de expedientes); solo se valida el tipo etiquetado
  if (e.filename === undefined) return null;
  if (!e.filename.trim()) return `"${e.kind}" sin nombre de archivo`;
  const x = ext(e.filename);
  if (!def.accept.includes(x)) return `"${e.filename}" no es un tipo válido para ${e.kind} (se acepta: ${def.accept.join(', ')})`;
  if (e.mime && !(MIME[x] ?? []).includes(e.mime.toLowerCase())) return `"${e.filename}": el tipo declarado (${e.mime}) no coincide con la extensión .${x}`;
  if (e.size_bytes !== undefined && e.size_bytes <= 0) return `"${e.filename}" está vacío`;
  if (e.size_bytes !== undefined && e.size_bytes > cat.max_size_mb * 1024 * 1024) return `"${e.filename}" excede ${cat.max_size_mb} MB`;
  return null;
}

/** Separa la evidencia que cuenta de la que no (tipo/extensión que no corresponde, vacía, mismo archivo con dos etiquetas). */
export function classifyEvidence<T extends EvidenceMeta>(evidence: T[], cat: EvidenceCatalog = evidenceCatalog()) {
  const valid: T[] = []; const invalid: Array<{ e: T; why: string }> = [];
  const bySha = new Map<string, string>();
  for (const e of evidence) {
    let why = validateFile(e, cat);
    // el mismo archivo (mismo sha256) etiquetado con dos tipos distintos solo cuenta para el primero
    if (!why && e.sha256) {
      const prev = bySha.get(e.sha256);
      if (prev && prev !== e.kind) why = `"${e.filename}" ya se usó como ${prev}; no cuenta también como ${e.kind}`;
      else bySha.set(e.sha256, e.kind);
    }
    if (why) invalid.push({ e, why }); else valid.push(e);
  }
  return { valid, invalid };
}

export function readEvidenceMetadata(evidence: EvidenceMeta[], requiredKinds: string[], cat: EvidenceCatalog = evidenceCatalog()): MetadataReading {
  const { valid, invalid } = classifyEvidence(evidence, cat);
  const detected = new Set<string>();
  for (const e of valid) { detected.add(e.kind); for (const s of cat.kinds[e.kind].satisfies) detected.add(s); }
  const problems = new Map<string, string[]>(); // tipo exigido -> motivos por los que un archivo no cuenta
  for (const { e, why } of invalid) for (const k of [e.kind, ...(cat.kinds[e.kind]?.satisfies ?? [])]) problems.set(k, [...(problems.get(k) ?? []), why]);
  const missing = requiredKinds.filter(k => !detected.has(k)).map(kind => {
    const p = problems.get(kind);
    return { kind, reason: p?.length ? `hay un archivo pero no es válido: ${p[0]}` : 'el asesor no adjuntó evidencia de este tipo' };
  });
  const notes = [...new Set(invalid.map(i => `Evidencia no válida: ${i.why}`))].slice(0, 5);
  return { source: 'metadata', concepts: { operations: [], parts: [] }, evidence_detected: [...detected], missing, notes };
}
