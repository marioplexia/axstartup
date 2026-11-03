export interface PayLine { id: string; order_id: string; claim_date: string | null; concept: 'labor' | 'part' | 'other'; part_no: string | null; op_code: string | null;
  quantity: number; hours: number | null; rate: number | null; amount_paid: number }
export interface CurrentTab { tab_key: string; version: number; value: number }
export interface TabProposal {
  tab_key: string; kind: 'labor_rate' | 'standard_time' | 'part_price'; subject: string | null; unit: string; value: number; previous: number | null;
  support: string[]; backtest: { cases_total: number; improved: number; worsened: number; mae_old: number; mae_new: number };
}
export interface TabSkip { tab_key: string; reason: string }

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Observaciones por tabulador a partir de pagos reales. */
function observations(lines: PayLine[]) {
  const g = new Map<string, { kind: TabProposal['kind']; subject: string | null; unit: string; obs: Array<{ id: string; date: string; v: number }> }>();
  const add = (key: string, kind: TabProposal['kind'], subject: string | null, unit: string, l: PayLine, v: number) => {
    if (!Number.isFinite(v) || v <= 0) return;
    if (!g.has(key)) g.set(key, { kind, subject, unit, obs: [] });
    g.get(key)!.obs.push({ id: l.id, date: l.claim_date ?? '', v });
  };
  for (const l of lines) {
    if (l.concept === 'part' && l.part_no && l.quantity > 0) add(`part_price:${l.part_no}`, 'part_price', l.part_no, 'MXN', l, l.amount_paid / l.quantity);
    if (l.concept === 'labor' && l.hours && l.hours > 0) {
      if (l.op_code) add(`std_time:${l.op_code}`, 'standard_time', l.op_code, 'h', l, l.hours);
      add('labor_rate', 'labor_rate', null, 'MXN/h', l, l.rate ?? l.amount_paid / l.hours);
    }
  }
  return g;
}

/**
 * Propone nuevas versiones cuando las últimas `minPayments` observaciones forman un grupo compacto (±clusterPct de la mediana)
 * y la mediana se desvía al menos `deviationPct` del tabulador vigente. Backtest: error absoluto vs lo pagado, tabulador viejo contra nuevo.
 */
export function proposeTabulators(lines: PayLine[], current: CurrentTab[], p: { minPayments: number; deviationPct: number; clusterPct: number }) {
  const proposals: TabProposal[] = []; const skipped: TabSkip[] = [];
  const cur = new Map(current.map(t => [t.tab_key, t]));
  for (const [key, g] of observations(lines)) {
    if (g.obs.length < p.minPayments) { skipped.push({ tab_key: key, reason: `solo ${g.obs.length} pagos (mínimo ${p.minPayments})` }); continue; }
    const recent = [...g.obs].sort((a, b) => a.date.localeCompare(b.date)).slice(-p.minPayments);
    const m = median(recent.map(x => x.v));
    if (!recent.every(x => Math.abs(x.v - m) / m * 100 <= p.clusterPct)) { skipped.push({ tab_key: key, reason: 'pagos recientes no son consistentes entre sí' }); continue; }
    const old = cur.get(key)?.value ?? null;
    if (old !== null && Math.abs(m - old) / old * 100 < p.deviationPct) { skipped.push({ tab_key: key, reason: 'desviación menor al umbral' }); continue; }
    const value = r2(m);
    const mae = (ref: number | null) => ref === null ? Infinity : recent.reduce((a, x) => a + Math.abs(x.v - ref), 0) / recent.length;
    const improved = recent.filter(x => Math.abs(x.v - value) < (old === null ? Infinity : Math.abs(x.v - old))).length;
    const worsened = recent.filter(x => old !== null && Math.abs(x.v - value) > Math.abs(x.v - old)).length;
    if (old !== null && improved < worsened) { skipped.push({ tab_key: key, reason: 'el backtest empeora el error' }); continue; }
    proposals.push({ tab_key: key, kind: g.kind, subject: g.subject, unit: g.unit, value, previous: old, support: recent.map(x => x.id),
      backtest: { cases_total: recent.length, improved, worsened, mae_old: old === null ? 0 : r2(mae(old)), mae_new: r2(mae(value)) } });
  }
  return { proposals, skipped };
}
