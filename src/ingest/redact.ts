import { createHash } from 'node:crypto';

/**
 * Redacción de datos personales (mejor esfuerzo, sobre-redacta en caso de duda).
 * Todo texto que vaya al modelo debe pasar por aquí ANTES de guardarse.
 * Conserva: VIN, códigos, números de pieza/operación, importes, kilometraje.
 */
export interface RedactResult { text: string; counts: Record<string, number> }
export interface RedactOpts { knownNames?: string[] }

const TRIG = String.raw`(?:[Cc]liente|[Cc]lienta|[Pp]ropietari[oa]|[Tt]itular|[Cc]onductor[a]?|[Cc]ontacto|[Ss]rita?\.?|[Ss]ra?\.|[Ss]eñor[a]?|[Ll]ic\.|[Ii]ng\.|[Dd]ra?\.|[Aa] nombre de|[Nn]ombre)`;
const CAP = String.raw`[A-ZÁÉÍÓÚÑ][\p{L}']+`;
const NAME_RE = new RegExp(`(${TRIG}\\s*:?\\s+)(${CAP}(?:\\s+(?:(?:de|del|la|los|las)\\s+)?${CAP}){0,3})`, 'gu');

const RULES: Array<[label: string, re: RegExp]> = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['CURP', /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/g],
  ['RFC', /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/g],
  ['TEL', /(?<![\w-])(?:\+?52[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?)\d{3,4}[\s.-]?\d{4}(?![\w-])/g],
  ['PLACA', /\b[A-Z]{3}-\d{2,4}(?:-[A-Z0-9]{1,2})?\b/g],
];

function isDigitsOnlyShort(m: string) { return m.replace(/\D/g, '').length < 10; }

export function redact(input: string, opts: RedactOpts = {}): RedactResult {
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  let t = input;

  for (const n of opts.knownNames ?? []) {
    if (n.trim().length < 3) continue;
    const re = new RegExp(n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'giu');
    t = t.replace(re, () => { bump('NOMBRE'); return '[NOMBRE]'; });
  }
  t = t.replace(NAME_RE, (_m, lead: string) => { bump('NOMBRE'); return `${lead}[NOMBRE]`; });
  for (const [label, re] of RULES) {
    t = t.replace(re, m => {
      if (label === 'TEL' && isDigitsOnlyShort(m)) return m; // no tocar importes ni folios cortos
      bump(label);
      return `[${label}]`;
    });
  }
  return { text: t, counts };
}

/** Redacta todos los valores string de un objeto plano, salvo las llaves protegidas. */
export function redactFields(fields: Record<string, unknown>, opts: RedactOpts = {}, keep: string[] = ['vin']) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = typeof v === 'string' && !keep.includes(k) ? redact(v, opts).text : v;
  return out;
}

export function hashRef(value: string, salt = process.env.PII_SALT ?? 'dev-salt'): string {
  return createHash('sha256').update(salt + '|' + value.trim().toLowerCase()).digest('hex').slice(0, 16);
}
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
