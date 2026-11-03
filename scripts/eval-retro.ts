// pnpm eval:retro --group <uuid> [--build 30] [--blind 20] [--agent] [--flag-at warning|blocker] [--detail] [--out reports]
import { closePool } from '../src/db/pool.js';
import { makeLlm } from '../src/llm/client.js';
import { runRetro, toMarkdown } from '../src/eval/retro.js';
import { CONFIG } from '../config/defaults.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const group = arg('group') ?? process.env.EVAL_GROUP_ID;
if (!group) { console.error('Falta --group <uuid> o EVAL_GROUP_ID'); process.exit(1); }
const report = await runRetro({ groupId: group, role: 'system' }, makeLlm(), {
  build: Number(arg('build') ?? CONFIG.eval.buildCases), blind: Number(arg('blind') ?? CONFIG.eval.blindCases),
  useAgent: flag('agent'), flagAt: (arg('flag-at') as 'warning' | 'blocker') ?? 'warning', detail: flag('detail'), outDir: arg('out') ?? 'reports',
});
console.log(toMarkdown(report));
await closePool();
