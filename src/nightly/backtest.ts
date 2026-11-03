import { runChecklist, type PriorPrea, type RuleRow } from '../verify/checklist.js';
import type { Case } from './cases.js';

export interface RuleBacktest { cases_total: number; true_positives: number; false_positives: number; missed: number; precision: number | null; recall: number | null; flagged: string[] }

/** Aplica la regla a la PRIMERA versión de cada caso histórico y compara contra los rechazos reales por esa causa. */
export function backtestRule(rule: RuleRow, cases: Case[], rejectedForCause: Set<string>): RuleBacktest {
  const flagged: string[] = [];
  for (const k of cases) {
    const submit = (k.v1.submitted_at ?? k.claim_date ?? '1970-01-01').slice(0, 10);
    const prior: PriorPrea[] = cases.filter(p => p.order_id !== k.order_id && p.claim_date && k.claim_date && p.claim_date < k.claim_date)
      .map(p => ({ order_id: p.order_id, order_number: p.order_number, vin: (p.v1.fields.vin as string) ?? null, fields: p.v1.fields, claim_date: p.claim_date }));
    const f = runChecklist([rule], { fields: k.v1.fields, evidence: k.evidence_v1.map(kind => ({ kind })), repair_date: k.v1.fields.repair_date as string | undefined, submit_date: submit },
      { today: submit, prior, currentOrderId: k.order_id });
    if (f.length) flagged.push(k.order_id);
  }
  const fl = new Set(flagged);
  const tp = [...fl].filter(id => rejectedForCause.has(id)).length;
  const fp = fl.size - tp;
  const missed = [...rejectedForCause].filter(id => !fl.has(id) && cases.some(k => k.order_id === id)).length;
  return { cases_total: cases.length, true_positives: tp, false_positives: fp, missed, precision: fl.size ? +(tp / fl.size).toFixed(3) : null, recall: tp + missed ? +(tp / (tp + missed)).toFixed(3) : null, flagged };
}
