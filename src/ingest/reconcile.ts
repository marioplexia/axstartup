/**
 * Unión PREA ↔ transacción por número de orden. Independiente del formato de origen: los adaptadores (pendientes hasta
 * tener archivos reales) deben producir `{ order_number, ref }` por registro, donde `ref` apunta al registro original
 * (archivo/línea/id) para poder revisarlo a mano.
 */
export interface Keyed { order_number: string; ref: string }
export interface Reconciliation<P extends Keyed, T extends Keyed> {
  matched: Array<{ order_number: string; prea: P; transaction: T }>;
  /** PREA sin ninguna transacción (aún no pagada, o número mal capturado) */
  preaWithoutTransaction: P[];
  /** transacciones sin PREA */
  transactionWithoutPrea: T[];
  /** número de orden repetido dentro de un mismo origen: no se une hasta resolverlo */
  duplicatePreas: Array<{ order_number: string; refs: string[] }>;
  duplicateTransactions: Array<{ order_number: string; refs: string[] }>;
  /** números que difieren solo por formato (espacios, mayúsculas, ceros a la izquierda) entre ambos lados */
  nearMiss: Array<{ prea: string; transaction: string }>;
}

/** Normalización mínima y conservadora; ajustar con el formato real. */
export const normalizeOrderNumber = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');
const loose = (s: string) => normalizeOrderNumber(s).replace(/[^A-Z0-9]/g, '').replace(/(^|[A-Z])0+(?=\d)/g, '$1');

function groupBy<T extends Keyed>(xs: T[]) {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = normalizeOrderNumber(x.order_number); m.set(k, [...(m.get(k) ?? []), x]); }
  return m;
}

export function reconcile<P extends Keyed, T extends Keyed>(preas: P[], transactions: T[]): Reconciliation<P, T> {
  const pm = groupBy(preas), tm = groupBy(transactions);
  const out: Reconciliation<P, T> = { matched: [], preaWithoutTransaction: [], transactionWithoutPrea: [], duplicatePreas: [], duplicateTransactions: [], nearMiss: [] };
  for (const [k, ps] of pm) if (ps.length > 1) out.duplicatePreas.push({ order_number: k, refs: ps.map(p => p.ref) });
  for (const [k, ts] of tm) if (ts.length > 1) out.duplicateTransactions.push({ order_number: k, refs: ts.map(t => t.ref) });
  for (const [k, ps] of pm) {
    const ts = tm.get(k);
    if (!ts) out.preaWithoutTransaction.push(...ps);
    else if (ps.length === 1 && ts.length === 1) out.matched.push({ order_number: k, prea: ps[0], transaction: ts[0] });
  }
  for (const [k, ts] of tm) if (!pm.has(k)) out.transactionWithoutPrea.push(...ts);
  // posibles errores de captura: no unen, pero normalizados "flojo" sí coincidirían
  const looseP = new Map(out.preaWithoutTransaction.map(p => [loose(p.order_number), p.order_number]));
  for (const t of out.transactionWithoutPrea) { const p = looseP.get(loose(t.order_number)); if (p) out.nearMiss.push({ prea: p, transaction: t.order_number }); }
  return out;
}

export function reconciliationSummary(r: Reconciliation<Keyed, Keyed>): string {
  const l = [`Unidas: ${r.matched.length}`, `PREA sin transacción: ${r.preaWithoutTransaction.length}`, `Transacciones sin PREA: ${r.transactionWithoutPrea.length}`,
    `Órdenes duplicadas en PREA: ${r.duplicatePreas.length} · en transacciones: ${r.duplicateTransactions.length}`, `Posibles errores de captura: ${r.nearMiss.length}`];
  for (const p of r.preaWithoutTransaction) l.push(`  sin transacción: ${p.order_number} (${p.ref})`);
  for (const t of r.transactionWithoutPrea) l.push(`  sin PREA: ${t.order_number} (${t.ref})`);
  for (const d of r.duplicatePreas) l.push(`  PREA duplicada ${d.order_number}: ${d.refs.join(', ')}`);
  for (const d of r.duplicateTransactions) l.push(`  transacción duplicada ${d.order_number}: ${d.refs.join(', ')}`);
  for (const n of r.nearMiss) l.push(`  ¿mismo número? PREA "${n.prea}" ~ transacción "${n.transaction}"`);
  return l.join('\n');
}
