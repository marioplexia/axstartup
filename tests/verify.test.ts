import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { signDevToken } from '../src/auth.js';
import { closePool, getPool, withTenant } from '../src/db/pool.js';
import { makeGroup } from './helpers/tenant.js';
import { runChecklist, type RuleRow } from '../src/verify/checklist.js';

afterAll(closePool);

const rule = (kind: string, condition: any, sev: RuleRow['severity'] = 'blocker', key = `t.${kind}`): RuleRow =>
  ({ id: key + '-id', rule_key: key, version: 1, kind, title: 'regla de prueba', severity: sev, condition });
const D = (fields: any = {}, evidence: any[] = []) => ({ fields, evidence });

describe('checklist determinista', () => {
  it('campo obligatorio', () => {
    const f = runChecklist([rule('required_field', { type: 'required_field', field: 'vin' })], D({ vin: '' }), { today: '2025-01-10' });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_key: 't.required_field', severity: 'blocker', field: 'vin' });
    expect(runChecklist([rule('required_field', { type: 'required_field', field: 'vin' })], D({ vin: 'X' }), { today: '2025-01-10' })).toHaveLength(0);
  });
  it('evidencia requerida condicionada por operación', () => {
    const r = rule('required_evidence', { type: 'required_evidence', evidence_kind: 'foto', when: { field: 'work_op', prefix: 'OP-MT' } });
    expect(runChecklist([r], D({ work_op: 'OP-MT-031' }), { today: '2025-01-10' })).toHaveLength(1);
    expect(runChecklist([r], D({ work_op: 'OP-MT-031' }, [{ kind: 'foto' }]), { today: '2025-01-10' })).toHaveLength(0);
    expect(runChecklist([r], D({ work_op: 'OP-FR-011' }), { today: '2025-01-10' })).toHaveLength(0);
  });
  it('plazo', () => {
    const r = rule('deadline', { type: 'deadline', max_days: 30 });
    const d = { ...D(), repair_date: '2025-01-01', submit_date: '2025-03-01' };
    expect(runChecklist([r], d, { today: '2025-03-01' })[0].message).toMatch(/59 días/);
    expect(runChecklist([r], { ...d, submit_date: '2025-01-20' }, { today: '2025-03-01' })).toHaveLength(0);
  });
  it('duplicado por VIN + operación dentro de ventana', () => {
    const r = rule('duplicate', { type: 'duplicate', keys: ['vin', 'work_op'], window_days: 90 });
    const prior = [{ order_id: 'o1', order_number: 'ORD-1', vin: 'V1', fields: { work_op: 'OP-A' }, claim_date: '2025-01-01' }];
    expect(runChecklist([r], D({ vin: 'V1', work_op: 'OP-A' }), { today: '2025-02-01', prior })).toHaveLength(1);
    expect(runChecklist([r], D({ vin: 'V1', work_op: 'OP-A' }), { today: '2025-09-01', prior })).toHaveLength(0);
    expect(runChecklist([r], D({ vin: 'V2', work_op: 'OP-A' }), { today: '2025-02-01', prior })).toHaveLength(0);
  });
});

async function setup() {
  const g = await makeGroup('VER');
  const p = getPool();
  for (const f of ['vin', 'work_op'])
    await p.query(`insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,severity,condition,origin,valid_from)
      values ($1,$2,$3,1,1,'active','required_field','Campo obligatorio','blocker',$4,'form','2024-01-01')`, [g.groupId, g.brandId, `form.required.${f}`, JSON.stringify({ type: 'required_field', field: f })]);
  await p.query(`insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,severity,condition,origin,valid_from)
    values ($1,$2,'learned.foto.motor',1,1,'active','required_evidence','Planta exige foto en motor','warning',$3,'learned','2024-01-01')`,
    [g.groupId, g.brandId, JSON.stringify({ type: 'required_evidence', evidence_kind: 'foto', when: { field: 'work_op', prefix: 'OP-MT' } })]);
  const app = await buildServer();
  const tok = (role: 'advisor' | 'reviewer', agencyId = g.agencyId) => signDevToken({ userId: role === 'advisor' ? g.advisorId : g.reviewerId, groupId: g.groupId, role, agencyId: role === 'advisor' ? agencyId : undefined });
  return { g, app, tok };
}

