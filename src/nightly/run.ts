import { z } from 'zod';
import { CONFIG } from '../../config/defaults.js';
import { withTenant, type Tenant } from '../db/pool.js';
import type { LlmClient } from '../llm/client.js';
import { computeMetrics } from '../metrics/compute.js';
import { loadOutcomeRows } from '../metrics/service.js';
import type { RuleRow } from '../verify/checklist.js';
import { backtestRule } from './backtest.js';
import { loadLearningCases, type Case } from './cases.js';
import { proposeTabulators, type CurrentTab, type PayLine } from './tabulators.js';
import { loadTaxonomy, type Taxonomy } from './taxonomy.js';

export interface NightlyParams { minCasesForRule: number; minCasesForTabulator: number; tabulatorDeviationPct: number; clusterPct: number; minPrecision: number }
export const DEFAULT_PARAMS: NightlyParams = { ...CONFIG.nightly, clusterPct: 2, minPrecision: 0.6 };

const Classification = z.object({ cause_code: z.string(), confidence: z.number().min(0).max(1), field: z.string().nullable().optional() });

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

export async function runNightly(tenant: Tenant, llm: LlmClient, overrides: Partial<NightlyParams> = {}, tax: Taxonomy = loadTaxonomy()) {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const run = (await withTenant(tenant, c => c.query(`insert into nightly_runs(group_id,params) values ($1,$2) returning id`, [tenant.groupId, JSON.stringify({ ...params, taxonomy_version: tax.version })]))).rows[0].id as string;
  const summary: any = { classified: 0, rule_candidates: [], rule_skipped: [], tabulator_candidates: [], tabulator_skipped: [], uncovered_causes: [] };
  try {
    // 1) Clasificar comentarios de planta aún sin clasificar (solo casos de aprendizaje)
    const cases = await withTenant(tenant, c => loadLearningCases(c));
    const ids = cases.map(k => k.order_id);
    const pending = ids.length ? (await withTenant(tenant, c => c.query(
      `select pc.id, pc.order_id, pc.body_redacted from prea_comments pc
        where pc.order_id = any($1) and pc.author_role='plant'
          and not exists (select 1 from rejection_classifications rc where rc.comment_id=pc.id and rc.taxonomy_version=$2)`, [ids, tax.version]))).rows : [];
    const codes = new Set(tax.causes.map(c => c.code));
    for (const cm of pending) {
      const r = await llm.run('rejection-classifier', 'rejection-classifier.v1.md',
        { comment: cm.body_redacted, taxonomy: tax.causes.map(({ code, label, description, keywords }) => ({ code, label, description, keywords })) }, Classification);
      const cause = codes.has(r.output.cause_code) ? r.output.cause_code : 'otro';
      await withTenant(tenant, async c => {
        await c.query(`insert into rejection_classifications(group_id,order_id,comment_id,taxonomy_version,cause_code,field,confidence) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [tenant.groupId, cm.order_id, cm.id, tax.version, cause, r.output.field ?? null, r.output.confidence]);
        await c.query(`insert into llm_calls(group_id,order_id,agent,model,prompt_hash,input_tokens,output_tokens,cost_usd) values ($1,$2,'rejection-classifier',$3,$4,$5,$6,$7)`,
          [tenant.groupId, cm.order_id, r.usage.model, r.usage.promptHash, r.usage.inputTokens, r.usage.outputTokens, r.usage.costUsd]);
      });
      summary.classified++;
    }

    // 2) Agrupar por causa (+campo) y proponer reglas candidatas
    await withTenant(tenant, async c => {
      const brand = (await c.query('select id from brands limit 1')).rows[0].id as string;
      const cls = (await c.query(
        `select rc.order_id, rc.cause_code, rc.field, rc.comment_id from rejection_classifications rc
          where rc.taxonomy_version=$1 and rc.order_id = any($2) and rc.cause_code <> 'otro'`, [tax.version, ids])).rows;
      const groups = new Map<string, { cause: string; field: string | null; orders: Map<string, string> }>();
      for (const x of cls) {
        const key = x.cause_code + (x.cause_code === 'campo_faltante' && x.field ? `.${x.field}` : '');
        if (!groups.has(key)) groups.set(key, { cause: x.cause_code, field: x.field, orders: new Map() });
        groups.get(key)!.orders.set(x.order_id, x.comment_id);
      }
      const byId = new Map(cases.map(k => [k.order_id, k]));
      for (const [gk, g] of groups) {
        const cause = tax.causes.find(t => t.code === g.cause)!;
        const n = g.orders.size;
        if (n < params.minCasesForRule) { summary.rule_skipped.push({ cause: gk, cases: n, reason: `menos de ${params.minCasesForRule} casos` }); continue; }
        if (!cause.rule) { summary.uncovered_causes.push({ cause: gk, cases: n, reason: 'la taxonomía no define plantilla de regla; requiere regla manual' }); continue; }
        const tpl = cause.rule;
        const support = [...g.orders.keys()].map(id => byId.get(id)!).filter(Boolean);
        let condition: any; let paramKey = '';
        if (tpl.kind === 'required_evidence') {
          condition = { type: 'required_evidence', evidence_kind: tpl.evidence_kind }; paramKey = `.${tpl.evidence_kind}`;
          const ops = support.map(k => String(k.v1.fields.work_op ?? '').slice(0, 5)).filter(Boolean);
          if (ops.length === support.length && new Set(ops).size === 1) condition.when = { field: 'work_op', prefix: ops[0] };
        } else if (tpl.kind === 'required_field') {
          if (!g.field) { summary.uncovered_causes.push({ cause: gk, cases: n, reason: 'el clasificador no identificó el campo' }); continue; }
          condition = { type: 'required_field', field: g.field }; paramKey = `.${g.field}`;
        } else if (tpl.kind === 'deadline') {
          const ok = cases.filter(k => !g.orders.has(k.order_id) && k.v1.fields.repair_date && k.v1.submitted_at).map(k => days(String(k.v1.fields.repair_date), k.v1.submitted_at!));
          if (!ok.length) { summary.uncovered_causes.push({ cause: gk, cases: n, reason: 'sin casos aceptados para derivar el plazo' }); continue; }
          condition = { type: 'deadline', max_days: Math.max(...ok) };
        } else condition = { type: 'duplicate', keys: tpl.keys ?? ['vin', 'work_op'], window_days: tpl.window_days ?? 90 };
        const ruleKey = `learned.${g.cause}${paramKey}`;

        const existing = (await c.query(`select id,status,evidence from rules where rule_key=$1 order by version desc`, [ruleKey])).rows;
        if (existing.some(e => e.status === 'candidate' || e.status === 'active' || e.status === 'approved')) { summary.rule_skipped.push({ cause: gk, cases: n, reason: 'ya existe candidata o regla vigente' }); continue; }
        const supportIds = new Set([...g.orders.keys()]);
        const disc = existing.find(e => e.status === 'discarded');
        if (disc && [...supportIds].every(id => (disc.evidence as any[]).some(ev => ev.order_id === id))) { summary.rule_skipped.push({ cause: gk, cases: n, reason: 'descartada antes y sin casos nuevos' }); continue; }

        const draft: RuleRow = { id: 'draft', rule_key: ruleKey, version: 1, kind: tpl.kind, title: `${cause.label} (aprendida)`, severity: tpl.severity, condition };
        const bt = backtestRule(draft, cases, supportIds);
        const bad = bt.precision === null || bt.precision < params.minPrecision || bt.true_positives === 0;
        const evidence = support.map(k => ({ order_id: k.order_id, order_number: k.order_number, comment_id: g.orders.get(k.order_id) }));
        if (bad) {
          await c.query(`insert into rule_backtests(group_id,nightly_run_id,cases_total,true_positives,false_positives,missed,detail) values ($1,$2,$3,$4,$5,$6,$7)`,
            [tenant.groupId, run, bt.cases_total, bt.true_positives, bt.false_positives, bt.missed, JSON.stringify({ rule_key: ruleKey, condition, precision: bt.precision, recall: bt.recall, outcome: 'no_propuesta' })]);
          summary.rule_skipped.push({ cause: gk, cases: n, reason: `backtest insuficiente (precisión ${bt.precision})` }); continue;
        }
        const version = (existing[0] ? (await c.query('select max(version) v from rules where rule_key=$1', [ruleKey])).rows[0].v : 0) + 1;
        const ins = await c.query(
          `insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,severity,condition,evidence,origin)
           values ($1,$2,$3,$4,1,'candidate',$5,$6,$7,$8,$9,'learned') returning id`,
          [tenant.groupId, brand, ruleKey, version, tpl.kind, draft.title, tpl.severity, JSON.stringify(condition), JSON.stringify(evidence)]);
        await c.query(`insert into rule_backtests(group_id,rule_id,nightly_run_id,cases_total,true_positives,false_positives,missed,detail) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenant.groupId, ins.rows[0].id, run, bt.cases_total, bt.true_positives, bt.false_positives, bt.missed, JSON.stringify({ precision: bt.precision, recall: bt.recall, flagged: bt.flagged })]);
        await c.query(`insert into events(group_id,type,action,payload) values ($1,'rule','candidate_created',$2)`, [tenant.groupId, JSON.stringify({ rule_id: ins.rows[0].id, rule_key: ruleKey, cases: n })]);
        summary.rule_candidates.push({ rule_id: ins.rows[0].id, rule_key: ruleKey, cases: n, precision: bt.precision, recall: bt.recall });
      }
    });

    // 3) Tabuladores: desviaciones consistentes en pagos reales
    await withTenant(tenant, async c => {
      const brand = (await c.query('select id from brands limit 1')).rows[0].id as string;
      const lines: PayLine[] = (await c.query(
        `select l.id, t.order_id, t.claim_date::text claim_date, l.concept, l.part_no, l.op_code, l.quantity::float quantity, l.hours::float hours, l.rate::float rate, l.amount_paid::float amount_paid
           from transaction_lines l join transactions t on t.id=l.transaction_id join orders o on o.id=t.order_id
          where o.ingest_status='ok' and coalesce(o.eval_split,'build') <> 'blind' and not t.is_adjustment`)).rows;
      const cur: CurrentTab[] = (await c.query(`select distinct on (tab_key) tab_key, version, value::float value from tabulators where status in ('active') order by tab_key, version desc`)).rows;
      const { proposals, skipped } = proposeTabulators(lines, cur, { minPayments: params.minCasesForTabulator, deviationPct: params.tabulatorDeviationPct, clusterPct: params.clusterPct });
      summary.tabulator_skipped = skipped;
      for (const p of proposals) {
        const dup = await c.query(`select 1 from tabulators where tab_key=$1 and status='candidate' and value=$2`, [p.tab_key, p.value]);
        if (dup.rowCount) { summary.tabulator_skipped.push({ tab_key: p.tab_key, reason: 'ya existe candidato con ese valor' }); continue; }
        const version = ((await c.query('select coalesce(max(version),0) v from tabulators where tab_key=$1', [p.tab_key])).rows[0].v as number) + 1;
        const ins = await c.query(
          `insert into tabulators(group_id,brand_id,tab_key,version,kind,subject,value,unit,status,valid_from,origin,support)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'candidate',current_date,'learned',$9) returning id`,
          [tenant.groupId, brand, p.tab_key, version, p.kind, p.subject, p.value, p.unit, JSON.stringify(p.support)]);
        await c.query(`insert into rule_backtests(group_id,tabulator_id,nightly_run_id,cases_total,true_positives,false_positives,missed,detail) values ($1,$2,$3,$4,$5,$6,0,$7)`,
          [tenant.groupId, ins.rows[0].id, run, p.backtest.cases_total, p.backtest.improved, p.backtest.worsened, JSON.stringify({ previous: p.previous, proposed: p.value, ...p.backtest })]);
        await c.query(`insert into events(group_id,type,action,payload) values ($1,'rule','tabulator_candidate_created',$2)`, [tenant.groupId, JSON.stringify({ tabulator_id: ins.rows[0].id, tab_key: p.tab_key })]);
        summary.tabulator_candidates.push({ tabulator_id: ins.rows[0].id, tab_key: p.tab_key, previous: p.previous, proposed: p.value, support: p.support.length });
      }
    });

    // 4) Foto de métricas del día (marca y agencias)
    const rows = await loadOutcomeRows(tenant);
    await withTenant(tenant, async c => {
      const ags = (await c.query('select id from agencies')).rows as Array<{ id: string }>;
      const save = async (agency: string | null, m: ReturnType<typeof computeMetrics>) => {
        for (const [name, value] of Object.entries({ first_pass_rejection_rate: m.first_pass_rejection_rate, avg_rounds_to_acceptance: m.avg_rounds_to_acceptance, avg_days_to_acceptance: m.avg_days_to_acceptance, prea_count: m.prea_count }))
          if (value !== null) await c.query(`insert into metrics(group_id,agency_id,name,period_start,period_end,value) values ($1,$2,$3,current_date,current_date,$4)`, [tenant.groupId, agency, name, value]);
      };
      await save(null, computeMetrics(rows));
      for (const a of ags) await save(a.id, computeMetrics(rows.filter(r => r.agency_id === a.id)));
    });

    await withTenant(tenant, async c => {
      await c.query(`update nightly_runs set status='done', finished_at=now(), summary=$2 where id=$1`, [run, JSON.stringify(summary)]);
      await c.query(`insert into audit_log(group_id,actor_id,actor_role,action,entity,entity_id,data) values ($1,$2,$3,'nightly.run','nightly_runs',$4,$5)`,
        [tenant.groupId, tenant.userId ?? null, tenant.role ?? null, run, JSON.stringify({ rule_candidates: summary.rule_candidates.length, tabulator_candidates: summary.tabulator_candidates.length })]);
    });
    return { run_id: run, ...summary };
  } catch (e) {
    await withTenant(tenant, c => c.query(`update nightly_runs set status='failed', finished_at=now(), summary=$2 where id=$1`, [run, JSON.stringify({ error: (e as Error).message })]));
    throw e;
  }
}
