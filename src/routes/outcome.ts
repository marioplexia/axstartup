import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../server.js';
import { recordOutcome } from '../outcome/service.js';
import { getMetrics } from '../metrics/service.js';

const Q = z.object({ from: z.string().optional(), to: z.string().optional(), agency_id: z.uuid().optional() });

export async function outcomeRoutes(app: FastifyInstance) {
  app.post('/prea/:id/outcome', async req => {
    const p = requireRole(req, 'advisor', 'reviewer', 'owner');
    return recordOutcome(p, (req.params as { id: string }).id, req.body);
  });
  app.get('/metrics', async req => {
    const p = requireRole(req, 'advisor', 'reviewer', 'owner');
    const q = Q.parse(req.query);
    return getMetrics(p, { from: q.from, to: q.to, agencyId: q.agency_id });
  });
}