describe('POST /prea/verify', () => {
  it('exige autenticación', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/prea/verify', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/prea/verify', payload: {}, headers: { authorization: 'Bearer basura' } })).statusCode).toBe(401);
  });

  it('devuelve hallazgos con severidad y regla de origen, y detecta evidencia faltante', async () => {
    const { g, app, tok } = await setup();
    const res = await app.inject({ method: 'POST', url: '/prea/verify', headers: { authorization: `Bearer ${await tok('advisor')}` },
      payload: { agency_id: g.agencyId, draft: { fields: { vin: '', work_op: 'OP-MT-031', complaint_text: 'Cliente Pedro Gómez, 443 111 2222' }, evidence: [{ kind: 'orden_reparacion', text: 'Orden de reparación. OP-MT-031 PZ-MT-6120' }], }, read_text: true } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blocked).toBe(true);
    const vin = body.findings.find((f: any) => f.rule_key === 'form.required.vin');
    expect(vin).toMatchObject({ severity: 'blocker', rule_version: 1, source: 'checklist' });
    const foto = body.findings.find((f: any) => f.rule_key === 'learned.foto.motor');
    expect(foto).toMatchObject({ severity: 'warning', field: 'foto' });
    expect(body.reading.concepts.parts[0].part_no).toBe('PZ-MT-6120');
    // se guardó redactado y se registraron tokens/hash sin texto
    const v = await withTenant({ groupId: g.groupId }, c => c.query('select draft from verifications where id=$1', [body.id]));
    expect(JSON.stringify(v.rows[0].draft)).not.toMatch(/Pedro|443 111/);
    const calls = await withTenant({ groupId: g.groupId }, c => c.query('select * from llm_calls'));
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.rows[0].input_tokens).toBeGreaterThan(0);
  });

  it('con la evidencia presente no hay hallazgo de evidencia', async () => {
    const { g, app, tok } = await setup();
    const res = await app.inject({ method: 'POST', url: '/prea/verify', headers: { authorization: `Bearer ${await tok('advisor')}` },
      payload: { agency_id: g.agencyId, draft: { fields: { vin: 'V', work_op: 'OP-MT-031' }, evidence: [{ kind: 'foto', filename: 'tensor.jpg' }] } } });
    expect(res.json().findings).toHaveLength(0);
    expect(res.json().blocked).toBe(false);
  });

  it('el asesor no puede operar sobre otra agencia', async () => {
    const { g, app, tok } = await setup();
    const other = (await getPool().query(`insert into agencies(group_id,brand_id,name,city) values ($1,$2,'Otra','Y') returning id`, [g.groupId, g.brandId])).rows[0].id;
    const res = await app.inject({ method: 'POST', url: '/prea/verify', headers: { authorization: `Bearer ${await tok('advisor')}` },
      payload: { agency_id: other, draft: { fields: {} } } });
    expect(res.statusCode).toBe(403);
  });

  it('ignorar un hallazgo exige razón y queda como dato y en auditoría', async () => {
    const { g, app, tok } = await setup();
    const h = { authorization: `Bearer ${await tok('advisor')}` };
    const v = (await app.inject({ method: 'POST', url: '/prea/verify', headers: h, payload: { agency_id: g.agencyId, draft: { fields: { work_op: 'OP-FR-011' } } } })).json();
    const key = v.findings[0].key;
    expect((await app.inject({ method: 'POST', url: `/verifications/${v.id}/ignore`, headers: h, payload: { finding_key: key, reason: '' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/verifications/${v.id}/ignore`, headers: h, payload: { finding_key: key, reason: 'VIN se captura al ingresar la unidad' } });
    expect(ok.statusCode).toBe(200);
    const o = await withTenant({ groupId: g.groupId }, c => c.query('select reason, rule_id from finding_overrides'));
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0].rule_id).toBeTruthy();
    const a = await withTenant({ groupId: g.groupId }, c => c.query(`select 1 from audit_log where action='finding.ignored'`));
    expect(a.rowCount).toBe(1);
  });
});

describe('POST /prea/estimate', () => {
  it('estima con tabuladores vigentes', async () => {
    const { g, app, tok } = await setup();
    const { addTab } = await import('./helpers/tenant.js');
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 400 });
    await addTab(g, { key: 'std_time:OP-A', kind: 'standard_time', subject: 'OP-A', value: 2, unit: 'h' });
    const res = await app.inject({ method: 'POST', url: '/prea/estimate', headers: { authorization: `Bearer ${await tok('advisor')}` },
      payload: { agency_id: g.agencyId, claim_date: '2025-02-01', concepts: { operations: [{ op_code: 'OP-A' }], parts: [] } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(800);
    expect(res.json().tabulator_versions).toHaveLength(2);
  });
});
