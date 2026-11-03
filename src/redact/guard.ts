import { redactDetailed } from './index.js';
import { VIN_RE, looksLikeVin } from './vin.js';

/** Se lanza cuando algo intenta llegar al modelo real sin haber pasado por la redacción. */
export class RedactionRequiredError extends Error {
  constructor(msg = 'el texto no pasó por la redacción de datos personales') { super(msg); this.name = 'RedactionRequiredError'; }
}

const sealed = new WeakSet<object>();

/** Recorre un valor y devuelve las cadenas donde una segunda pasada de redacción aún encuentra algo (o un VIN completo). */
export function scanResidual(value: unknown, path = '$', out: Array<{ path: string; labels: string[] }> = []) {
  if (typeof value === 'string') {
    const labels = redactDetailed(value).findings.map(f => f.label);
    for (const m of value.match(VIN_RE) ?? []) if (looksLikeVin(m)) labels.push('VIN');
    if (labels.length) out.push({ path, labels: [...new Set(labels)] });
  } else if (Array.isArray(value)) value.forEach((v, i) => scanResidual(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) scanResidual(v, `${path}.${k}`, out);
  return out;
}

/**
 * Marca un payload como apto para el modelo real. Lo verifica con una segunda pasada: si quedan datos personales
 * o un VIN completo, lanza RedactionRequiredError (sin incluir el texto en el mensaje). Devuelve una copia congelada.
 */
export function sealForModel<T>(payload: T): T {
  const bad = scanResidual(payload);
  if (bad.length) throw new RedactionRequiredError(`quedan datos personales sin redactar en ${bad.map(b => `${b.path} (${b.labels.join(',')})`).join('; ')}`);
  const copy = deepFreeze(structuredClone(payload));
  if (copy && typeof copy === 'object') sealed.add(copy as object);
  return copy;
}
export const isSealed = (x: unknown) => !!x && typeof x === 'object' && sealed.has(x as object);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { Object.values(o as object).forEach(deepFreeze); Object.freeze(o); }
  return o;
}
