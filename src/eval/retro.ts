import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { CONFIG } from '../../config/defaults.js';
import { withTenant, type Tenant } from '../db/pool.js';
import { calculate } from '../estimate/calc.js';
import { loadNonPayable, loadTabulators } from '../estimate/service.js';
import type { LlmClient } from '../llm/client.js';
import { computeMetrics, type OutcomeRow } from '../metrics/compute.js';
import { loadLearningCases } from '../nightly/cases.js';
import { loadTaxonomy } from '../nightly/taxonomy.js';
import { analyzeDraft } from '../verify/service.js';
import { assignSplit } from './split.js';
import { confusion, parseParts, precision, recall } from './score.js';
import { z } from 'zod';

/** Lo ÚNICO que el sistema ve de un caso en la prueba: primera versión + evidencia de esa versión. Sin comentarios ni resultado. */
export interface BlindInput {
  order_id: string; agency_id: string; claim_date: string; submitted_on: string;
  fields: Record<string, any>; evidence_kinds: string[];
}
export interface Truth { rejected_first: boolean; rounds: number; paid: { labor: number; parts: number; total: number } | null }

export interface RetroOptions { build: number; blind: number; useAgent: boolean; flagAt: 'warning' | 'blocker'; detail: boolean; outDir?: string }
export const DEFAULT_RETRO: RetroOptions = { build: CONFIG.eval.buildCases, blind: CONFIG.eval.blindCases, useAgent: false, flagAt: 'warning', detail: false };

async function loadInputs(c: pg.PoolClient, ids: string[]): Promise<BlindInput[]> {
  if (!ids.length) return [];
  // Consulta deliberadamente limitada: prea_versions(version_no=1) y evidence_files(version_no=1). NO toca prea_comments ni outcomes.
  const r = await c.query(
    `select o.id order_id, o.agency_id, o.claim_date::text claim_date, v.fields, v.submitted_at,
            coalesce((select array_agg(distinct e.kind) from evidence_files e where e.order_id=o.id and e.version_no=1),'{}') evidence_kinds
       from orders o join prea_versions v on v.order_id=o.id and v.version_no=1 where o.id = any($1) order by o.claim_date, o.order_number`, [ids]);
  return r.rows.map(x => ({ order_id: x.order_id, agency_id: x.agency_id, claim_date: x.claim_date, submitted_on: (x.submitted_at ? new Date(x.submitted_at).toISOString() : x.claim_date).slice(0, 10), fields: x.fields, evidence_kinds: x.evidence_kinds }));
}

async function loadTruth(c: pg.PoolClient, ids: string[]): Promise<Map<string, Truth>> {
  const r = await c.query(`select order_id, result, rounds, paid_by_concept, total_paid::float tp from outcomes where order_id = any($1)`, [ids]);
  return new Map(r.rows.map(x => [x.order_id, { rejected_first: x.result === 'rejected' || x.rounds > 1, rounds: x.rounds,
    paid: x.paid_by_concept?.labor !== undefined ? { labor: Number(x.paid_by_concept.labor), parts: Number(x.paid_by_concept.parts), total: x.tp } : null }]));
}

async function scoreSet(c: pg.PoolClient, tenant: Tenant, inputs: BlindInput[], truth: Map<string, Truth>, llm: LlmClient, o: RetroOptions) {
  const rank = { info: 0, warning: 1, blocker: 2 } as const;
  const rows: Array<{ predicted: boolean; actual: boolean; rule_keys: string[]; id: string }> = [];
  const est: OutcomeRow[] = []; const tabsUsed = new Set<string>(); const rulesUsed = new Set<string>();
  for (const i of inputs) {
    const t = truth.get(i.order_id)!;
    const a = await analyzeDraft(c, tenant, {
      agency_id: i.agency_id, order_id: undefined, today: i.submitted_on, customer_names: [],
      draft: { fields: i.fields, evidence: i.evidence_kinds.map(kind => ({ kind })), repair_date: i.fields.repair_date, submit_date: i.submitted_on },
    }, llm, { useAgent: o.useAgent });
    const hits = a.findings.filter(f => rank[f.severity] >= rank[o.flagAt]);
    hits.forEach(f => f.rule_key && rulesUsed.add(`${f.rule_key}@v${f.rule_version}`));
    rows.push({ id: i.order_id, predicted: hits.length > 0, actual: t.rejected_first, rule_keys: [...new Set(hits.map(h => h.rule_key ?? 'agent'))] });

    // estimado desde conceptos de la primera versión, con tabuladores vigentes a la fecha del reclamo
    const brand = a.brandId;
    const concepts = { operations: i.fields.work_op ? [{ op_code: String(i.fields.work_op), hours: i.fields.labor_hours != null ? Number(i.fields.labor_hours) : undefined }] : [], parts: parseParts(i.fields.part_numbers) };
    const e = calculate(concepts, await loadTabulators(c, brand, i.claim_date), await loadNonPayable(c, brand, i.claim_date));
    e.tabulator_versions.forEach(v => tabsUsed.add(`${v.tab_key}@v${v.version}`));
    if (t.paid) {
      const d = (x: number, p: number) => ({ estimated: x, paid: p, delta: +(x - p).toFixed(2), pct: p === 0 ? null : +(((x - p) / p) * 100).toFixed(2) });
      est.push({ agency_id: i.agency_id, order_id: i.order_id, result: 'accepted', rounds: t.rounds, days_to_acceptance: null, complete_same_day: false, llm_cost_usd: 0, llm_tokens: 0,
        estimate_error: { labor: d(e.subtotals.labor, t.paid.labor), parts: d(e.subtotals.parts, t.paid.parts), total: d(e.total, t.paid.total) } });
    }
  }
  const cm = confusion(rows);
  const actualRounds = inputs.map(i => truth.get(i.order_id)!.rounds);
  const avg = (x: number[]) => (x.length ? +(x.reduce((a, b) => a + b, 0) / x.length).toFixed(2) : null);
  return {
    cases: inputs.length,
    rejection_detection: { ...cm, actual_first_pass_rejections: cm.tp + cm.fn, detected: cm.tp, precision: precision(cm), recall: recall(cm) },
    rounds: { actual_avg: avg(actualRounds), predicted_avg: avg(rows.map(r => (r.predicted ? 2 : 1))), avoidable_rounds_if_findings_followed: cm.tp },
    estimate_error: computeMetrics(est).estimate_error,
    rules_in_effect: [...rulesUsed].sort(), tabulators_in_effect: [...tabsUsed].sort(),
    _rows: rows,
  };
}

