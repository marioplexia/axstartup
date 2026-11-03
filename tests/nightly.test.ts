import { describe, it, expect, afterAll } from 'vitest';
import { closePool, getPool, withTenant } from '../src/db/pool.js';
import { makeLlm } from '../src/llm/client.js';
import { runNightly } from '../src/nightly/run.js';
import { backtestRule } from '../src/nightly/backtest.js';
import { proposeTabulators } from '../src/nightly/tabulators.js';
import { loadTaxonomy } from '../src/nightly/taxonomy.js';
import { makeGroup, addTab } from './helpers/tenant.js';
import { makeCase } from './helpers/cases.js';

afterAll(closePool);

describe('taxonomía', () => {
  it('carga y valida el YAML revisable', () => {
    const t = loadTaxonomy();
    expect(t.causes.map(c => c.code)).toContain('falta_foto');
    expect(t.causes.find(c => c.code === 'otro')).toBeTruthy();
  });
});

describe('proposeTabulators (puro)', () => {
  const L = (id: string, price: number, date: string) => ({ id, order_id: id, claim_date: date, concept: 'part' as const, part_no: 'P1', op_code: null, quantity: 1, hours: null, rate: null, amount_paid: price });
  const P = { minPayments: 3, deviationPct: 5, clusterPct: 2 };
  it('propone cuando hay mínimo de pagos consistentes y desviados', () => {
    const r = proposeTabulators([L('a', 110, '2025-01-01'), L('b', 111, '2025-01-02'), L('c', 110, '2025-01-03')], [{ tab_key: 'part_price:P1', version: 1, value: 100 }], P);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ value: 110, previous: 100 });
    expect(r.proposals[0].backtest.improved).toBe(3);
  });
  it('no propone con pocos pagos, dispersos o sin desviación', () => {
    const cur = [{ tab_key: 'part_price:P1', version: 1, value: 100 }];
    expect(proposeTabulators([L('a', 110, '1'), L('b', 110, '2')], cur, P).proposals).toHaveLength(0);
    expect(proposeTabulators([L('a', 90, '1'), L('b', 110, '2'), L('c', 150, '3')], cur, P).proposals).toHaveLength(0);
    expect(proposeTabulators([L('a', 101, '1'), L('b', 101, '2'), L('c', 101, '3')], cur, P).proposals).toHaveLength(0);
  });
});

describe('backtestRule (puro)', () => {
  const k = (id: string, evidence: string[], op = 'OP-MT-031') => ({ order_id: id, order_number: id, agency_id: 'a', claim_date: '2025-01-01', result: 'accepted' as const, rounds: 1, v1: { fields: { work_op: op }, submitted_at: '2025-01-01T00:00:00Z' }, evidence_v1: evidence });
  const rule = { id: 'x', rule_key: 'k', version: 1, kind: 'required_evidence', title: 't', severity: 'warning' as const, condition: { type: 'required_evidence', evidence_kind: 'foto', when: { field: 'work_op', prefix: 'OP-MT' } } };
  it('cuenta aciertos, falsos positivos y omisiones', () => {
    const cases = [k('1', []), k('2', []), k('3', ['foto']), k('4', [], 'OP-FR-011'), k('5', [])];
    const bt = backtestRule(rule, cases, new Set(['1', '2', '4']));
    expect(bt).toMatchObject({ true_positives: 2, false_positives: 1, missed: 1, precision: 0.667, recall: 0.667 });
  });
});

