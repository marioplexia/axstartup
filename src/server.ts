import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { verifyToken, type Principal } from './auth.js';
import type { Role } from './db/pool.js';
import { makeLlm, type LlmClient } from './llm/client.js';
import { preaRoutes } from './routes/prea.js';
import { outcomeRoutes } from './routes/outcome.js';
import { nightlyRoutes } from './routes/nightly.js';
import { rulesRoutes } from './routes/rules.js';
import { eventsRoutes } from './routes/events.js';

declare module 'fastify' { interface FastifyRequest { principal?: Principal } }

export interface Deps { llm: LlmClient }

export function requireRole(req: FastifyRequest, ...roles: Role[]) {
  if (!req.principal || !roles.includes(req.principal.role)) throw Object.assign(new Error('rol no autorizado'), { statusCode: 403 });
  return req.principal;
}
/** Un asesor solo opera sobre su propia agencia. */
export function assertAgency(p: Principal, agencyId: string) {
  if (p.role === 'advisor' && p.agencyId !== agencyId) throw Object.assign(new Error('agencia no autorizada'), { statusCode: 403 });
}

export async function buildServer(deps: Partial<Deps> = {}): Promise<FastifyInstance> {
  const d: Deps = { llm: deps.llm ?? makeLlm() };
  // El logger solo registra método, ruta y estado: nunca cuerpos ni cabeceras (datos personales).
  const app = Fastify({ forceCloseConnections: true, logger: process.env.NODE_ENV === 'test' || process.env.VITEST ? false : { level: 'info', serializers: {
    req: r => ({ method: r.method, url: r.url?.split('?')[0] }), res: r => ({ statusCode: r.statusCode }) } } });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    let token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    // EventSource no permite cabeceras: solo para el stream se acepta ?access_token= (el logger no registra la query).
    if (!token && req.url.startsWith('/events/stream')) token = (req.query as { access_token?: string }).access_token;
    if (!token) return reply.code(401).send({ error: 'no autenticado' });
    try { req.principal = await verifyToken(token); } catch { return reply.code(401).send({ error: 'token inválido' }); }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'datos inválidos', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err.code === '42501') return reply.code(403).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error({ msg: 'error interno', code: err.code });
    return reply.code(500).send({ error: 'error interno' });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(async i => preaRoutes(i, d));
  await app.register(async i => outcomeRoutes(i));
  await app.register(async i => nightlyRoutes(i, d));
  await app.register(async i => rulesRoutes(i));
  await app.register(async i => eventsRoutes(i));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
