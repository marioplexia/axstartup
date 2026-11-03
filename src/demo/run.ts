import pg from 'pg';
import { signDevToken } from '../auth.js';
import { getPool } from '../db/pool.js';
import { seedKnowledge } from '../db/seed.js';
import { ingestOrder } from '../ingest/ingest.js';
import { makeLlm } from '../llm/client.js';
import { recordOutcome } from '../outcome/service.js';
import { buildServer } from '../server.js';

/** Demo de punta a punta con datos FICTICIOS. Crea un grupo nuevo en cada corrida para no contaminarse. */
const FORM = (vin: string) => ({ vin, odometer: 42180, complaint_code: 'MT-205', complaint_text: 'Ruido metálico en arranque en frío', cause_code: 'MT-518', cause_text: 'Tensor de cadena sin presión',
  correction_code: 'MT-632', correction_text: 'Reemplazar tensor y guía', work_op: 'OP-MT-031', labor_hours: 3.4, parts_total: 3000, part_numbers: 'PZ-MT-6120 x1, PZ-MT-6121 x1', total_time: 3.4, gross_total: 4428 });
const FOTO_RECHAZO = 'Rechazada: falta foto del tensor de cadena.';
const iso = (daysAgo: number, h = 10) => new Date(Date.now() - daysAgo * 864e5 + (h - 12) * 36e5).toISOString().replace(/\.\d+Z$/, 'Z');
const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);