describe('corte nocturno', () => {
  it('propone reglas y tabuladores candidatos con respaldo y backtest; nada se activa; excluye prueba ciega; es idempotente', async () => {
    const g = await makeGroup('NIGHT');
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 420 });
    await addTab(g, { key: 'std_time:OP-MT-031', kind: 'standard_time', subject: 'OP-MT-031', value: 3.4, unit: 'h' });
    await addTab(g, { key: 'part_price:PZ-MT-6120', kind: 'part_price', subject: 'PZ-MT-6120', value: 2140 });
    const FOTO = 'Rechazada: falta foto del tensor de cadena.';
    let d = 1;
    for (const n of ['A1', 'A2', 'A3', 'A4']) await makeCase({ g, n, day: (d += 3), rejectedFor: [FOTO], evidenceV1: ['orden_reparacion'], evidenceV2: ['foto'] });
    for (const n of ['B1', 'B2', 'B3']) await makeCase({ g, n, day: (d += 3), evidenceV1: ['foto'] });
    for (const [i, n] of ['C1', 'C2', 'C3'].entries()) await makeCase({ g, n, day: (d += 3), op: 'OP-FR-011', partNo: 'PZ-FR-5501', partPrice: [1000, 1200, 1500][i] });
    for (const n of ['D1', 'D2']) await makeCase({ g, n, day: (d += 3), op: 'OP-EL-003', partNo: 'PZ-EL-4402', partPrice: 6900, rejectedFor: ['Rechazada: falta la factura de la pieza.'] });
    const blind = await makeCase({ g, n: 'BL1', day: 28, rejectedFor: [FOTO], evidenceV1: [], blind: true });

    const T = { groupId: g.groupId, role: 'system' as const };
    const llm = makeLlm();
    const r1 = await runNightly(T, llm);

    // reglas
    expect(r1.rule_candidates).toHaveLength(1);
    expect(r1.rule_candidates[0]).toMatchObject({ rule_key: 'learned.falta_foto.foto', cases: 4, precision: 1 });
    expect(r1.rule_skipped.some((s: any) => s.cause === 'falta_factura' && /menos de 3/.test(s.reason))).toBe(true);
    const rule = (await getPool().query(`select * from rules where group_id=$1 and origin='learned'`, [g.groupId])).rows;
    expect(rule).toHaveLength(1);
    expect(rule[0].status).toBe('candidate');
    expect(rule[0].condition).toEqual({ type: 'required_evidence', evidence_kind: 'foto', when: { field: 'work_op', prefix: 'OP-MT' } });
    expect(rule[0].evidence).toHaveLength(4);
    expect(rule[0].evidence.some((e: any) => e.order_id === blind)).toBe(false);   // la prueba ciega no se usa
    const bt = (await getPool().query(`select * from rule_backtests where rule_id=$1`, [rule[0].id])).rows[0];
    expect(bt).toMatchObject({ true_positives: 4, false_positives: 0 });
    expect(bt.cases_total).toBe(12);                                                  // 4+3+3+2, sin el caso ciego

    // tabuladores: tarifa 450 vs 420 y pieza 2300 vs 2140 consistentes; piezas FR dispersas no
    const tabs = r1.tabulator_candidates.map((t: any) => [t.tab_key, t.previous, t.proposed]);
    expect(tabs).toContainEqual(['labor_rate', 420, 450]);
    expect(tabs).toContainEqual(['part_price:PZ-MT-6120', 2140, 2300]);
    expect(r1.tabulator_skipped.some((s: any) => s.tab_key === 'part_price:PZ-FR-5501' && /consistentes/.test(s.reason))).toBe(true);
    const cand = (await getPool().query(`select status, version, tab_key from tabulators where group_id=$1 and origin='learned'`, [g.groupId])).rows;
    expect(cand.every(t => t.status === 'candidate')).toBe(true);
    expect(cand.find(t => t.tab_key === 'labor_rate')!.version).toBe(2);       // nueva versión de una existente
    expect(cand.find(t => t.tab_key === 'std_time:OP-FR-011')!.version).toBe(1); // subject sin tabulador previo
    expect((await getPool().query(`select count(*)::int n from tabulators where group_id=$1 and status='active'`, [g.groupId])).rows[0].n).toBe(3);

    // trazabilidad
    const llmCalls = (await getPool().query(`select * from llm_calls where group_id=$1 and agent='rejection-classifier'`, [g.groupId])).rows;
    expect(llmCalls.length).toBeGreaterThan(0);
    expect(llmCalls.every(c => /^[0-9a-f]{64}$/.test(c.prompt_hash))).toBe(true);
    expect((await getPool().query(`select count(*)::int n from audit_log where group_id=$1 and action='nightly.run'`, [g.groupId])).rows[0].n).toBe(1);
    expect((await getPool().query(`select count(*)::int n from metrics where group_id=$1`, [g.groupId])).rows[0].n).toBeGreaterThan(0);

    // idempotencia
    const r2 = await runNightly(T, llm);
    expect(r2.classified).toBe(0);
    expect(r2.rule_candidates).toHaveLength(0);
    expect(r2.tabulator_candidates).toHaveLength(0);
    expect((await getPool().query(`select count(*)::int n from rules where group_id=$1 and origin='learned'`, [g.groupId])).rows[0].n).toBe(1);
  });

  it('el umbral de casos es configurable', async () => {
    const g = await makeGroup('NIGHT2');
    for (const [i, n] of ['E1', 'E2'].entries()) await makeCase({ g, n, day: 3 + i * 3, rejectedFor: ['Rechazada: falta foto.'], evidenceV1: [], evidenceV2: ['foto'] });
    const T = { groupId: g.groupId, role: 'system' as const };
    expect((await runNightly(T, makeLlm())).rule_candidates).toHaveLength(0);
    expect((await runNightly(T, makeLlm(), { minCasesForRule: 2 })).rule_candidates).toHaveLength(1);
  });
});
