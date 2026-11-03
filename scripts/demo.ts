// pnpm demo — recorrido completo con una orden ficticia. Usa DEMO_DATABASE_URL / DATABASE_URL; si no hay, Postgres local "axai_demo".
process.env.DATABASE_URL = process.env.DEMO_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://axai:axai@localhost:5432/axai_demo';
process.env.NODE_ENV = 'development'; // el demo firma tokens de desarrollo
process.env.JWT_SECRET ??= 'demo-secret-no-usar-en-produccion';
process.env.LLM_MODE ??= 'mock';
process.env.LOG_LEVEL ??= 'silent';

const { ensureDatabase, runDemo } = await import('../src/demo/run.js');
const { getPool, closePool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');

await ensureDatabase(process.env.DATABASE_URL);
await migrate(getPool());
console.log(`Demo con datos ficticios · agentes ${process.env.LLM_MODE === 'live' ? 'REALES (API)' : 'simulados (mock)'}`);
const r = await runDemo();
console.log(`\n✔ Demo terminada. Hallazgos antes: ${r.before.length} → después: ${r.after.length}.`);
await closePool();
