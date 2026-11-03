import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closePool, getPool } from '../src/db/pool.js';
import { makeLlm } from '../src/llm/client.js';
import { runNightly } from '../src/nightly/run.js';
import { approve } from '../src/rules/service.js';
import { assignSplit } from '../src/eval/split.js';
import { confusion, parseParts, precision, recall } from '../src/eval/score.js';
import { assignEvalSplit, runRetro } from '../src/eval/retro.js';
import { makeGroup, addTab } from './helpers/tenant.js';
import { makeCase } from './helpers/cases.js';

afterAll(closePool);
const q = (sql: string, p: unknown[] = []) => getPool().query(sql, p).then(r => r.rows);

describe('assignSplit (puro)', () => {
  const mk = (n: number, split: any = null) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, order_number: `N${i}`, claim_date: `2025-01-${String(i + 1).padStart(2, '0')}`, split: i === 0 ? split : null }));
  it('cronológico: los más antiguos construyen, los siguientes son ciegos', () => {
    const r = assignSplit(mk(10), 6, 4);
    expect([...r.assigned].filter(([, s]) => s === 'build').map(([id]) => id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4', 'o5']);
    expect([...r.assigned].filter(([, s]) => s === 'blind').map(([id]) => id)).toEqual(['o6', 'o7', 'o8', 'o9']);
    expect(r.shortfall).toEqual({ build: 0, blind: 0 });
  });
  it('no mueve asignaciones existentes y reporta faltantes', () => {
    const cases = mk(5, 'blind');
    const r = assignSplit(cases, 3, 2);
    expect(r.assigned.has('o0')).toBe(false);          // ya era ciega: no se toca
    expect(r.blindTotal).toBe(2);
    const short = assignSplit(mk(3), 30, 20);
    expect(short.shortfall).toEqual({ build: 27, blind: 20 });
  });
});

describe('score', () => {
  it('matriz de confusión, precisión y recall', () => {
    const c = confusion([{ predicted: true, actual: true }, { predicted: true, actual: false }, { predicted: false, actual: true }, { predicted: false, actual: false }, { predicted: true, actual: true }]);
    expect(c).toEqual({ tp: 2, fp: 1, fn: 1, tn: 1 });
    expect(precision(c)).toBe(0.667); expect(recall(c)).toBe(0.667);
  });
  it('parseParts', () => expect(parseParts('PZ-MT-6120 x2, PZ-MT-9001')).toEqual([{ part_no: 'PZ-MT-6120', quantity: 2 }, { part_no: 'PZ-MT-9001', quantity: 1 }]));
});

