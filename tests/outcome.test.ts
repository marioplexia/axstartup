import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { signDevToken } from '../src/auth.js';
import { closePool, getPool } from '../src/db/pool.js';
import { makeGroup, addTab } from './helpers/tenant.js';
import { ingestOrder } from '../src/ingest/ingest.js';
import { compareEstimate } from '../src/outcome/service.js';
import { computeMetrics } from '../src/metrics/compute.js';
import { fullOrder } from './fixtures/orders.js';

afterAll(closePool);

describe('compareEstimate', () => {
  it('calcula delta en pesos y porcentaje por concepto', () => {
    const c = compareEstimate({ labor: 1428, parts: 3750, total: 5178 }, { labor: 1260, parts: 3750, other: 0 });
    expect(c.labor).toEqual({ estimated: 1428, paid: 1260, delta: 168, pct: 13.33 });
    expect(c.parts.delta).toBe(0);
    expect(c.total).toMatchObject({ paid: 5010, delta: 168 });
  });
  it('pct nulo cuando se pagó 0', () => expect(compareEstimate({ labor: 0, parts: 10, total: 10 }, { labor: 0, parts: 0, other: 0 }).parts.pct).toBeNull());
});

describe('computeMetrics', () => {
  const base = { agency_id: 'a', estimate_error: null, complete_same_day: false, llm_cost_usd: 0.02, llm_tokens: 1000 };
  it('agrega tasas y promedios', () => {
    const m = computeMetrics([
      { ...base, order_id: '1', result: 'accepted', rounds: 1, days_to_acceptance: 2, complete_same_day: true },
      { ...base, order_id: '2', result: 'accepted', rounds: 3, days_to_acceptance: 10 },
      { ...base, order_id: '3', result: 'rejected', rounds: 1, days_to_acceptance: null },
      { ...base, order_id: '4', result: 'accepted', rounds: 2, days_to_acceptance: 6 },
    ]);
    expect(m.first_pass_rejection_rate).toBe(0.75);
    expect(m.avg_rounds_to_acceptance).toBe(2);
    expect(m.avg_days_to_acceptance).toBe(6);
    expect(m.same_day_complete_capture_rate).toBe(0.25);
    expect(m.llm_cost_per_prea_usd).toBe(0.02);
  });
  it('sin datos devuelve nulos, no ceros inventados', () => expect(computeMetrics([]).first_pass_rejection_rate).toBeNull());
});

describe('POST /prea/:id/outcome y GET /metrics', () => {
  it('registra resultado, calcula rondas/días, compara estimado vs pagado y alimenta métricas', async () => {
    const g = await makeGroup('OUT');
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 420 });
    await addTab(g, { key: 'std_time:OP-MT-031', kind: 'standard_time', subject: 'OP-MT-031', value: 3.4, unit: 'h' });
    await addTab(g, { key: 'part_price:PZ-MT-6120', kind: 'part_price', subject: 'PZ-MT-6120', value: 2140 });
    const T = { groupId: g.groupId, role: 'system' as const };
    const ing = await ingestOrder(T, { ...fullOrder('ORD-OUT-1'), agency_id: g.agencyId });
    const app = await buildServer();
    const adv = { authorization: `Bearer ${await signDevToken({ userId: g.advisorId, groupId: g.groupId, role: 'advisor', agencyId: g.agencyId })}` };
    const rev = { authorization: `Bearer ${await signDevToken({ userId: g.reviewerId, groupId: g.groupId, role: 'reviewer' })}` };

    await app.inject({ method: 'POST', url: '/prea/estimate', headers: adv, payload: { agency_id: g.agencyId, order_id: ing.orderId, claim_date: '2025-03-10', concepts: { operations: [{ op_code: 'OP-MT-031' }], parts: [{ part_no: 'PZ-MT-6120', quantity: 1 }] } } });

    const res = await app.inject({ method: 'POST', url: `/prea/${ing.orderId}/outcome`, headers: adv, payload: {
      result: 'accepted', accepted_at: '2025-03-20T12:00:00Z',
      paid_by_concept: { labor: 1260, parts: 2140 },
      comments: [{ author_role: 'plant', author: 'Revisor Planta 9', authored_at: '2025-03-19T10:00:00Z', body: 'Aceptada. Pago ajustado en mano de obra.' }],
    } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.rounds).toBe(2);                      // 2 versiones enviadas
    expect(b.days_to_acceptance).toBe(10.08);      // 10 d 2 h desde la v1 (2025-03-10T10:00Z)
    expect(b.total_paid).toBe(3400);
    expect(b.estimate_error.labor).toMatchObject({ estimated: 1428, paid: 1260, delta: 168 });
    expect(b.estimate_error.total.delta).toBe(168);

    // idempotente: segunda llamada actualiza, no duplica
    expect((await app.inject({ method: 'POST', url: `/prea/${ing.orderId}/outcome`, headers: adv, payload: { result: 'accepted', accepted_at: '2025-03-20T12:00:00Z', paid_by_concept: { labor: 1260, parts: 2140 } } })).statusCode).toBe(200);
    expect((await getPool().query('select count(*)::int n from outcomes where group_id=$1', [g.groupId])).rows[0].n).toBe(1);

    const m = (await app.inject({ method: 'GET', url: '/metrics', headers: rev })).json();
    expect(m.brand.prea_count).toBe(1);
    expect(m.brand.first_pass_rejection_rate).toBe(1);
    expect(m.brand.estimate_error.labor.mae_pesos).toBe(168);
    expect(m.brand.estimate_error.labor.mape_pct).toBe(13.33);
    expect(m.agencies).toHaveLength(1);

    const advM = (await app.inject({ method: 'GET', url: '/metrics', headers: adv })).json();
    expect(advM.brand).toBeUndefined();
    expect(advM.agencies[0].prea_count).toBe(1);
  });

  it('sin pagado explícito toma las transacciones de la orden; orden inexistente da 404', async () => {
    const g = await makeGroup('OUT2');
    const ing = await ingestOrder({ groupId: g.groupId, role: 'system' }, { ...fullOrder('ORD-OUT-2'), agency_id: g.agencyId });
    const app = await buildServer();
    const h = { authorization: `Bearer ${await signDevToken({ userId: g.advisorId, groupId: g.groupId, role: 'advisor', agencyId: g.agencyId })}` };
    const r = await app.inject({ method: 'POST', url: `/prea/${ing.orderId}/outcome`, headers: h, payload: { result: 'rejected' } });
    expect(r.json().total_paid).toBe(3568);
    const nf = await app.inject({ method: 'POST', url: `/prea/00000000-0000-4000-8000-0000000000ff/outcome`, headers: h, payload: { result: 'rejected' } });
    expect(nf.statusCode).toBe(404);
  });
});
