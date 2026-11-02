import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

const DIR = path.resolve(import.meta.dirname, '../../supabase/migrations');

export async function migrate(client: pg.Pool | pg.PoolClient | pg.Client): Promise<string[]> {
  await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())');
  const done = new Set((await client.query('select name from schema_migrations')).rows.map(r => r.name));
  const applied: string[] = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await client.query('begin');
    try {
      await client.query(fs.readFileSync(path.join(DIR, f), 'utf8'));
      await client.query('insert into schema_migrations(name) values ($1)', [f]);
      await client.query('commit');
      applied.push(f);
    } catch (e) { await client.query('rollback'); throw new Error(`migración ${f} falló: ${(e as Error).message}`); }
  }
  return applied;
}
