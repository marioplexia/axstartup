import { z } from 'zod';
import { withTenant, type Tenant } from '../db/pool.js';
import { hashRef, redact, sha } from '../redact/index.js';

const Money = z.number().min(0);
export const OutcomeInput = z.object({
  result: z.enum(['accepted', 'rejected']),
  accepted_at: z.string().optional(),
  rounds: z.number().int().min(1).optional(),          // si el asesor lo conoce; si no, se calcula de las versiones enviadas
  estimate_id: z.uuid().optional(),
  paid_by_concept: z.object({ labor: Money.default(0), parts: Money.default(0), other: Money.default(0) }).optional(),
  comments: z.array(z.object({ author_role: z.enum(['plant', 'advisor']), author: z.string(), authored_at: z.string(), body: z.string() })).default([]),
  customer_names: z.array(z.string()).default([]),
});

const r2 = (n: number) => Math.round(n * 100) / 100;
export interface ConceptError { estimated: number; paid: number; delta: number; pct: number | null }
export function compareEstimate(est: { labor: number; parts: number; total: number }, paid: { labor: number; parts: number; other: number }) {
  const total = r2(paid.labor + paid.parts + paid.other);
  const one = (e: number, p: number): ConceptError => ({ estimated: e, paid: p, delta: r2(e - p), pct: p === 0 ? null : r2(((e - p) / p) * 100) });
  return { labor: one(est.labor, paid.labor), parts: one(est.parts, paid.parts), total: one(est.total, total) };
}

/** :id es el id de la orden (una PREA por orden). */
export async function recordOutcome(tenant: Tenant, orderId: string, raw: unknown) {
  const o = OutcomeInput.parse(raw);
  return withTenant(tenant, async c => {
    const ord = await c.query('select id, agency_id from orders where id=$1', [orderId]);
    if (!ord.rowCount) throw Object.assign(new Error('orden no encontrada'), { statusCode: 404 });
    const agencyId = ord.rows[0].agency_id;
    if (tenant.role === 'advisor' && (tenant as any).agencyId && (tenant as any).agencyId !== agencyId) throw Object.assign(new Error('agencia no autorizada'), { statusCode: 403 });

    // comentarios del hilo (dedupe por contenido, redactados)
    let newComments = 0;
    for (const m of o.comments) {
      const body = redact(m.body, { knownNames: [...o.customer_names, m.author] }).text;
      const r = await c.query(
        `insert into prea_comments(group_id,order_id,author_role,author_ref,authored_at,body_redacted,content_hash)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (order_id,content_hash) do nothing`,
        [tenant.groupId, orderId, m.author_role, hashRef(m.author), m.authored_at, body, sha([m.author_role, new Date(m.authored_at).toISOString(), body].join('|'))]);
      newComments += r.rowCount ?? 0;
    }

    const v = (await c.query(`select count(*)::int n, (array_agg(submitted_at order by version_no))[1] first_at from prea_versions where order_id=$1`, [orderId])).rows[0];
    const rounds = o.rounds ?? Math.max(1, v.n);
    const firstAt: Date | null = v.first_at;
    let days: number | null = null;
    if (o.result === 'accepted' && o.accepted_at && firstAt) days = r2((Date.parse(o.accepted_at) - firstAt.getTime()) / 864e5);

    // pagado por concepto: lo informado por el asesor, o lo que dicen las transacciones de la orden
    let paid = o.paid_by_concept;
    if (!paid) {
      const t = await c.query(`select l.concept, sum(l.amount_paid)::float s from transaction_lines l join transactions t on t.id=l.transaction_id where t.order_id=$1 group by 1`, [orderId]);
      const m = Object.fromEntries(t.rows.map(x => [x.concept, x.s]));
      paid = { labor: m.labor ?? 0, parts: m.part ?? 0, other: m.other ?? 0 };
    }
    const totalPaid = r2(paid.labor + paid.parts + paid.other);

    const est = o.estimate_id
      ? await c.query('select id,total,breakdown from estimates where id=$1 and (order_id=$2 or order_id is null)', [o.estimate_id, orderId])
      : await c.query('select id,total,breakdown from estimates where order_id=$1 order by created_at desc limit 1', [orderId]);
    let error = null, estimateId: string | null = null;
    if (est.rowCount) {
      estimateId = est.rows[0].id;
      const s = est.rows[0].breakdown.subtotals;
      error = compareEstimate({ labor: s.labor, parts: s.parts, total: Number(est.rows[0].total) }, paid);
    }

    const ins = await c.query(
      `insert into outcomes(group_id,agency_id,order_id,estimate_id,result,rounds,first_submitted_at,accepted_at,days_to_acceptance,paid_by_concept,total_paid,estimate_error,recorded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (order_id) do update set estimate_id=excluded.estimate_id, result=excluded.result, rounds=excluded.rounds, first_submitted_at=excluded.first_submitted_at,
         accepted_at=excluded.accepted_at, days_to_acceptance=excluded.days_to_acceptance, paid_by_concept=excluded.paid_by_concept, total_paid=excluded.total_paid,
         estimate_error=excluded.estimate_error, recorded_by=excluded.recorded_by
       returning id`,
      [tenant.groupId, agencyId, orderId, estimateId, o.result, rounds, firstAt, o.accepted_at ?? null, days, JSON.stringify(paid), totalPaid, error ? JSON.stringify(error) : null, tenant.userId ?? null]);

    await c.query(`insert into audit_log(group_id,actor_id,actor_role,action,entity,entity_id,data) values ($1,$2,$3,'outcome.recorded','orders',$4,$5)`,
      [tenant.groupId, tenant.userId ?? null, tenant.role ?? null, orderId, JSON.stringify({ result: o.result, rounds, total_paid: totalPaid })]);
    const ev = (type: string, action: string, payload: object) =>
      c.query(`insert into events(group_id,agency_id,type,action,payload) values ($1,$2,$3,$4,$5)`, [tenant.groupId, agencyId, type, action, JSON.stringify(payload)]);
    await ev('prea', o.result, { order_id: orderId, rounds });
    if (newComments) await ev('comment', 'added', { order_id: orderId, count: newComments });
    await ev('payment', 'recorded', { order_id: orderId, total_paid: totalPaid });

    return { id: ins.rows[0].id, result: o.result, rounds, days_to_acceptance: days, total_paid: totalPaid, paid_by_concept: paid, estimate_error: error };
  });
}
