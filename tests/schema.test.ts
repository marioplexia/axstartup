import { describe, it, expect, afterAll } from 'vitest';
import { getPool, withTenant, closePool } from '../src/db/pool.js';
import { IDS } from '../src/db/seedData.js';

afterAll(closePool);
const G = IDS.group;

async function otherGroup() {
  const r = await getPool().query(`insert into groups(name) values ('Otro grupo') returning id`);
  const gid = r.rows[0].id as string;
  const b = await getPool().query(`insert into brands(group_id,name,code) values ($1,'Ford','FD') returning id`, [gid]);
  return { gid, brand: b.rows[0].id as string };
}

describe('seed', () => {
  it('carga GM y las 5 agencias de FAME, una de ellas Apatzingán', async () => {
    const r = await withTenant({ groupId: G, role: 'owner' }, c => c.query('select name from agencies order by name'));
    expect(r.rows).toHaveLength(5);
    expect(r.rows.map(x => x.name)).toContain('FAME Apatzingán');
    const b = await withTenant({ groupId: G }, c => c.query('select code from brands'));
    expect(b.rows).toEqual([{ code: 'GM' }]);
  });
  it('es idempotente', async () => {
    const { seed } = await import('../src/db/seed.js');
    await seed(getPool());
    const r = await withTenant({ groupId: G }, c => c.query('select count(*)::int n from agencies'));
    expect(r.rows[0].n).toBe(5);
  });
  it('siembra reglas del formulario (14) y tabuladores activos', async () => {
    const r = await withTenant({ groupId: G }, c => c.query(`select count(*)::int n from rules where origin='form' and status='active'`));
    expect(r.rows[0].n).toBe(14);
    const t = await withTenant({ groupId: G }, c => c.query(`select value from tabulators where kind='labor_rate' and status='active'`));
    expect(Number(t.rows[0].value)).toBe(420);
  });
});

describe('RLS', () => {
  it('un grupo no ve datos de otro', async () => {
    const o = await otherGroup();
    const seen = await withTenant({ groupId: o.gid }, c => c.query('select * from agencies'));
    expect(seen.rows).toHaveLength(0);
    const brands = await withTenant({ groupId: o.gid }, c => c.query('select code from brands'));
    expect(brands.rows).toEqual([{ code: 'FD' }]);
  });
  it('sin group_id no se ve nada', async () => {
    const r = await withTenant({ groupId: '' }, c => c.query('select * from orders')).catch(() => ({ rows: [] }));
    expect(r.rows).toHaveLength(0);
  });
  it('no se puede insertar en otro grupo', async () => {
    const o = await otherGroup();
    await expect(withTenant({ groupId: G }, c =>
      c.query(`insert into brands(group_id,name,code) values ($1,'X','XX')`, [o.gid]))).rejects.toThrow();
  });
});

describe('reglas: solo reviewer cambia estado', () => {
  async function newCandidate(role: 'advisor' | 'reviewer') {
    return withTenant({ groupId: G, role, userId: IDS.reviewer }, async c => {
      const r = await c.query(
        `insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,condition,origin)
         values ($1,$2,$3,1,1,'candidate','required_evidence','prueba','{}','learned') returning id`,
        [G, IDS.brand, 'test.' + Math.random()]);
      return r.rows[0].id as string;
    });
  }
  it('un advisor puede proponer candidata pero no activarla', async () => {
    const id = await newCandidate('advisor');
    await expect(withTenant({ groupId: G, role: 'advisor' }, c =>
      c.query(`update rules set status='active' where id=$1`, [id]))).rejects.toThrow(/reviewer/);
  });
  it('un reviewer sí puede aprobar y queda en audit_log', async () => {
    const id = await newCandidate('reviewer');
    await withTenant({ groupId: G, role: 'reviewer', userId: IDS.reviewer }, c =>
      c.query(`update rules set status='active', approved_by=$2, approved_at=now() where id=$1`, [id, IDS.reviewer]));
    const a = await withTenant({ groupId: G }, c => c.query(`select action from audit_log where entity_id=$1 order by id`, [id]));
    expect(a.rows.map(r => r.action)).toEqual(['rules.create', 'rules.status:candidate->active']);
  });
});

describe('audit_log', () => {
  it('encadena hashes y verify_audit_chain da null', async () => {
    await withTenant({ groupId: G, role: 'owner' }, async c => {
      for (const a of ['x.one', 'x.two', 'x.three'])
        await c.query(`insert into audit_log(group_id,action,entity,data) values ($1,$2,'test','{"k":1}')`, [G, a]);
    });
    const r = await getPool().query('select verify_audit_chain($1) v', [G]);
    expect(r.rows[0].v).toBeNull();
    const rows = (await getPool().query('select prev_hash,hash from audit_log where group_id=$1 order by id', [G])).rows;
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
  });
  it('rechaza UPDATE y DELETE', async () => {
    await expect(withTenant({ groupId: G }, c => c.query(`update audit_log set action='hack'`))).rejects.toThrow();
    await expect(getPool().query('delete from audit_log')).rejects.toThrow(/solo-agregar/);
  });
  it('detecta manipulación', async () => {
    const pool = getPool();
    await pool.query('alter table audit_log disable trigger audit_no_update');
    const row = (await pool.query('select id, data from audit_log where group_id=$1 order by id limit 1 offset 1', [G])).rows[0];
    await pool.query(`update audit_log set data='{"k":999}' where id=$1`, [row.id]);
    const v = (await pool.query('select verify_audit_chain($1) v', [G])).rows[0].v;
    expect(Number(v)).toBe(Number(row.id));
    await pool.query('update audit_log set data=$2 where id=$1', [row.id, row.data]);
    await pool.query('alter table audit_log enable trigger audit_no_update');
  });
});
