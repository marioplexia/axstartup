import type pg from 'pg';
import { z } from 'zod';
import { withTenant, type Tenant } from '../db/pool.js';

/** Aprobación, descarte y reversión de versiones. Sirve igual para reglas y tabuladores. */
export type Table = 'rules' | 'tabulators';
const KEY: Record<Table, string> = { rules: 'rule_key', tabulators: 'tab_key' };
const CLONE: Record<Table, string[]> = {
  rules: ['brand_id', 'loop', 'kind', 'title', 'severity', 'condition', 'evidence'],
  tabulators: ['brand_id', 'kind', 'subject', 'value', 'unit', 'support'],
};
const http = (status: number, msg: string) => Object.assign(new Error(msg), { statusCode: status });

export const DecisionInput = z.object({
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().optional(),
});
export const DiscardInput = z.object({ note: z.string().trim().min(3, 'indica el motivo del descarte') });

async function lock(c: pg.PoolClient, t: Table, id: string) {
  const r = await c.query(`select * from ${t} where id=$1 for update`, [id]);
  if (!r.rowCount) throw http(404, 'no encontrado');
  return r.rows[0];
}
const ev = (c: pg.PoolClient, tn: Tenant, t: Table, action: string, row: any) =>
  c.query(`insert into events(group_id,type,action,payload) values ($1,'rule',$2,$3)`, [tn.groupId, `${t === 'rules' ? 'rule' : 'tabulator'}_${action}`, JSON.stringify({ id: row.id, key: row[KEY[t]], version: row.version })]);
const audit = (c: pg.PoolClient, tn: Tenant, action: string, t: Table, row: any, extra: object = {}) =>
  c.query(`insert into audit_log(group_id,actor_id,actor_role,action,entity,entity_id,data) values ($1,$2,$3,$4,$5,$6,$7)`,
    [tn.groupId, tn.userId ?? null, tn.role ?? null, action, t, row.id, JSON.stringify({ key: row[KEY[t]], version: row.version, ...extra })]);

export async function approve(tn: Tenant, t: Table, id: string, raw: unknown = {}) {
  const inp = DecisionInput.parse(raw);
  return withTenant(tn, async c => {
    const cand = await lock(c, t, id);
    if (cand.status !== 'candidate') throw http(409, `solo se aprueban candidatas (estado actual: ${cand.status})`);
    const from: string = inp.valid_from ?? (await c.query('select current_date::text d')).rows[0].d;
    if ((await c.query('select $1::date > current_date f', [from])).rows[0].f) throw http(400, 'la vigencia no puede ser futura');

    const prev = (await c.query(`select * from ${t} where ${KEY[t]}=$1 and status='active' and id<>$2 for update`, [cand[KEY[t]], id])).rows[0];
    if (prev) {
      if (prev.valid_from && (await c.query('select $1::date <= $2::date bad', [from, prev.valid_from])).rows[0].bad) throw http(400, 'la vigencia debe ser posterior al inicio de la versión vigente');
      await c.query(`update ${t} set status='retired', valid_to=$2::date - 1 where id=$1`, [prev.id, from]);
    }
    const r = await c.query(
      `update ${t} set status='active', valid_from=$2::date, valid_to=null, approved_by=$3, approved_at=now(), supersedes_id=$4, decision_note=$5 where id=$1 returning *`,
      [id, from, tn.userId ?? null, prev?.id ?? null, inp.note ?? null]);
    await audit(c, tn, `${t}.approve`, t, r.rows[0], { valid_from: from, supersedes_version: prev?.version ?? null, note: inp.note ?? null });
    await ev(c, tn, t, 'approved', r.rows[0]);
    return r.rows[0];
  });
}

export async function discard(tn: Tenant, t: Table, id: string, raw: unknown) {
  const inp = DiscardInput.parse(raw);
  return withTenant(tn, async c => {
    const cand = await lock(c, t, id);
    if (cand.status !== 'candidate') throw http(409, `solo se descartan candidatas (estado actual: ${cand.status})`);
    const r = await c.query(`update ${t} set status='discarded', decision_note=$2 where id=$1 returning *`, [id, inp.note]);
    await audit(c, tn, `${t}.discard`, t, r.rows[0], { note: inp.note });
    await ev(c, tn, t, 'discarded', r.rows[0]);
    return r.rows[0];
  });
}

/** Revierte una versión activa a la inmediata anterior creando una versión NUEVA (el historial nunca se reescribe). */
export async function revert(tn: Tenant, t: Table, id: string, raw: unknown = {}) {
  const inp = DecisionInput.parse(raw);
  return withTenant(tn, async c => {
    const cur = await lock(c, t, id);
    if (cur.status !== 'active') throw http(409, 'solo se revierte una versión activa');
    if (!cur.supersedes_id) throw http(409, 'no hay versión anterior a la cual revertir');
    const old = await lock(c, t, cur.supersedes_id);
    const today: string = (await c.query('select current_date::text d')).rows[0].d;
    if ((await c.query('select $1::date <= $2::date bad', [today, cur.valid_from])).rows[0].bad) throw http(409, 'la versión activa inició hoy; no hay vigencia que cerrar');
    const nextVersion = ((await c.query(`select max(version) v from ${t} where ${KEY[t]}=$1`, [cur[KEY[t]]])).rows[0].v as number) + 1;
    await c.query(`update ${t} set status='retired', valid_to=$2::date - 1 where id=$1`, [cur.id, today]);
    const cols = CLONE[t];
    const r = await c.query(
      `insert into ${t}(group_id,${KEY[t]},version,status,valid_from,origin,supersedes_id,approved_by,approved_at,decision_note,${cols.join(',')})
       select group_id,${KEY[t]},$2,'active',$3::date,'manual',$4,$5,now(),$6,${cols.join(',')} from ${t} where id=$1 returning *`,
      [old.id, nextVersion, today, cur.id, tn.userId ?? null, inp.note ?? `Reversión a la versión ${old.version}`]);
    await audit(c, tn, `${t}.revert`, t, r.rows[0], { reverted_from_version: cur.version, restored_content_of_version: old.version, note: inp.note ?? null });
    await ev(c, tn, t, 'reverted', r.rows[0]);
    return r.rows[0];
  });
}

export async function list(tn: Tenant & { role?: string }, t: Table, f: { status?: string; key?: string }) {
  if (tn.role === 'advisor' && f.status && !['active', 'retired'].includes(f.status)) throw http(403, 'rol no autorizado para ver candidatas');
  return withTenant(tn, async c => {
    const where: string[] = []; const p: unknown[] = [];
    if (f.status) { p.push(f.status); where.push(`r.status=$${p.length}`); }
    else if (tn.role === 'advisor') where.push(`r.status in ('active','retired')`);
    if (f.key) { p.push(f.key); where.push(`r.${KEY[t]}=$${p.length}`); }
    const fk = t === 'rules' ? 'rule_id' : 'tabulator_id';
    const rows = (await c.query(
      `select r.*, (select to_jsonb(b) - 'group_id' from rule_backtests b where b.${fk}=r.id order by b.created_at desc limit 1) backtest
         from ${t} r ${where.length ? 'where ' + where.join(' and ') : ''} order by r.${KEY[t]}, r.version desc`, p)).rows;
    return rows;
  });
}
