// Corte nocturno programable. Ejemplo de cron (2:30 am):  30 2 * * *  cd /app && pnpm nightly --group <uuid> --min-cases 3
import { closePool } from '../src/db/pool.js';
import { makeLlm } from '../src/llm/client.js';
import { runNightly } from '../src/nightly/run.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const group = arg('group') ?? process.env.NIGHTLY_GROUP_ID;
if (!group) { console.error('Falta --group <uuid> o NIGHTLY_GROUP_ID'); process.exit(1); }
const num = (n: string) => (arg(n) !== undefined ? Number(arg(n)) : undefined);
const res = await runNightly({ groupId: group, role: 'system' }, makeLlm(), {
  minCasesForRule: num('min-cases'), minCasesForTabulator: num('min-payments'), tabulatorDeviationPct: num('deviation-pct'),
});
console.log(JSON.stringify(res, null, 2));
await closePool();
