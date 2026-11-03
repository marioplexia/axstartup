import type { FastifyInstance } from 'fastify';
import { requireRole } from '../server.js';
import { withTenant } from '../db/pool.js';
import { EventHub } from '../events/hub.js';

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 25000);
const CATCHUP_MS = Number(process.env.SSE_CATCHUP_MS ?? 15000);   // red de seguridad si se pierde un NOTIFY

export async function eventsRoutes(app: FastifyInstance) {
  const hub = new EventHub();
  app.addHook('onClose', async () => { await hub.close(); });

  app.get('/events/stream', async (req, reply) => {
    const p = requireRole(req, 'advisor', 'reviewer', 'owner');
    const q = req.query as { since?: string };
    const header = Number(req.headers['last-event-id']);
    // Sin cursor: solo eventos nuevos desde ahora.
    let last = Number.isFinite(header) && header > 0 ? header : q.since !== undefined ? Number(q.since) || 0
      : Number((await withTenant(p, async c => (await c.query('select coalesce(max(id),0) m from events')).rows[0].m)));

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n: conectado\n\n');

    let busy = false, again = false, closed = false;
    const flush = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          const rows = await withTenant(p, async c => (await c.query(
            `select id, type, action, agency_id, payload, created_at from events
              where id > $1 and ($2::uuid is null or agency_id is null or agency_id = $2::uuid) order by id limit 200`, [last, p.role === 'advisor' ? p.agencyId ?? null : null])).rows);
          for (const r of rows) {
            if (closed) return;
            res.write(`id: ${r.id}\nevent: ${r.type}\ndata: ${JSON.stringify({ id: Number(r.id), type: r.type, action: r.action, agency_id: r.agency_id, payload: r.payload, created_at: r.created_at })}\n\n`);
            last = Number(r.id);
          }
          if (rows.length === 200) again = true;
        } while (again && !closed);
      } catch { /* la conexión se cerrará y el cliente reintenta con Last-Event-ID */ }
      finally { busy = false; }
    };

    const unsub = await hub.subscribe(p.groupId, () => { void flush(); });
    const hb = setInterval(() => res.write(': latido\n\n'), HEARTBEAT_MS);
    const cu = setInterval(() => { void flush(); }, CATCHUP_MS);
    const cleanup = () => { closed = true; clearInterval(hb); clearInterval(cu); unsub(); };
    req.raw.on('close', cleanup);
    await flush();   // reproduce lo pendiente si el cliente trae Last-Event-ID
  });
}
