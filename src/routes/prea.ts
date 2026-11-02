import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAgency, requireRole, type Deps } from '../server.js';
import { VerifyInput, verifyDraft, ignoreFinding } from '../verify/service.js';
import { estimateClaim } from '../estimate/service.js';

const ConceptsSchema = z.object({
  operations: z.array(z.object({ op_code: z.string(), hours: z.number().optional() })).default([]),
  parts: z.array(z.object({ part_no: z.string(), quantity: z.number().positive(), unit_price: z.number().optional() })).default([]),
});
const EstimateInput = z.object({ agency_id: z.uuid(), claim_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), order_id: z.uuid().optional(), concepts: ConceptsSchema });

export async function preaRoutes(app: FastifyInstance, d: Deps) {
  app.post('/prea/verify', async req => {
    const p = requireRole(req, 'advisor', 'reviewer', 'owner');
    const body = VerifyInput.parse(req.body);
    assertAgency(p, body.agency_id);
    return verifyDraft(p, body, d.llm);
  });

  app.post('/verifications/:id/ignore', async req => {
    const p = requireRole(req, 'advisor', 'reviewer', 'owner');
    return ignoreFinding(p, (req.params as { id: string }).id, req.body);
  });

  app.post('/prea/estimate', async req => {
    const p = requireRole(req, 'advisor', 'reviewer', 'owner');
    const body = EstimateInput.parse(req.body);
    assertAgency(p, body.agency_id);
    return estimateClaim(p, body);
  });
}
