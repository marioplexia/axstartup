import type pg from 'pg';
import { withTenant, type Tenant } from '../db/pool.js';
import { calculate, type Concepts, type Estimate, type NonPayable, type TabRow } from './calc.js';

/** Tabuladores vigentes a la fecha del reclamo (incluye versiones ya retiradas que cubrían esa fecha). */
export async function loadTabulators(c: pg.PoolClient, brandId: string, date: string): Promise<TabRow[]> {
  const r = await c.query(
    `select distinct on (tab_key) id, tab_key, version, kind, subject, value
       from tabulators
      where brand_id=$1 and status in ('active','retired') and valid_from <= $2::date and (valid_to is null or valid_to >= $2::date)
      order by tab_key, version desc`, [brandId, date]);
  return r.rows.map(x => ({ ...x, value: Number(x.value) }));
}

export async function loadNonPayable(c: pg.PoolClient, brandId: string, date: string): Promise<NonPayable[]> {
  const r = await c.query(
    `select id, rule_key, version, condition from rules
      where brand_id=$1 and loop=2 and kind='non_payable' and status in ('active','retired')
        and (valid_from is null or valid_from <= $2::date) and (valid_to is null or valid_to >= $2::date)`, [brandId, date]);
  return r.rows.map(x => ({ rule_id: x.id, rule_key: x.rule_key, version: x.version, part_no: x.condition.part_no, op_code: x.condition.op_code }));
}

export interface EstimateInput { agency_id: string; claim_date: string; order_id?: string; concepts: Concepts }
export async function estimateClaim(tenant: Tenant, inp: EstimateInput): Promise<Estimate & { id: string }> {
  return withTenant(tenant, async c => {
    const ag = await c.query('select brand_id from agencies where id=$1', [inp.agency_id]);
    if (!ag.rowCount) throw new Error('agencia no existe en el grupo');
    const est = calculate(inp.concepts, await loadTabulators(c, ag.rows[0].brand_id, inp.claim_date), await loadNonPayable(c, ag.rows[0].brand_id, inp.claim_date));
    const ins = await c.query(
      `insert into estimates(group_id,agency_id,order_id,claim_date,total,breakdown,tabulator_versions,rule_versions)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [tenant.groupId, inp.agency_id, inp.order_id ?? null, inp.claim_date, est.total, JSON.stringify({ subtotals: est.subtotals, lines: est.lines, caps_applied: est.caps_applied, deductible: est.deductible, warnings: est.warnings, complete: est.complete }), JSON.stringify(est.tabulator_versions), JSON.stringify(est.rule_versions)]);
    await c.query(`insert into events(group_id,agency_id,type,action,payload) values ($1,$2,'prea','estimated',$3)`, [tenant.groupId, inp.agency_id, JSON.stringify({ estimate_id: ins.rows[0].id, total: est.total })]);
    return { ...est, id: ins.rows[0].id };
  });
}
