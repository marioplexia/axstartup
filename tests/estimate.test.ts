import { describe, it, expect, afterAll } from 'vitest';
import { calculate, type TabRow } from '../src/estimate/calc.js';
import { estimateClaim } from '../src/estimate/service.js';
import { closePool } from '../src/db/pool.js';
import { makeGroup, addTab } from './helpers/tenant.js';

afterAll(closePool);
let n = 0;
const tab = (kind: TabRow['kind'], subject: string | null, value: number, version = 1): TabRow => ({ id: `t${++n}`, tab_key: `${kind}:${subject ?? ''}`, version, kind, subject, value });
const BASE: TabRow[] = [
  tab('labor_rate', null, 420), tab('standard_time', 'OP-MT-031', 3.4),
  tab('part_price', 'PZ-MT-6120', 2140), tab('part_price', 'PZ-MT-6121', 860), tab('part_price', 'PZ-MT-9001', 150),
];

describe('calculadora — casos dorados (ficticios)', () => {
  it('G1 cadena de distribución: 3.4h×420 + piezas = 5,178.00', () => {
    const e = calculate({ operations: [{ op_code: 'OP-MT-031', hours: 3.4 }], parts: [
      { part_no: 'PZ-MT-6120', quantity: 1 }, { part_no: 'PZ-MT-6121', quantity: 1 }, { part_no: 'PZ-MT-9001', quantity: 5 }] }, BASE);
    expect(e.subtotals).toEqual({ labor: 1428, parts: 3750 });
    expect(e.total).toBe(5178);
    expect(e.complete).toBe(true);
    expect(e.tabulator_versions.length).toBe(5);
  });
  it('G2 horas solicitadas mayores al estándar: se paga el estándar y se marca', () => {
    const e = calculate({ operations: [{ op_code: 'OP-MT-031', hours: 5 }], parts: [] }, BASE);
    expect(e.total).toBe(1428);
    expect(e.lines[0].flags[0]).toMatch(/difieren del estándar/);
  });
  it('G3 pieza sin tabulador: usa el precio pedido, marca incompleto y avisa', () => {
    const e = calculate({ operations: [], parts: [{ part_no: 'PZ-XX-1', quantity: 2, unit_price: 100 }] }, BASE);
    expect(e.total).toBe(200);
    expect(e.complete).toBe(false);
    expect(e.warnings[0]).toMatch(/PZ-XX-1/);
  });
  it('G4 tope de mano de obra', () => {
    const e = calculate({ operations: [{ op_code: 'OP-MT-031' }], parts: [] }, [...BASE, tab('cap', 'labor', 1000)]);
    expect(e.total).toBe(1000);
    expect(e.caps_applied).toEqual([{ cap: 'labor', limit: 1000, before: 1428, after: 1000 }]);
  });
  it('G5 deducible se resta del total y nunca deja negativo', () => {
    const ops = { operations: [{ op_code: 'OP-MT-031' }], parts: [] };
    expect(calculate(ops, [...BASE, tab('deductible', null, 300)]).total).toBe(1128);
    expect(calculate(ops, [...BASE, tab('deductible', null, 5000)]).total).toBe(0);
  });
  it('G6 redondeo a centavos', () => {
    const e = calculate({ operations: [{ op_code: 'X' }], parts: [] }, [tab('labor_rate', null, 333.33), tab('standard_time', 'X', 1.15)]);
    expect(e.total).toBe(383.33);
  });
  it('G7 regla de no pagable pone la línea en cero y se registra la versión', () => {
    const e = calculate({ operations: [], parts: [{ part_no: 'PZ-MT-9001', quantity: 5 }] }, BASE, [{ rule_id: 'r1', rule_key: 'np.aceite', version: 2, part_no: 'PZ-MT-9001' }]);
    expect(e.total).toBe(0);
    expect(e.rule_versions).toEqual([{ rule_id: 'r1', rule_key: 'np.aceite', version: 2 }]);
  });
  it('G8 es determinista', () => {
    const i = { operations: [{ op_code: 'OP-MT-031', hours: 3.4 }], parts: [{ part_no: 'PZ-MT-6120', quantity: 1 }] };
    expect(calculate(i, BASE)).toEqual(calculate(i, BASE));
  });
});

describe('estimateClaim — vigencia a la fecha del reclamo', () => {
  it('usa la versión del tabulador vigente en la fecha del reclamo y la guarda', async () => {
    const g = await makeGroup('EST');
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 420, from: '2024-01-01', to: '2024-12-31', status: 'retired', version: 1 });
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 450, from: '2025-01-01', version: 2 });
    await addTab(g, { key: 'std_time:OP-A', kind: 'standard_time', subject: 'OP-A', value: 2, unit: 'h' });
    const T = { groupId: g.groupId, userId: g.advisorId, role: 'advisor' as const };
    const input = { agency_id: g.agencyId, concepts: { operations: [{ op_code: 'OP-A' }], parts: [] } };
    const old = await estimateClaim(T, { ...input, claim_date: '2024-12-31' });
    const cur = await estimateClaim(T, { ...input, claim_date: '2025-02-01' });
    expect(old.total).toBe(840);
    expect(cur.total).toBe(900);
    expect(old.tabulator_versions.find(t => t.tab_key === 'labor_rate')?.version).toBe(1);
    expect(cur.tabulator_versions.find(t => t.tab_key === 'labor_rate')?.version).toBe(2);
    expect(old.id).not.toBe(cur.id);
  });
});
