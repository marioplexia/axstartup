import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../server.js';
import { approve, discard, list, revert, type Table } from '../rules/service.js';

const Q = z.object({ status: z.enum(['candidate', 'approved', 'active', 'discarded', 'retired']).optional(), key: z.string().optional() });

export async function rulesRoutes(app: FastifyInstance) {
  for (const [path, table] of [['rules', 'rules'], ['tabulators', 'tabulators']] as Array<[string, Table]>) {
    app.get(`/${path}`, async req => {
      const p = requireRole(req, 'advisor', 'reviewer', 'owner');
      return list(p, table, Q.parse(req.query));
    });
    // Solo el rol reviewer decide. (El trigger de la base lo vuelve a exigir.)
    app.post(`/${path}/:id/approve`, async req => approve(requireRole(req, 'reviewer'), table, (req.params as any).id, req.body ?? {}));
    app.post(`/${path}/:id/discard`, async req => discard(requireRole(req, 'reviewer'), table, (req.params as any).id, req.body));
    app.post(`/${path}/:id/revert`, async req => revert(requireRole(req, 'reviewer'), table, (req.params as any).id, req.body ?? {}));
  }
}
