import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { signDevToken } from '../src/auth.js';
import { closePool, getPool } from '../src/db/pool.js';
import { makeGroup, addTab } from './helpers/tenant.js';
import { estimateClaim } from '../src/estimate/service.js';

afterAll(closePool);
const q = (sql: string, p: unknown[] = []) => getPool().query(sql, p).then(r => r.rows);

async function setup() {
  const g = await makeGroup('APR');
  const app = await buildServer();
  const h = async (role: 'advisor' | 'reviewer') => ({ authorization: `Bearer ${await signDevToken({ userId: role === 'advisor' ? g.advisorId : g.reviewerId, groupId: g.groupId, role, agencyId: role === 'advisor' ? g.agencyId : undefined })}` });
  const rule = async (version: number, status: string, cond: object = { type: 'required_evidence', evidence_kind: 'foto' }, from: string | null = null) =>
    (await q(`insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,condition,origin,valid_from)
              values ($1,$2,'learned.falta_foto.foto',$3,1,$4,'required_evidence','Foto',$5,'learned',$6) returning id`, [g.groupId, g.brandId, version, status, JSON.stringify(cond), from]))[0].id as string;
  return { g, app, adv: await h('advisor'), rev: await h('reviewer'), rule };
}

describe('aprobación de reglas', () => {
  it('solo reviewer aprueba/descarta; advisor recibe 403 y no puede ver candidatas', async () => {
    const { app, adv, rev, rule } = await setup();
    const id = await rule(1, 'candidate');
    expect((await app.inject({ method: 'POST', url: `/rules/${id}/approve`, headers: adv, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/rules/${id}/discard`, headers: adv, payload: { note: 'no' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/rules?status=candidate', headers: adv })).statusCode).toBe(403);
    const l = await app.inject({ method: 'GET', url: '/rules?status=candidate', headers: rev });
    expect(l.statusCode).toBe(200);
    expect(l.json().map((r: any) => r.id)).toEqual([id]);
    expect((await q('select status from rules where id=$1', [id]))[0].status).toBe('candidate');
  });

  it('aprobar activa con vigencia, retira la versión anterior, registra auditoría y la cadena sigue íntegra', async () => {
    const { g, app, rev, rule } = await setup();
    const v1 = await rule(1, 'active', { type: 'required_evidence', evidence_kind: 'foto' }, '2024-01-01');
    const v2 = await rule(2, 'candidate', { type: 'required_evidence', evidence_kind: 'foto', when: { field: 'work_op', prefix: 'OP-MT' } });
    const res = await app.inject({ method: 'POST', url: `/rules/${v2}/approve`, headers: rev, payload: { valid_from: '2025-06-01', note: 'Revisada con 4 casos' } });
    expect(res.statusCode).toBe(200);
    const [a, b] = await q('select id,status,version,valid_from::text vf,valid_to::text vt,approved_by,supersedes_id from rules where id = any($1) order by version', [[v1, v2]]);
    expect(a).toMatchObject({ status: 'retired', vf: '2024-01-01', vt: '2025-05-31' });
    expect(b).toMatchObject({ status: 'active', vf: '2025-06-01', vt: null, approved_by: g.reviewerId, supersedes_id: v1 });
    const au = await q(`select action, actor_role from audit_log where group_id=$1 and entity_id=$2 order by id`, [g.groupId, v2]);
    expect(au.map(x => x.action)).toEqual(['rules.create', 'rules.status:candidate->active', 'rules.approve']);
    expect(au.every(x => x.actor_role === 'reviewer' || x.actor_role === null)).toBe(true);
    expect((await q('select verify_audit_chain($1) v', [g.groupId]))[0].v).toBeNull();
    // ya no se puede aprobar de nuevo
    expect((await app.inject({ method: 'POST', url: `/rules/${v2}/approve`, headers: rev, payload: {} })).statusCode).toBe(409);
  });

  it('descartar exige motivo y deja la candidata fuera de uso', async () => {
    const { app, rev, rule } = await setup();
    const id = await rule(1, 'candidate');
    expect((await app.inject({ method: 'POST', url: `/rules/${id}/discard`, headers: rev, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/rules/${id}/discard`, headers: rev, payload: { note: 'Planta ya no lo exige' } })).statusCode).toBe(200);
    const r = (await q('select status, decision_note from rules where id=$1', [id]))[0];
    expect(r).toEqual({ status: 'discarded', decision_note: 'Planta ya no lo exige' });
  });

  it('revertir crea una versión nueva con el contenido de la anterior; el historial no se reescribe', async () => {
    const { g, app, rev, rule } = await setup();
    const cond1 = { type: 'required_evidence', evidence_kind: 'foto' };
    const v1 = await rule(1, 'active', cond1, '2024-01-01');
    const v2 = await rule(2, 'candidate', { type: 'required_evidence', evidence_kind: 'foto', when: { field: 'work_op', prefix: 'OP-MT' } });
    await app.inject({ method: 'POST', url: `/rules/${v2}/approve`, headers: rev, payload: { valid_from: '2025-06-01' } });
    const res = await app.inject({ method: 'POST', url: `/rules/${v2}/revert`, headers: rev, payload: { note: 'Generaba falsos positivos' } });
    expect(res.statusCode).toBe(200);
    const rows = await q('select version,status,condition,origin,supersedes_id,valid_to::text vt from rules where rule_key=$1 and group_id=$2 order by version', ['learned.falta_foto.foto', g.groupId]);
    expect(rows.map(r => [r.version, r.status])).toEqual([[1, 'retired'], [2, 'retired'], [3, 'active']]);
    expect(rows[2].condition).toEqual(cond1);
    expect(rows[2]).toMatchObject({ origin: 'manual', supersedes_id: v2 });
    expect((await q(`select 1 from audit_log where group_id=$1 and action='rules.revert'`, [g.groupId])).length).toBe(1);
    // la v1 sigue como estaba (retirada con su vigencia original)
    expect((await q('select status from rules where id=$1', [v1]))[0].status).toBe('retired');
  });

  it('el trigger de la base también bloquea a un advisor que intente saltarse la API', async () => {
    const { g, rule } = await setup();
    const id = await rule(1, 'candidate');
    const { withTenant } = await import('../src/db/pool.js');
    await expect(withTenant({ groupId: g.groupId, role: 'advisor', userId: g.advisorId }, c => c.query(`update rules set status='active' where id=$1`, [id]))).rejects.toThrow(/reviewer/);
  });
});

