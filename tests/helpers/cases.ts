import { ingestOrder } from '../../src/ingest/ingest.js';
import { recordOutcome } from '../../src/outcome/service.js';
import { getPool } from '../../src/db/pool.js';

export interface CaseOpts {
  g: { groupId: string; agencyId: string };
  n: string; day: number; op?: string; rejectedFor?: string[];       // textos de comentarios de planta
  evidenceV1?: string[]; evidenceV2?: string[];
  rate?: number; partNo?: string; partPrice?: number; hours?: number;
  blind?: boolean; fields?: Record<string, any>;
}
const base = Date.UTC(2025, 3, 1);
const iso = (day: number, h = 10) => new Date(base + day * 864e5 + h * 36e5).toISOString().replace('.000Z', 'Z');
const ymd = (day: number) => iso(day, 0).slice(0, 10);

/** Crea un caso histórico completo: ingesta + resultado (aceptada tras N rondas). */
export async function makeCase(o: CaseOpts) {
  const op = o.op ?? 'OP-MT-031', hours = o.hours ?? 3.4, rate = o.rate ?? 450, part = o.partNo ?? 'PZ-MT-6120', price = o.partPrice ?? 2300;
  const rej = o.rejectedFor ?? [];
  const f1 = { vin: `VIN${o.n}`, work_op: op, labor_hours: hours, complaint_text: 'Falla reportada', part_numbers: `${part} x1`, ...(o.fields ?? {}) };
  const versions = [{ submitted_at: iso(o.day), fields: f1, text: '' }];
  if (rej.length) versions.push({ submitted_at: iso(o.day + 1), fields: { ...f1, complaint_text: 'Falla reportada (corregida)' }, text: '' });
  const T = { groupId: o.g.groupId, role: 'system' as const };
  const ing = await ingestOrder(T, {
    agency_id: o.g.agencyId, order_number: o.n, vin: f1.vin, claim_date: ymd(o.day),
    prea: { versions, comments: [
      ...rej.map((body, i) => ({ author_role: 'plant' as const, author: 'Planta', authored_at: iso(o.day, 12 + i), body })),
      { author_role: 'plant' as const, author: 'Planta', authored_at: iso(o.day + 2), body: 'Aceptada.' }] },
    evidence: [...(o.evidenceV1 ?? []).map(k => ({ kind: k, filename: `${k}-${o.n}.jpg`, version_no: 1 })), ...(o.evidenceV2 ?? []).map(k => ({ kind: k, filename: `${k}-${o.n}.jpg`, version_no: 2 }))],
    transactions: [{ tx_number: `TX-${o.n}`, claim_date: ymd(o.day), lines: [
      { concept: 'labor' as const, op_code: op, hours, rate, amount_paid: +(hours * rate).toFixed(2) },
      { concept: 'part' as const, part_no: part, quantity: 1, unit_price: price, amount_paid: price }] }],
  });
  if (o.blind) await getPool().query(`update orders set eval_split='blind' where id=$1`, [ing.orderId]);
  await recordOutcome(T, ing.orderId, { result: 'accepted', accepted_at: iso(o.day + 2), paid_by_concept: { labor: +(hours * rate).toFixed(2), parts: price } });
  return ing.orderId;
}
