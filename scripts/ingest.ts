// pnpm ingest --group <uuid> --file orden.json   (JSON con el formato de src/ingest/schema.ts; sin datos reales en el repo)
import fs from 'node:fs';
import { closePool } from '../src/db/pool.js';
import { ingestOrder } from '../src/ingest/ingest.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const group = arg('group'), file = arg('file');
if (!group || !file) { console.error('Uso: pnpm ingest --group <uuid> --file <orden.json>'); process.exit(1); }
console.log(JSON.stringify(await ingestOrder({ groupId: group, role: 'system' }, JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
await closePool();
