import { createHash } from 'node:crypto';
import {
  Label, FieldKind, fieldKind, NAME_RE, STREET_RE, COLONIA_RE, CP_RE, TEL_RE, TEL_LOCAL_RE, EMAIL_RE, EMAIL_WORDS_RE,
  CURP_RE, RFC_RE, ELECTOR_RE, ELECTOR_CTX_RE, PLACA_RE, PLACA_CTX_RE, plateSkip,
} from './patterns.js';
import { VIN_RE, looksLikeVin, vinToken, vinForModel } from './vin.js';

export interface Finding { label: Label; original: string; replacement: string }
export interface RedactResult { text: string; counts: Record<string, number>; findings: Finding[] }
export interface RedactOpts { knownNames?: string[] }

const digits = (s: string) => s.replace(/\D/g, '').length;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Redacción de datos personales (mejor esfuerzo, sobre-redacta en caso de duda). Todo texto que vaya al modelo o a
 * almacenamiento de texto libre debe pasar por aquí. Conserva: códigos, números de pieza/operación, importes, kilometraje.
 * El VIN se reemplaza por [VIN …últimos6] (ver vin.ts).
 */
export function redactDetailed(input: string, opts: RedactOpts = {}): RedactResult {
  const findings: Finding[] = [];
  let t = input;
  const hit = (label: Label, original: string, replacement: string) => { findings.push({ label, original, replacement }); return replacement; };
  const sub = (re: RegExp, label: Label, rep: (m: string, ...g: string[]) => string | null, orig?: (m: string, ...g: string[]) => string) => {
    t = t.replace(re, (m, ...g) => {
      const gs = g.slice(0, -2) as string[];
      const r = rep(m, ...gs);
      return r === null ? m : hit(label, orig ? orig(m, ...gs) : m, r);
    });
  };

  sub(VIN_RE, 'VIN', m => looksLikeVin(m) ? vinToken(m) : null);
  sub(EMAIL_RE, 'EMAIL', () => '[EMAIL]');
  sub(EMAIL_WORDS_RE, 'EMAIL', () => '[EMAIL]');
  sub(CURP_RE, 'CURP', () => '[CURP]');
  sub(ELECTOR_RE, 'CLAVE_ELECTOR', () => '[CLAVE_ELECTOR]');
  sub(ELECTOR_CTX_RE, 'CLAVE_ELECTOR', (m, lead, code) => /\d/.test(code) ? `${lead}[CLAVE_ELECTOR]` : null);
  sub(RFC_RE, 'RFC', () => '[RFC]');
  sub(TEL_RE, 'TEL', m => digits(m) < 10 ? null : '[TEL]'); // no tocar importes ni folios cortos
  sub(TEL_LOCAL_RE, 'TEL', (_m, lead) => `${lead}[TEL]`);
  sub(CP_RE, 'CP', () => '[CP]');
  sub(COLONIA_RE, 'DOMICILIO', () => '[DOMICILIO]');
  sub(STREET_RE, 'DOMICILIO', () => '[DOMICILIO]');
  sub(PLACA_CTX_RE, 'PLACA', (_m, lead, code) => /\d/.test(code) ? `${lead}[PLACA]` : null);
  sub(PLACA_RE, 'PLACA', m => plateSkip(m) ? null : '[PLACA]');

  for (const n of opts.knownNames ?? []) {
    if (n.trim().length < 3) continue;
    const re = new RegExp(escapeRe(n.trim()).replace(/\s+/g, '\\s+'), 'giu');
    sub(re, 'NOMBRE', () => '[NOMBRE]');
  }
  sub(NAME_RE, 'NOMBRE', (_m, lead) => `${lead}[NOMBRE]`, (_m, _lead, name) => name);

  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.label] = (counts[f.label] ?? 0) + 1;
  return { text: t, counts, findings };
}

export function redact(input: string, opts: RedactOpts = {}): { text: string; counts: Record<string, number> } {
  const { text, counts } = redactDetailed(input, opts);
  return { text, counts };
}

const REPLACE_BY_KIND: Record<FieldKind, string> = { NOMBRE: '[NOMBRE]', TEL: '[TEL]', EMAIL: '[EMAIL]', DOMICILIO: '[DOMICILIO]', PLACA: '[PLACA]', RFC: '[RFC]', CURP: '[CURP]', CP: '[CP]' };

/**
 * Redacta los valores de un objeto plano. Los campos de cliente (nombre, teléfono, correo, domicilio…) se reemplazan
 * completos por su etiqueta, sin importar el contenido; el resto pasa por `redact`. El VIN queda intacto: es para
 * almacenamiento privado. Para el modelo usa `toModelView`.
 */
export function redactFields(fields: Record<string, unknown>, opts: RedactOpts = {}, keep: string[] = ['vin']) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (keep.includes(k)) { out[k] = v; continue; }
    const kind = fieldKind(k);
    if (kind && v !== null && v !== undefined && String(v).trim() !== '') out[k] = REPLACE_BY_KIND[kind];
    else out[k] = typeof v === 'string' ? redact(v, opts).text : v;
  }
  return out;
}

/** Vista para el modelo de un objeto de campos: el VIN completo se sustituye por últimos 6 + hash. */
export function toModelView<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'vin' && typeof v === 'string' && v.trim()) Object.assign(out, vinForModel(v));
    else if (typeof v === 'string') out[k] = redact(v).text; // por si un VIN aparece dentro de otro campo
  }
  return out;
}

export function hashRef(value: string, salt = process.env.PII_SALT ?? 'dev-salt'): string {
  return createHash('sha256').update(salt + '|' + value.trim().toLowerCase()).digest('hex').slice(0, 16);
}
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export { sealForModel, isSealed, RedactionRequiredError, scanResidual } from './guard.js';
export { vinLast6, vinHash, vinForModel, vinToken } from './vin.js';
export { fieldKind } from './patterns.js';
