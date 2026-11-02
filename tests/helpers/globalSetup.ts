import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://axai:axai@localhost:5432/axai_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await migrate(c);
  await seed(c);
  await c.end();
}