describe('eval:retro de punta a punta', () => {
  async function scenario() {
    const g = await makeGroup('EVAL');
    await addTab(g, { key: 'labor_rate', kind: 'labor_rate', value: 420 });
    await addTab(g, { key: 'std_time:OP-MT-031', kind: 'standard_time', subject: 'OP-MT-031', value: 3.4, unit: 'h' });
    await addTab(g, { key: 'part_price:PZ-MT-6120', kind: 'part_price', subject: 'PZ-MT-6120', value: 2140 });
    const FOTO = 'Rechazada: falta foto del tensor.';
    let d = 0;
    for (const n of ['B1', 'B2', 'B3']) await makeCase({ g, n, day: (d += 3), rejectedFor: [FOTO], evidenceV1: ['orden_reparacion'], evidenceV2: ['foto'] });
    for (const n of ['B4', 'B5', 'B6']) await makeCase({ g, n, day: (d += 3), evidenceV1: ['foto'] });
    // ciegas (más recientes)
    for (const n of ['C1', 'C2']) await makeCase({ g, n, day: (d += 3), rejectedFor: [FOTO], evidenceV1: ['orden_reparacion'], evidenceV2: ['foto'] });
    await makeCase({ g, n: 'C3', day: (d += 3), rejectedFor: ['Rechazada: falta la factura.'], evidenceV1: ['foto'], evidenceV2: ['factura'] });
    await makeCase({ g, n: 'C4', day: (d += 3), evidenceV1: ['foto'] });
    const T = { groupId: g.groupId, role: 'system' as const };
    const R = { groupId: g.groupId, userId: g.reviewerId, role: 'reviewer' as const };
    return { g, T, R };
  }

  it('mide solo con la primera versión, sin tocar reglas, y reporta agregados', async () => {
    const { g, T, R } = await scenario();
    expect(await assignEvalSplit(T, { build: 6, blind: 4 })).toMatchObject({ build: 6, blind: 4 });
    const nightly = await runNightly(T, makeLlm());                    // aprende SOLO de construcción
    expect(nightly.rule_candidates).toHaveLength(1);
    expect(nightly.rule_candidates[0].cases).toBe(3);                  // ninguna de las C* contó
    await approve(R, 'rules', nightly.rule_candidates[0].rule_id, { valid_from: '2025-01-01' });
    const rulesBefore = JSON.stringify(await q('select id,status,version from rules where group_id=$1 order by id', [g.groupId]));

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-'));
    const rep = await runRetro(T, makeLlm(), { build: 6, blind: 4, outDir: out });

    expect(rep.cases).toEqual({ build: 6, blind: 4 });
    expect(rep.blind.rejection_detection).toMatchObject({ actual_first_pass_rejections: 3, detected: 2, fp: 0, fn: 1, tn: 1, recall: 0.667, precision: 1 });
    expect(rep.blind.rounds).toMatchObject({ actual_avg: 1.75, avoidable_rounds_if_findings_followed: 2 });
    expect(rep.blind.rules_in_effect).toEqual(['learned.falta_foto.foto@v1']);
    // estimado desde la 1ª versión con tabuladores vigentes: 3.4h×420=1428 vs pagado 1530; pieza 2140 vs 2300
    expect(rep.blind.estimate_error.labor.mae_pesos).toBe(102);
    expect(rep.blind.estimate_error.parts.mae_pesos).toBe(160);
    expect(rep.blind.estimate_error.total.mape_pct).toBe(6.84);   // (3830-3568)/3830
    expect(rep.blind_missed_causes).toEqual({ falta_factura: 1 });
    expect(rep.integrity).toMatchObject({ comments_used: false, outcome_used_for_prediction: false });
    expect(typeof rep.per_case_detail).toBe('string');                 // sin detalle por caso por defecto
    expect(fs.readdirSync(out).sort().map(f => path.extname(f))).toEqual(['.json', '.md']);
    expect(fs.readFileSync(path.join(out, fs.readdirSync(out).find(f => f.endsWith('.md'))!), 'utf8')).toMatch(/No ajustes reglas mirando/);

    // el eval no cambia reglas ni tabuladores
    expect(JSON.stringify(await q('select id,status,version from rules where group_id=$1 order by id', [g.groupId]))).toBe(rulesBefore);

    // los comentarios y el resultado NO influyen en la predicción: cambiarlos no mueve la detección
    await q(`update prea_comments set body_redacted='cualquier otra cosa' where order_id in (select id from orders where group_id=$1 and eval_split='blind')`, [g.groupId]);
    const rep2 = await runRetro(T, makeLlm(), { build: 6, blind: 4 });
    expect(rep2.blind.rejection_detection).toEqual(rep.blind.rejection_detection);
  });

  it('aborta si una regla aprendida se apoya en un caso ciego (contaminación)', async () => {
    const { g, T } = await scenario();
    await assignEvalSplit(T, { build: 6, blind: 4 });
    const blindId = (await q(`select id from orders where group_id=$1 and eval_split='blind' limit 1`, [g.groupId]))[0].id;
    await q(`insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,condition,evidence,origin)
             values ($1,$2,'learned.trampa',1,1,'candidate','required_field','x','{"type":"required_field","field":"vin"}',$3,'learned')`, [g.groupId, g.brandId, JSON.stringify([{ order_id: blindId }])]);
    await expect(runRetro(T, makeLlm(), { build: 6, blind: 4 })).rejects.toThrow(/Contaminación/);
  });

  it('avisa cuando no hay casos suficientes', async () => {
    const { T } = await scenario();
    const rep = await runRetro(T, makeLlm(), { build: 30, blind: 20 });
    expect(rep.warnings[0]).toMatch(/Casos insuficientes/);
  });
});
