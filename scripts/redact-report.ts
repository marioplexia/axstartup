import fs from 'node:fs';
import path from 'node:path';
import { buildReport, formatReport } from '../src/redact/report.js';

// pnpm redact:report <archivo.txt|.json> [--names "Ana Ruiz,Luis Soto"] [--out reports/redact.md]
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!file) { console.error('uso: pnpm redact:report <archivo.txt|.json> [--names "A,B"] [--out reports/x.md]'); process.exit(2); }

const raw = fs.readFileSync(file, 'utf8');
const rep = buildReport(raw, file.endsWith('.json') ? 'json' : 'text', (flag('names') ?? '').split(',').map(s => s.trim()).filter(Boolean));
const md = formatReport(rep, path.basename(file));
const out = flag('out');
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, md); console.error(`reporte guardado en ${out}`); } else console.log(md);
process.exit(rep.residual.length ? 1 : 0);