async function ensureSplit(c: pg.PoolClient, o: Pick<RetroOptions, 'build' | 'blind'>) {
  // Reparto idempotente: no mueve asignaciones existentes (una orden ciega nunca vuelve a construcción).
  const all = (await c.query(
    `select o.id, o.order_number, o.claim_date::text claim_date, o.eval_split split from orders o
      where o.ingest_status='ok' and exists (select 1 from outcomes oc where oc.order_id=o.id) and exists (select 1 from prea_versions v where v.order_id=o.id and v.version_no=1)`)).rows;
  const sp = assignSplit(all.map(x => ({ id: x.id, order_number: x.order_number, claim_date: x.claim_date, split: x.split })), o.build, o.blind);
  for (const [id, s] of sp.assigned) await c.query('update orders set eval_split=$2 where id=$1', [id, s]);
  const buildIds = all.filter(x => sp.assigned.get(x.id) === 'build' || x.split === 'build').map(x => x.id as string);
  const blindIds = all.filter(x => sp.assigned.get(x.id) === 'blind' || x.split === 'blind').map(x => x.id as string);
  const warnings: string[] = [];
  if (sp.shortfall.build || sp.shortfall.blind) warnings.push(`Casos insuficientes: faltan ${sp.shortfall.build} de construcción y ${sp.shortfall.blind} de prueba ciega para llegar a ${o.build}/${o.blind}.`);
  return { buildIds, blindIds, warnings };
}

/** Fija el reparto construcción/ciega. Córrelo ANTES de los cortes nocturnos para que la prueba ciega quede protegida. */
export async function assignEvalSplit(tenant: Tenant, o: Partial<Pick<RetroOptions, 'build' | 'blind'>> = {}) {
  const r = await withTenant(tenant, c => ensureSplit(c, { ...DEFAULT_RETRO, ...o }));
  return { build: r.buildIds.length, blind: r.blindIds.length, warnings: r.warnings };
}

