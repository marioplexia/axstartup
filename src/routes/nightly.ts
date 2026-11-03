import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, type Deps } from '../server.js';
import { runNightly } from '../nightly/run.js';

const Params = z.object({ minCasesForRule: z.number().int().min(1).optional(), minCasesForTabulator: z.number().int().min(1).optional(),
  tabulatorDeviationPct: z.number().min(0).optional(), clusterPct: z.number().min(0).optional(), minPrecision: z.number().min(0).max(1).optional() });

export async function nightlyRoutes(app: FastifyInstance, d: Deps) {
  app.post('/nightly/run', async req => {
    const p = requireRole(req, 'reviewer', 'owner');
    return runNightly(p, d.llm, Params.parse(req.body ?? {}));
  });
}
