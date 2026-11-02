export interface OutcomeRow {
  agency_id: string; order_id: string; result: 'accepted' | 'rejected'; rounds: number; days_to_acceptance: number | null;
  estimate_error: Record<'labor' | 'parts' | 'total', { estimated: number; paid: number; delta: number; pct: number | null }> | null;
  complete_same_day: boolean; llm_cost_usd: number; llm_tokens: number;
}
const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);

export function computeMetrics(rows: OutcomeRow[]) {
  const n = rows.length;
  const accepted = rows.filter(r => r.result === 'accepted');
  const concept = (k: 'labor' | 'parts' | 'total') => {
    const e = rows.map(r => r.estimate_error?.[k]).filter((x): x is NonNullable<typeof x> => !!x);
    return { n: e.length, mae_pesos: avg(e.map(x => Math.abs(x.delta))), bias_pesos: avg(e.map(x => x.delta)), mape_pct: avg(e.filter(x => x.pct !== null).map(x => Math.abs(x.pct!))) };
  };
  return {
    prea_count: n,
    first_pass_rejection_rate: n ? +(rows.filter(r => r.rounds > 1 || r.result === 'rejected').length / n).toFixed(4) : null,
    avg_rounds_to_acceptance: avg(accepted.map(r => r.rounds)),
    avg_days_to_acceptance: avg(accepted.map(r => r.days_to_acceptance).filter((x): x is number => x !== null)),
    estimate_error: { labor: concept('labor'), parts: concept('parts'), total: concept('total') },
    same_day_complete_capture_rate: n ? +(rows.filter(r => r.complete_same_day).length / n).toFixed(4) : null,
    llm_cost_per_prea_usd: n ? +(rows.reduce((a, r) => a + r.llm_cost_usd, 0) / n).toFixed(6) : null,
    llm_tokens_per_prea: n ? Math.round(rows.reduce((a, r) => a + r.llm_tokens, 0) / n) : null,
  };
}