describe('tabuladores: vigencias y reversión afectan las estimaciones', () => {
  it('aprobar un tabulador cambia estimaciones nuevas pero no las de fechas anteriores; revertir restaura', async () => {
    const g = await makeGroup('APR2');
    const app = await buildServer();
    const rev = { authorization: `Bearer ${await signDevToken({ userId: g.reviewerId, groupId: g.groupId, role: 'reviewer' })}` };
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 420, from: '2024-01-01', version: 1 });
    await addTab(g, { key: 'std_time:OP-A', kind: 'standard_time', subject: 'OP-A', value: 2, unit: 'h' });
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 450, from: '2024-01-01', version: 2, status: 'candidate' });
    const cand = (await q(`select id from tabulators where group_id=$1 and status='candidate'`, [g.groupId]))[0].id;
    const T = { groupId: g.groupId, userId: g.reviewerId, role: 'reviewer' as const };
    const input = { agency_id: g.agencyId, concepts: { operations: [{ op_code: 'OP-A' }], parts: [] } };

    const ap = await app.inject({ method: 'POST', url: `/tabulators/${cand}/approve`, headers: rev, payload: { valid_from: '2025-03-01' } });
    expect(ap.statusCode).toBe(200);
    expect((await estimateClaim(T, { ...input, claim_date: '2025-02-28' })).total).toBe(840);   // versión anterior
    expect((await estimateClaim(T, { ...input, claim_date: '2025-03-01' })).total).toBe(900);   // nueva
    const e = await estimateClaim(T, { ...input, claim_date: '2025-03-10' });
    expect(e.tabulator_versions.find(t => t.tab_key === 'labor_rate')!.version).toBe(2);

    const rv = await app.inject({ method: 'POST', url: `/tabulators/${cand}/revert`, headers: rev, payload: {} });
    expect(rv.statusCode).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect((await estimateClaim(T, { ...input, claim_date: today })).total).toBe(840);          // restaurada la tarifa anterior
    expect((await estimateClaim(T, { ...input, claim_date: '2025-03-10' })).total).toBe(900);   // lo ya estimado en su vigencia no cambia
    expect((await q(`select count(*)::int n from tabulators where group_id=$1 and tab_key='labor_rate'`, [g.groupId]))[0].n).toBe(3);
  });
});
