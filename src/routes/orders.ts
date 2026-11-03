import type { FastifyInstance } from 'fastify';
import { BundleSchema } from '../ingest/schema.js';
import { ingestOrder } from '../ingest/ingest.js';
import { assertAgency, requireRole } from '../server.js';

export async function ordersRoutes(app: FastifyInstance) {
  // Importa una orden completa (PREA + historial de comentarios + transacción). Idempotente por (agency_id, order_number).
  app.post('/orders/import', async req => {
    const p = requireRole(req, 'advisor', 'reviewer', 'owner');
    const b = BundleSchema.parse(req.body);
    assertAgency(p, b.agency_id);
    return ingestOrder(p, b);
  });
}
