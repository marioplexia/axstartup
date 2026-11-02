import { getPool } from '../../src/db/pool.js';

/** Crea un grupo aislado (marca + agencia + usuarios) para pruebas que cambian tabuladores/reglas. */
export async function makeGroup(label = 'T') {
  const p = getPool();
  const g = (await p.query(`insert into groups(name) values ($1) returning id`, [`${label} ${Math.random()}`])).rows[0].id as string;
  const brand = (await p.query(`insert into brands(group_id,name,code) values ($1,'GM','GM') returning id`, [g])).rows[0].id as string;
  const agency = (await p.query(`insert into agencies(group_id,brand_id,name,city) values ($1,$2,'Ag','X') returning id`, [g, brand])).rows[0].id as string;
  const mk = async (role: string) => (await p.query(`insert into users(group_id,agency_id,email,display_name,role) values ($1,$2,$3,$3,$4) returning id`, [g, role === 'advisor' ? agency : null, `${role}@${g}.test`, role])).rows[0].id as string;
  return { groupId: g, brandId: brand, agencyId: agency, advisorId: await mk('advisor'), reviewerId: await mk('reviewer') };
}

export async function addTab(g: { groupId: string; brandId: string }, o: { key: string; kind: string; subject?: string | null; value: number; unit?: string; from?: string; to?: string | null; version?: number; status?: string }) {
  await getPool().query(
    `insert into tabulators(group_id,brand_id,tab_key,version,kind,subject,value,unit,status,valid_from,valid_to,origin)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'seed')`,
    [g.groupId, g.brandId, o.key, o.version ?? 1, o.kind, o.subject ?? null, o.value, o.unit ?? 'MXN', o.status ?? 'active', o.from ?? '2024-01-01', o.to ?? null]);
}
