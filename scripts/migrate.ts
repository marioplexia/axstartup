import { getPool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
const applied = await migrate(getPool());
console.log(applied.length ? `aplicadas: ${applied.join(', ')}` : 'sin migraciones pendientes');
await closePool();
