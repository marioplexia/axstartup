export interface Confusion { tp: number; fp: number; fn: number; tn: number }
export function confusion(rows: Array<{ predicted: boolean; actual: boolean }>): Confusion {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) { if (r.predicted && r.actual) c.tp++; else if (r.predicted) c.fp++; else if (r.actual) c.fn++; else c.tn++; }
  return c;
}
const ratio = (a: number, b: number) => (b ? +(a / b).toFixed(3) : null);
export const precision = (c: Confusion) => ratio(c.tp, c.tp + c.fp);
export const recall = (c: Confusion) => ratio(c.tp, c.tp + c.fn);

/** Parsea "PZ-AA-0001 x2, PZ-BB-0002" a conceptos; cantidad 1 si no se indica. */
export function parseParts(s: unknown): Array<{ part_no: string; quantity: number }> {
  if (typeof s !== 'string') return [];
  return [...s.matchAll(/\b(PZ-[A-Z]{2}-\d{4})(?:\s*[xX×]\s*(\d+(?:\.\d+)?))?/g)].map(m => ({ part_no: m[1], quantity: m[2] ? Number(m[2]) : 1 }));
}