export async function runRetro(tenant: Tenant, llm: LlmClient, opts: Partial<RetroOptions> = {}) {
  const o = { ...DEFAULT_RETRO, ...opts };
  return withTenant(tenant, async c => {
    const { buildIds, blindIds, warnings } = await ensureSplit(c, o);

    // 2) contaminación: ninguna regla/tabulador puede estar respaldado por casos ciegos
    const blindSet = new Set(blindIds);
    const contaminated: string[] = [];
    for (const r of (await c.query(`select rule_key, version, evidence from rules where status in ('candidate','approved','active','retired') and origin='learned'`)).rows)
      if ((r.evidence as Array<{ order_id: string }>).some(e => blindSet.has(e.order_id))) contaminated.push(`regla ${r.rule_key} v${r.version}`);
    if (blindIds.length) for (const t of (await c.query(
      `select t.tab_key, t.version from tabulators t where t.origin='learned' and exists (
         select 1 from jsonb_array_elements_text(t.support) s(id) join transaction_lines l on l.id::text = s.id join transactions tx on tx.id=l.transaction_id where tx.order_id = any($1))`, [blindIds])).rows)
      contaminated.push(`tabulador ${t.tab_key} v${t.version}`);
    if (contaminated.length) throw new Error(`Contaminación de la prueba ciega: ${contaminated.join(', ')} se apoyan en casos ciegos. No se genera el reporte.`);

    // 3) puntuar construcción (para ver brecha de sobreajuste) y prueba ciega (solo primera versión)
    const [bi, bl] = [await loadInputs(c, buildIds), await loadInputs(c, blindIds)];
    const truth = await loadTruth(c, [...buildIds, ...blindIds]);
    const build = await scoreSet(c, tenant, bi, truth, llm, o);
    const blind = await scoreSet(c, tenant, bl, truth, llm, o);

    // causas de los rechazos NO detectados en la ciega (solo agregado; clasificación en memoria, no se persiste)
    const tax = loadTaxonomy(); const missedCauses: Record<string, number> = {};
    const missedIds = blind._rows.filter(r => r.actual && !r.predicted).map(r => r.id);
    if (missedIds.length) {
      const cm = (await c.query(`select body_redacted from prea_comments where order_id = any($1) and author_role='plant'`, [missedIds])).rows;
      const Cl = z.object({ cause_code: z.string(), confidence: z.number(), field: z.string().nullable().optional() });
      for (const m of cm) {
        const r = await llm.run('rejection-classifier', 'rejection-classifier.v1.md', { comment: m.body_redacted, taxonomy: tax.causes.map(({ code, label, description, keywords }) => ({ code, label, description, keywords })) }, Cl);
        if (r.output.cause_code !== 'otro') missedCauses[r.output.cause_code] = (missedCauses[r.output.cause_code] ?? 0) + 1;
      }
    }

    const strip = ({ _rows, ...rest }: any) => rest;
    const report = {
      generated_at: new Date().toISOString(),
      params: { build: o.build, blind: o.blind, use_agent: o.useAgent, flag_at: o.flagAt, split: 'cronológico (los más antiguos construyen, los siguientes son ciegos)' },
      cases: { build: buildIds.length, blind: blindIds.length }, warnings,
      build: strip(build), blind: strip(blind),
      blind_missed_causes: missedCauses,
      generalization_gap: { recall: build.rejection_detection.recall !== null && blind.rejection_detection.recall !== null ? +(build.rejection_detection.recall - blind.rejection_detection.recall).toFixed(3) : null },
      per_case_detail: o.detail ? blind._rows.map(r => ({ order_id: r.id, predicted: r.predicted, actual: r.actual, rules: r.rule_keys })) : 'omitido a propósito: no ajustes reglas mirando casos de la prueba ciega (usa --detail solo para depurar el motor)',
      integrity: { blind_inputs: 'prea_versions.version_no=1 + evidence_files.version_no=1', comments_used: false, outcome_used_for_prediction: false, contamination_check: 'ok' },
    };
    await c.query(`insert into audit_log(group_id,actor_id,actor_role,action,entity,entity_id,data) values ($1,$2,$3,'eval.retro','orders',null,$4)`,
      [tenant.groupId, tenant.userId ?? null, tenant.role ?? null, JSON.stringify({ build: report.cases.build, blind: report.cases.blind, blind_recall: blind.rejection_detection.recall, blind_precision: blind.rejection_detection.precision })]);
    if (o.outDir) writeReport(report, o.outDir);
    return report;
  });
}

export function toMarkdown(r: any): string {
  const f = (x: any) => (x === null || x === undefined ? '—' : x);
  const sec = (t: string, s: any) => `### ${t} (${s.cases} casos)
- Rechazos reales a la primera: **${s.rejection_detection.actual_first_pass_rejections}** · detectados: **${s.rejection_detection.detected}** · falsos positivos: ${s.rejection_detection.fp}
- Recall: **${f(s.rejection_detection.recall)}** · Precisión: **${f(s.rejection_detection.precision)}**
- Rondas: reales ${f(s.rounds.actual_avg)} · predichas ${f(s.rounds.predicted_avg)} · evitables si se siguieran los hallazgos: ${s.rounds.avoidable_rounds_if_findings_followed}
- Error del estimado (n=${s.estimate_error.total.n}): total MAE $${f(s.estimate_error.total.mae_pesos)} / ${f(s.estimate_error.total.mape_pct)}% · mano de obra MAE $${f(s.estimate_error.labor.mae_pesos)} / ${f(s.estimate_error.labor.mape_pct)}% · piezas MAE $${f(s.estimate_error.parts.mae_pesos)} / ${f(s.estimate_error.parts.mape_pct)}%
- Reglas vigentes: ${s.rules_in_effect.join(', ') || '(ninguna)'}
- Tabuladores: ${s.tabulators_in_effect.join(', ') || '(ninguno)'}`;
  return `# Prueba retroactiva — ${r.generated_at}

${r.warnings.map((w: string) => `> ⚠️ ${w}`).join('\n')}

Reparto: ${r.params.split}. Construcción ${r.cases.build} · Prueba ciega ${r.cases.blind}.
En la prueba ciega el sistema recibió **solo la primera versión** y su evidencia; nunca comentarios ni resultado.
**No ajustes reglas mirando los casos de la prueba ciega.**

${sec('Prueba ciega', r.blind)}

${sec('Construcción (referencia, no es una medida honesta)', r.build)}

Brecha de generalización (recall construcción − ciega): ${f(r.generalization_gap.recall)}
Causas de rechazos no detectados en la ciega (solo conteo): ${JSON.stringify(r.blind_missed_causes)}
`;
}

export function writeReport(report: any, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `eval-retro-${stamp}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, `eval-retro-${stamp}.md`), toMarkdown(report));
}