export async function runDemo(log: (s: string) => void = console.log) {
  const pool = getPool();
  const h = (t: string) => log(`\n━━━ ${t} ━━━`);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();

  // ---- Preparación (rol privilegiado): grupo FAME ficticio con la agencia de Morelia ----
  const group = (await pool.query(`insert into groups(name) values ($1) returning id`, [`Grupo FAME demo ${suffix}`])).rows[0].id as string;
  const brand = (await pool.query(`insert into brands(group_id,name,code) values ($1,'General Motors','GM') returning id`, [group])).rows[0].id as string;
  const agency = (await pool.query(`insert into agencies(group_id,brand_id,name,city) values ($1,$2,'FAME Morelia','Morelia') returning id`, [group, brand])).rows[0].id as string;
  const mkUser = async (role: string) => (await pool.query(`insert into users(group_id,agency_id,email,display_name,role) values ($1,$2,$3,$4,$5) returning id`, [group, role === 'advisor' ? agency : null, `${role}@demo.example.test`, `${role} demo`, role])).rows[0].id as string;
  const [advisorId, reviewerId] = [await mkUser('advisor'), await mkUser('reviewer')];
  await seedKnowledge(pool, group, brand);
  const system = { groupId: group, role: 'system' as const };

  // ---- Historial: 2 rechazos por foto + 3 aceptadas a la primera; todas pagadas a 450/h y pieza a 2,300 ----
  const hist = async (n: string, daysAgo: number, rejected: boolean) => {
    const f1 = FORM(`VIN-${suffix}-${n}`);
    const id = (await ingestOrder(system, {
      agency_id: agency, order_number: `H-${suffix}-${n}`, vin: f1.vin, claim_date: ymd(daysAgo),
      prea: { versions: [{ submitted_at: iso(daysAgo), fields: f1, text: '' }, ...(rejected ? [{ submitted_at: iso(daysAgo - 1), fields: { ...f1, complaint_text: f1.complaint_text + ' (con fotos)' }, text: '' }] : [])],
        comments: rejected ? [{ author_role: 'plant' as const, author: 'Planta', authored_at: iso(daysAgo, 14), body: FOTO_RECHAZO }] : [] },
      evidence: [{ kind: 'orden_reparacion', filename: `or-${n}.pdf`, version_no: 1 }, ...(rejected ? [{ kind: 'foto', filename: `foto-${n}.jpg`, version_no: 2 }] : [{ kind: 'foto', filename: `foto-${n}.jpg`, version_no: 1 }])],
      transactions: [{ tx_number: `TX-${n}`, claim_date: ymd(daysAgo), lines: [
        { concept: 'labor' as const, op_code: 'OP-MT-031', hours: 3.4, rate: 450, amount_paid: 1530 },
        { concept: 'part' as const, part_no: 'PZ-MT-6120', quantity: 1, unit_price: 2300, amount_paid: 2300 }] }],
    })).orderId;
    await recordOutcome(system, id, { result: 'accepted', accepted_at: iso(daysAgo - 3), paid_by_concept: { labor: 1530, parts: 2300 } });
  };
  await hist('1', 50, true); await hist('2', 44, true);
  await hist('3', 38, false); await hist('4', 32, false); await hist('5', 26, false);
  h('0) Historial ficticio cargado'); log('5 expedientes: 2 rechazados por falta de foto, 3 aceptados a la primera. La planta paga mano de obra a $450/h y la pieza PZ-MT-6120 a $2,300.');

  const app = await buildServer({ llm: makeLlm() });
  const tok = async (userId: string, role: 'advisor' | 'reviewer') => ({ authorization: `Bearer ${await signDevToken({ userId, groupId: group, role, agencyId: role === 'advisor' ? agency : undefined })}` });
  const adv = await tok(advisorId, 'advisor'), rev = await tok(reviewerId, 'reviewer');
  const call = async (method: 'GET' | 'POST', url: string, headers: any, payload?: any) => {
    const r = await app.inject({ method, url, headers, payload });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json();
  };

  // ---- La orden nueva (ficticia) ----
  const fields = FORM(`VIN-${suffix}-NEW`);
  const orderNumber = `DEMO-${suffix}`;
  const bundle = (extra: object = {}) => ({ agency_id: agency, order_number: orderNumber, vin: fields.vin, claim_date: ymd(0), customer_names: ['Juan Pérez López'],
    prea: { versions: [{ submitted_at: iso(0, 9), fields: { ...fields, complaint_text: 'Cliente Juan Pérez López reporta ruido metálico, tel 443 123 4567' }, text: '' }], comments: [] },
    evidence: [{ kind: 'orden_reparacion', filename: `or-${orderNumber}.pdf`, version_no: 1, text: 'Orden de reparación OP-MT-031 PZ-MT-6120' }],
    transactions: [{ tx_number: 'TX-NEW', claim_date: ymd(0), lines: [{ concept: 'labor' as const, op_code: 'OP-MT-031', hours: 3.4, rate: 450, amount_paid: 1530 }, { concept: 'part' as const, part_no: 'PZ-MT-6120', quantity: 1, unit_price: 2300, amount_paid: 2300 }] }], ...extra });
  const ing = await ingestOrder({ groupId: group, userId: advisorId, role: 'advisor' }, bundle());
  const draft = { fields, evidence: [{ kind: 'orden_reparacion', filename: 'or.pdf', text: 'Orden de reparación OP-MT-031 PZ-MT-6120' }], submit_date: ymd(0) };
  const concepts = { operations: [{ op_code: 'OP-MT-031', hours: 3.4 }], parts: [{ part_no: 'PZ-MT-6120', quantity: 1 }] };

  h('1) Verificar ANTES de enviar (solo reglas del formulario; aún no se ha aprendido nada de fotos)');
  const v1 = await call('POST', '/prea/verify', adv, { agency_id: agency, order_id: ing.orderId, draft });
  log(`Hallazgos: ${v1.findings.length}  ${v1.findings.map((f: any) => `[${f.severity}] ${f.rule_key}`).join(', ') || '(ninguno → la PREA saldría sin foto)'}`);

  h('2) Estimar el pago (calculadora determinista, tabuladores vigentes)');
  const e1 = await call('POST', '/prea/estimate', adv, { agency_id: agency, order_id: ing.orderId, claim_date: ymd(0), concepts });
  log(`Estimado: $${e1.total.toFixed(2)}  (mano de obra $${e1.subtotals.labor.toFixed(2)} + piezas $${e1.subtotals.parts.toFixed(2)})`);
  log(`Tabuladores usados: ${e1.tabulator_versions.map((t: any) => `${t.tab_key}@v${t.version}`).join(', ')}`);

  h('3) La planta rechaza por falta de foto; el asesor corrige y la aceptan. Se registra el resultado');
  await ingestOrder({ groupId: group, userId: advisorId, role: 'advisor' }, bundle({
    prea: { versions: [{ submitted_at: iso(0, 9), fields: { ...fields, complaint_text: 'Cliente Juan Pérez López reporta ruido metálico, tel 443 123 4567' }, text: '' }, { submitted_at: iso(0, 11), fields: { ...fields, complaint_text: 'Ruido metálico (con fotos)' }, text: '' }],
      comments: [{ author_role: 'plant', author: 'Planta', authored_at: iso(0, 10), body: FOTO_RECHAZO }] },
    evidence: [{ kind: 'orden_reparacion', filename: `or-${orderNumber}.pdf`, version_no: 1, text: 'Orden de reparación OP-MT-031 PZ-MT-6120' }, { kind: 'foto', filename: 'tensor.jpg', version_no: 2 }] }));
  const out = await call('POST', `/prea/${ing.orderId}/outcome`, adv, { result: 'accepted', accepted_at: iso(0, 15), estimate_id: e1.id, paid_by_concept: { labor: 1530, parts: 2300 } });
  log(`Resultado: ${out.result}, rondas ${out.rounds}, pagado $${out.total_paid.toFixed(2)}; error del estimado en mano de obra: $${out.estimate_error.labor.delta} (${out.estimate_error.labor.pct}%)`);

  h('4) Corte nocturno (mínimo 3 casos)');
  const cut = await call('POST', '/nightly/run', rev, {});
  log(`Clasificados: ${cut.classified} comentarios · reglas candidatas: ${cut.rule_candidates.map((r: any) => `${r.rule_key} (${r.cases} casos, precisión ${r.precision})`).join('; ') || '—'}`);
  log(`Tabuladores candidatos: ${cut.tabulator_candidates.map((t: any) => `${t.tab_key} ${t.previous}→${t.proposed}`).join('; ') || '—'}`);
  const cands = await call('GET', '/rules?status=candidate', rev);
  const active = await call('GET', '/rules?status=active', rev);
  log(`Nada se activó solo: ${cands.length} regla(s) en estado candidate; activas siguen siendo las ${active.length} del formulario.`);

  h('5) Revisor aprueba la regla y el tabulador de mano de obra');
  const ruleId = cands[0].id;
  const approvedRule = await call('POST', `/rules/${ruleId}/approve`, rev, { note: 'Revisada con 3 casos de respaldo' });
  log(`Regla ${approvedRule.rule_key} v${approvedRule.version} → ${approvedRule.status}, vigente desde ${String(approvedRule.valid_from).slice(0, 10)}`);
  const tabCands = await call('GET', '/tabulators?status=candidate', rev);
  const rate = tabCands.find((t: any) => t.tab_key === 'labor_rate');
  if (rate) { const ap = await call('POST', `/tabulators/${rate.id}/approve`, rev, {}); log(`Tabulador ${ap.tab_key} v${ap.version} (${ap.value}) → ${ap.status}`); }

  h('6) Volver a verificar y estimar la MISMA PREA');
  const v2 = await call('POST', '/prea/verify', adv, { agency_id: agency, draft });
  log(`Hallazgos ahora: ${v2.findings.length}`);
  for (const f of v2.findings) log(`  [${f.severity}] ${f.message}  ← regla ${f.rule_key}@v${f.rule_version}`);
  const e2 = await call('POST', '/prea/estimate', adv, { agency_id: agency, claim_date: ymd(0), concepts });
  log(`Estimado ahora: $${e2.total.toFixed(2)} (antes $${e1.total.toFixed(2)}); mano de obra $${e2.subtotals.labor.toFixed(2)}`);

  h('7) Trazabilidad');
  const chain = (await pool.query('select verify_audit_chain($1) v, (select count(*)::int from audit_log where group_id=$1) n', [group])).rows[0];
  log(`audit_log: ${chain.n} registros, cadena de hashes ${chain.v === null ? 'ÍNTEGRA' : 'ROTA en id ' + chain.v}`);
  const m = await call('GET', '/metrics', rev);
  log(`Métricas marca: ${m.brand.prea_count} PREAs, rechazo a la primera ${(m.brand.first_pass_rejection_rate * 100).toFixed(0)}%, error medio del estimado (total) $${m.brand.estimate_error.total.mae_pesos}`);
  await app.close();

  return {
    group, before: v1.findings, after: v2.findings, estimateBefore: e1.total, estimateAfter: e2.total,
    candidates: cands.map((c: any) => c.rule_key), approved: approvedRule.rule_key, auditIntact: chain.v === null,
  };
}

export async function ensureDatabase(url: string) {
  const u = new URL(url); const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  if (!(await c.query('select 1 from pg_database where datname=$1', [name])).rowCount) await c.query(`create database "${name.replace(/"/g, '')}"`);
  await c.end();
}
