import { getPool, closePool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
await seed(getPool());
console.log('seed listo');
await closePool();
