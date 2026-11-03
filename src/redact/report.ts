import { redactDetailed, scanResidual, type Finding } from './index.js';

export interface ReportItem { where: string; findings: Finding[]; redacted: string }
export interface RedactReport { items: ReportItem[]; counts: Record<string, number>; strings: number; residual: Array<{ path: string; labels: string[] }> }

/** Recorre texto plano (por línea) o JSON (por cadena) y arma el reporte de lo que se quitó. */
export function buildReport(raw: string, kind: 'text' | 'json', knownNames: string[] = []): RedactReport {
  const items: ReportItem[] = []; const counts: Record<string, number> = {}; let strings = 0;
  const visit = (s: string, where: string) => {
    strings++;
    const r = redactDetailed(s, { knownNames });
    if (!r.findings.length) return;
    for (const f of r.findings) counts[f.label] = (counts[f.label] ?? 0) + 1;
    items.push({ where, findings: r.findings, redacted: r.text });
  };
  if (kind === 'json') {
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'string') visit(v, path);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(JSON.parse(raw), '$');
  } else raw.split(/\r?\n/).forEach((line, i) => { if (line.trim()) visit(line, `línea ${i + 1}`); });

  // segunda pasada sobre lo ya redactado: lo que aún se detecta es un hueco de la redacción
  const residual = items.flatMap(it => scanResidual(it.redacted, it.where));
  return { items, counts, strings, residual };
}

export function formatReport(rep: RedactReport, file: string): string {
  const out: string[] = [`# Reporte de redacción: ${file}`, '', `Cadenas revisadas: ${rep.strings} · con hallazgos: ${rep.items.length}`,
    `Totales: ${Object.entries(rep.counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'ninguno'}`, '',
    '> CONTIENE los datos originales para revisión manual. No lo subas a git ni lo compartas.', ''];
  for (const it of rep.items) {
    out.push(`## ${it.where}`);
    for (const f of it.findings) out.push(`- ${f.label}: "${f.original}" → ${f.replacement}`);
    out.push(`  resultado: ${it.redacted}`, '');
  }
  out.push(rep.residual.length
    ? `## ⚠ Residuos tras redactar (${rep.residual.length}): revisa y mejora las reglas\n${rep.residual.map(r => `- ${r.path}: ${r.labels.join(',')}`).join('\n')}`
    : '## Sin residuos en una segunda pasada.');
  out.push('', 'Recuerda: los nombres propios sin disparador ("Hablé con X") solo se detectan si pasas --names. Revisa a mano el texto crudo restante.');
  return out.join('\n');
}
