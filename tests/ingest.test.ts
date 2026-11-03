import { describe, it, expect, afterAll } from 'vitest';
import { withTenant, closePool } from '../src/db/pool.js';
import { IDS } from '../src/db/seedData.js';
import { ingestOrder, reconstructFirst } from '../src/ingest/ingest.js';
import { fullOrder, AG } from './fixtures/orders.js';

afterAll(closePool);
const T = { groupId: IDS.group, role: 'system' as const };
const q = <R = any>(sql: string, p: unknown[] = []) => withTenant(T, async c => (await c.query(sql, p)).rows as R[]);

describe('ingesta', () => {
  it('importa orden completa, redacta PII y es idempotente', async () => {
    const r1 = await ingestOrder(T, fullOrder());
    expect(r1).toMatchObject({ orderCreated: true, versions: { inserted: 2 }, comments: { inserted: 2 }, transactions: { inserted: 1 }, needsReview: false });
    const r2 = await ingestOrder(T, fullOrder());
    expect(r2).toMatchObject({ orderCreated: false, versions: { inserted: 0, skipped: 2 }, comments: { inserted: 0 }, transactions: { inserted: 0, skipped: 1 } });
    const dump = JSON.stringify(await q(`select fields, text_redacted from prea_versions`)) + JSON.stringify(await q(`select body_redacted, author_ref from prea_comments`));
    expect(dump).not.toMatch(/Juan|Pérez|443 123|correo\.example|Lucía|Revisor Planta/);
    expect(dump).toContain('[NOMBRE]');
    const pl = await q(`select count(*)::int n from prea_comments`);
    expect(pl[0].n).toBe(2);
  });

  it('registra la ingesta en audit_log y emite evento (solo cuando hay cambios)', async () => {
    const a = await q(`select count(*)::int n from audit_log where action='order.ingest'`);
    expect(a[0].n).toBe(1);
    const e = await q(`select count(*)::int n from events where type='prea' and action='ingested'`);
    expect(e[0].n).toBe(1);
  });

  it('reconstruye la primera versión desde el historial', async () => {
    const o = {
      agency_id: AG, order_number: 'ORD-2001',
      prea: {
        first_submitted_at: '2025-04-01T10:00:00Z',
        current: { fields: { work_op: 'OP-MT-031', labor_hours: 3.4, cause_code: 'MT-518' } },
        field_history: [
          { at: '2025-04-03T10:00:00Z', field: 'cause_code', from: null, to: 'MT-518' },
          { at: '2025-04-04T10:00:00Z', field: 'labor_hours', from: 2.0, to: 3.4 },
        ],
        comments: [],
      },
      transactions: [{ tx_number: 'TX-1', lines: [{ concept: 'labor', amount_paid: 100 }] }],
    };
    const r = await ingestOrder(T, o);
    expect(r.needsReview).toBe(false);
    const v = await q(`select version_no, source, fields from prea_versions where order_id=$1 order by version_no`, [r.orderId]);
    expect(v.map(x => x.source)).toEqual(['reconstructed', 'submitted']);
    expect(v[0].fields).toMatchObject({ labor_hours: 2, cause_code: null });
  });

  it('si no hay forma de reconstruir, lo marca en el caso y no lo adivina', async () => {
    const r = await ingestOrder(T, {
      agency_id: AG, order_number: 'ORD-2002',
      prea: { current: { fields: { work_op: 'OP-MT-031' } }, comments: [] },
      transactions: [{ tx_number: 'TX-1', lines: [{ concept: 'labor', amount_paid: 100 }] }],
    });
    expect(r.anomalies).toContain('missing_first_version');
    expect(r.needsReview).toBe(true);
    const o = await q(`select ingest_status from orders where id=$1`, [r.orderId]);
    expect(o[0].ingest_status).toBe('needs_review');
  });

  it('historial inconsistente => missing_first_version (no se inventa)', () => {
    const r = reconstructFirst({ a: 1 }, [{ at: '2025-01-02T00:00:00Z', field: 'a', from: 0, to: 9 }], '2025-01-01T00:00:00Z');
    expect(r.ok).toBe(false);
  });

  it('orden sin PREA o sin transacción queda registrada', async () => {
    const a = await ingestOrder(T, { agency_id: AG, order_number: 'ORD-3001', transactions: [{ tx_number: 'T', lines: [{ concept: 'part', amount_paid: 5 }] }] });
    expect(a.anomalies).toContain('missing_prea');
    const b = await ingestOrder(T, { agency_id: AG, order_number: 'ORD-3002', prea: { current: { fields: { x: 1 } }, first_submitted_at: '2025-01-01T00:00:00Z', field_history: [], comments: [] } });
    expect(b.anomalies).toContain('missing_transaction');
    expect(b.needsReview).toBe(true);
  });

  it('duplicados y ajustes posteriores se registran sin elegir uno', async () => {
    const base = fullOrder('ORD-4001');
    const dupPrea = { ...base, prea: { ...base.prea, versions: [base.prea.versions[0], { ...base.prea.versions[0], submitted_at: '2025-03-11T10:00:00Z' }] } };
    const r1 = await ingestOrder(T, dupPrea);
    expect(r1.anomalies).toContain('duplicate_prea');
    expect(r1.versions.inserted).toBe(1);

    const adj = { ...fullOrder('ORD-4002'), transactions: [
      ...fullOrder().transactions,
      { tx_number: 'TX-2', is_adjustment: true, lines: [{ concept: 'labor' as const, amount_paid: -200 }] }] };
    const r2 = await ingestOrder(T, adj);
    expect(r2.anomalies).toContain('later_adjustment');
    expect(r2.transactions.inserted).toBe(2);
    expect(r2.needsReview).toBe(true);
  });

  it('reingesta con cifras distintas no sobrescribe y marca conflicto', async () => {
    const o = fullOrder('ORD-5001');
    await ingestOrder(T, o);
    const changed = { ...o, transactions: [{ ...o.transactions[0], lines: [{ concept: 'labor' as const, amount_paid: 1 }] }] };
    const r = await ingestOrder(T, changed);
    expect(r.anomalies).toContain('conflicting_reingest');
    const t = await q(`select total_paid from transactions t join orders o on o.id=t.order_id where o.order_number='ORD-5001'`);
    expect(Number(t[0].total_paid)).toBe(3568);
  });

  it('valida el esquema de entrada', async () => {
    await expect(ingestOrder(T, { order_number: '' })).rejects.toThrow();
  });
});

describe('POST /orders/import', () => {
  it('importa por API, exige auth y limita al asesor a su agencia', async () => {
    const { buildServer } = await import('../src/server.js');
    const { signDevToken } = await import('../src/auth.js');
    const app = await buildServer();
    const adv = await signDevToken({ userId: IDS.advisor(0), groupId: IDS.group, role: 'advisor', agencyId: AG });
    expect((await app.inject({ method: 'POST', url: '/orders/import', payload: fullOrder('ORD-API-1') })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/orders/import', headers: { authorization: `Bearer ${adv}` }, payload: fullOrder('ORD-API-1') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().orderCreated).toBe(true);
    const otherAgency = await app.inject({ method: 'POST', url: '/orders/import', headers: { authorization: `Bearer ${adv}` }, payload: { ...fullOrder('ORD-API-2'), agency_id: IDS.agencies[1][0] } });
    expect(otherAgency.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/orders/import', headers: { authorization: `Bearer ${adv}` }, payload: { order_number: '' } })).statusCode).toBe(400);
  });
});
