import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { signDevToken } from '../src/auth.js';
import { closePool, getPool, withTenant } from '../src/db/pool.js';
import { makeGroup } from './helpers/tenant.js';
import { ingestOrder } from '../src/ingest/ingest.js';
import { fullOrder } from './fixtures/orders.js';

const apps: FastifyInstance[] = [];
afterAll(async () => { for (const a of apps) await a.close(); await closePool(); });

async function start() {
  const app = await buildServer(); apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, base: `http://127.0.0.1:${(app.server.address() as any).port}` };
}

/** Lee el stream hasta juntar `n` eventos o vencer el plazo. */
async function readEvents(url: string, headers: Record<string, string>, n: number, trigger: () => Promise<void>, ms = 4000) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader(); const dec = new TextDecoder();
  let buf = ''; const events: any[] = [];
  const timer = setTimeout(() => ac.abort(), ms);
  await new Promise(r => setTimeout(r, 150));   // la suscripción ya está lista cuando llegan los headers; margen extra
  await trigger();
  try {
    while (events.length < n) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const d = block.split('\n').find(l => l.startsWith('data: '));
        if (d) events.push(JSON.parse(d.slice(6)));
      }
    }
  } catch { /* abortado por plazo */ }
  clearTimeout(timer); ac.abort();
  return events;
}

describe('GET /events/stream (SSE)', () => {
  it('exige autenticación', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/events/stream`)).status).toBe(401);
    expect((await fetch(`${base}/events/stream?access_token=basura`)).status).toBe(401);
  });

  it('emite eventos de PREA, comentarios y pagos en tiempo real, solo del grupo del usuario', async () => {
    const { base } = await start();
    const g = await makeGroup('SSE'); const other = await makeGroup('SSE2');
    const tok = await signDevToken({ userId: g.reviewerId, groupId: g.groupId, role: 'reviewer' });
    const ev = await readEvents(`${base}/events/stream?access_token=${tok}`, {}, 1, async () => {
      // evento de otro grupo: no debe llegar
      await withTenant({ groupId: other.groupId, role: 'system' }, c => c.query(`insert into events(group_id,type,action) values ($1,'prea','ajeno')`, [other.groupId]));
      await ingestOrder({ groupId: g.groupId, role: 'system' }, { ...fullOrder('ORD-SSE-1'), agency_id: g.agencyId });
    });
    expect(ev.map(e => [e.type, e.action])).toEqual([['prea', 'ingested']]);
    expect(ev[0].payload.order_number).toBe('ORD-SSE-1');
  });

  it('un asesor solo recibe eventos de su agencia', async () => {
    const { base } = await start();
    const g = await makeGroup('SSE3');
    const other = (await getPool().query(`insert into agencies(group_id,brand_id,name,city) values ($1,$2,'Otra','Y') returning id`, [g.groupId, g.brandId])).rows[0].id;
    const tok = await signDevToken({ userId: g.advisorId, groupId: g.groupId, role: 'advisor', agencyId: g.agencyId });
    const ev = await readEvents(`${base}/events/stream`, { authorization: `Bearer ${tok}` }, 1, async () => {
      await withTenant({ groupId: g.groupId, role: 'system' }, async c => {
        await c.query(`insert into events(group_id,agency_id,type,action) values ($1,$2,'comment','otra_agencia')`, [g.groupId, other]);
        await c.query(`insert into events(group_id,agency_id,type,action) values ($1,$2,'payment','propia')`, [g.groupId, g.agencyId]);
      });
    });
    expect(ev.map(e => e.action)).toEqual(['propia']);
  });

  it('reproduce lo perdido con Last-Event-ID', async () => {
    const { base } = await start();
    const g = await makeGroup('SSE4');
    const ids = await withTenant({ groupId: g.groupId, role: 'system' }, async c => {
      const out: number[] = [];
      for (const a of ['uno', 'dos', 'tres']) out.push(Number((await c.query(`insert into events(group_id,type,action) values ($1,'rule',$2) returning id`, [g.groupId, a])).rows[0].id));
      return out;
    });
    const tok = await signDevToken({ userId: g.reviewerId, groupId: g.groupId, role: 'reviewer' });
    const ev = await readEvents(`${base}/events/stream`, { authorization: `Bearer ${tok}`, 'last-event-id': String(ids[0]) }, 2, async () => {});
    expect(ev.map(e => e.action)).toEqual(['dos', 'tres']);
  });
});
