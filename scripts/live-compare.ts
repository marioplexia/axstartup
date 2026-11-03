// pnpm live:compare [--dry] [--out reports]
// Corre 5 casos FICTICIOS con el agente simulado y con la API real y reporta diferencias y costo por PREA.
// Requiere ANTHROPIC_API_KEY, LLM_PRICE_IN y LLM_PRICE_OUT (USD por millón de tokens) en el entorno. --dry omite la API.
import fs from 'node:fs';
import path from 'node:path';
import { LiveClient, MockClient } from '../src/llm/client.js';
import { compareAgents, reportToMarkdown } from '../src/eval/livecompare.js';
import { LIVE_CASES } from '../tests/fixtures/live-cases.js';
import { CONFIG, pricesConfigured } from '../config/defaults.js';

const dry = process.argv.includes('--dry');
const oi = process.argv.indexOf('--out'); const outDir = oi > 0 ? process.argv[oi + 1] : 'reports';
if (!dry) {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('Falta ANTHROPIC_API_KEY (o usa --dry).'); process.exit(1); }
  if (!pricesConfigured()) console.error('AVISO: LLM_PRICE_IN / LLM_PRICE_OUT sin definir; el costo saldrá como n/d.');
}
const report = await compareAgents(LIVE_CASES, new MockClient(), dry ? null : new LiveClient(), dry ? 'mock (dry)' : CONFIG.llm.model);
const md = reportToMarkdown(report);
fs.mkdirSync(outDir, { recursive: true });
const stamp = report.generated_at.replace(/[:.]/g, '-');
fs.writeFileSync(path.join(outDir, `live-compare-${stamp}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(outDir, `live-compare-${stamp}.md`), md);
console.log(md);
