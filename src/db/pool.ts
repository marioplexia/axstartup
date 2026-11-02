import pg from 'pg';

export type Role = 'advisor' | 'reviewer' | 'owner';
export interface Tenant { groupId: string; userId?: string; role?: Role | 'system' }

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  return pool;
}
export async function closePool() { await pool?.end(); pool = undefined; }

/** Ejecuta fn dentro de una transacción como axai_app con RLS fijada al grupo. */
export async function withTenant<T>(t: Tenant, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('begin');
    await c.query('set local role axai_app');
    await c.query(`select set_config('app.group_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)`,
      [t.groupId, t.userId ?? '', t.role ?? '']);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}
