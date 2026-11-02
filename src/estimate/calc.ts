/**
 * Calculadora determinista del pago estimado (bucle 2). Sin IA: el agente solo extrae conceptos.
 * Aritmética en centavos enteros. Mismos insumos => mismo resultado.
 */
export interface TabRow { id: string; tab_key: string; version: number; kind: 'labor_rate' | 'standard_time' | 'part_price' | 'cap' | 'deductible'; subject: string | null; value: number }
export interface NonPayable { rule_id: string; rule_key: string; version: number; part_no?: string; op_code?: string }
export interface Concepts {
  operations: Array<{ op_code: string; hours?: number }>;
  parts: Array<{ part_no: string; quantity: number; unit_price?: number }>;
}
export interface Line {
  concept: 'labor' | 'part'; ref: string; quantity: number; unit: number; amount: number;
  requested_hours?: number; paid_hours?: number; source: string[]; flags: string[];
}
export interface Estimate {
  total: number; subtotals: { labor: number; parts: number }; caps_applied: Array<{ cap: string; limit: number; before: number; after: number }>;
  deductible: number; lines: Line[]; warnings: string[]; complete: boolean;
  tabulator_versions: Array<{ id: string; tab_key: string; version: number }>;
  rule_versions: Array<{ rule_id: string; rule_key: string; version: number }>;
}

const c = (n: number) => Math.round(n * 100 + (n >= 0 ? 1e-9 : -1e-9)); // a centavos, mitad hacia arriba
const m = (cents: number) => cents / 100;

export function calculate(input: Concepts, tabs: TabRow[], nonPayable: NonPayable[] = []): Estimate {
  const used = new Map<string, TabRow>();
  const use = (t: TabRow) => { used.set(t.id, t); return `${t.tab_key}@v${t.version}`; };
  const find = (kind: TabRow['kind'], subject: string | null) => tabs.find(t => t.kind === kind && t.subject === subject);
  const usedRules = new Map<string, NonPayable>();

  const warnings: string[] = [];
  let complete = true;
  const lines: Line[] = [];
  const rate = find('labor_rate', null);
  if (!rate && input.operations.length) { warnings.push('Sin tarifa de mano de obra vigente'); complete = false; }

  for (const op of input.operations) {
    const flags: string[] = []; const source: string[] = [];
    const std = find('standard_time', op.op_code);
    let hours: number;
    if (std) { hours = std.value; source.push(use(std)); if (op.hours != null && op.hours !== std.value) flags.push(`horas solicitadas ${op.hours} difieren del estándar ${std.value}`); }
    else { hours = op.hours ?? 0; flags.push('sin tiempo estándar'); complete = false; warnings.push(`Sin tiempo estándar para ${op.op_code}`); }
    let amount = rate ? c(hours * rate.value) : 0;
    if (rate) source.push(use(rate));
    const np = nonPayable.find(r => r.op_code === op.op_code);
    if (np) { amount = 0; flags.push('no pagable según regla'); usedRules.set(np.rule_id, np); }
    lines.push({ concept: 'labor', ref: op.op_code, quantity: 1, unit: rate ? rate.value : 0, amount: m(amount), requested_hours: op.hours, paid_hours: hours, source, flags });
  }

  for (const p of input.parts) {
    const flags: string[] = []; const source: string[] = [];
    const tab = find('part_price', p.part_no);
    let unit: number;
    if (tab) { unit = tab.value; source.push(use(tab)); if (p.unit_price != null && p.unit_price !== tab.value) flags.push(`precio solicitado ${p.unit_price} difiere del tabulador ${tab.value}`); }
    else { unit = p.unit_price ?? 0; flags.push('sin precio en tabulador'); complete = false; warnings.push(`Sin precio de tabulador para ${p.part_no}`); }
    let amount = Math.round(p.quantity * c(unit));
    const np = nonPayable.find(r => r.part_no === p.part_no);
    if (np) { amount = 0; flags.push('no pagable según regla'); usedRules.set(np.rule_id, np); }
    lines.push({ concept: 'part', ref: p.part_no, quantity: p.quantity, unit, amount: m(amount), source, flags });
  }

  let labor = lines.filter(l => l.concept === 'labor').reduce((a, l) => a + c(l.amount), 0);
  let parts = lines.filter(l => l.concept === 'part').reduce((a, l) => a + c(l.amount), 0);
  const caps: Estimate['caps_applied'] = [];
  const cap = (subject: 'labor' | 'parts' | 'total', v: number) => {
    const t = find('cap', subject); if (!t) return v;
    const lim = c(t.value); use(t);
    if (v > lim) { caps.push({ cap: subject, limit: t.value, before: m(v), after: t.value }); return lim; }
    return v;
  };
  labor = cap('labor', labor);
  parts = cap('parts', parts);
  let total = cap('total', labor + parts);
  const ded = find('deductible', null);
  const dedC = ded ? c(ded.value) : 0;
  if (ded) use(ded);
  total = Math.max(0, total - dedC);

  return {
    total: m(total), subtotals: { labor: m(labor), parts: m(parts) }, caps_applied: caps, deductible: m(dedC),
    lines, warnings, complete,
    tabulator_versions: [...used.values()].map(t => ({ id: t.id, tab_key: t.tab_key, version: t.version })),
    rule_versions: [...usedRules.values()].map(r => ({ rule_id: r.rule_id, rule_key: r.rule_key, version: r.version })),
  };
}
