import { z } from 'zod';
import { LlmClient, LlmUsage } from '../llm/client.js';
import { EvidenceReading } from '../verify/service.js';
import { evidencePayload, classifierPayload } from '../verify/payload.js';
import { loadTaxonomy } from '../nightly/taxonomy.js';
import { redactFields } from '../redact/index.js';
import { pricesConfigured } from '../../config/defaults.js';
import type { LiveCase } from '../../tests/fixtures/live-cases.js';

const Classification = z.object({ cause_code: z.string(), confidence: z.number(), field: z.string().nullable().optional() });

export interface AgentRun { output: any; usage: LlmUsage }
export interface CaseResult {
  id: string; title: string;
  mock: { evidence: AgentRun; classify: AgentRun };
  live?: { evidence: AgentRun; classify: AgentRun } | { error: string };
  diffs: string[];
  /** vs. lo que esperaría un revisor humano (referencia aparte de mock vs real) */
  versus_expected: { mock: string[]; live: string[] };
  live_cost_usd?: number; live_tokens?: { input: number; output: number };
}
export interface CompareReport {
  generated_at: string; model: string; prices_configured: boolean;
  cases: CaseResult[];
  summary: { cases: number; live_ran: number; cases_with_diffs: number; avg_cost_per_prea_usd: number | null; total_cost_usd: number | null; avg_tokens_per_prea: number | null };
}

const sorted = (a: string[]) => [...a].sort();
const same = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const set = (x: any[], k: string) => x.map(o => String(o[k]));

export function diffRuns(m: { evidence: any; classify: any }, l: { evidence: any; classify: any }): string[] {
  const d: string[] = [];
  const me = m.evidence, le = l.evidence;
  if (!same(me.evidence_detected, le.evidence_detected)) d.push(`evidencia detectada: simulado=[${sorted(me.evidence_detected)}] real=[${sorted(le.evidence_detected)}]`);
  if (!same(set(me.missing, 'kind'), set(le.missing, 'kind'))) d.push(`faltantes: simulado=[${sorted(set(me.missing, 'kind'))}] real=[${sorted(set(le.missing, 'kind'))}]`);
  if (!same(set(me.concepts.operations, 'op_code'), set(le.concepts.operations, 'op_code'))) d.push(`operaciones: simulado=[${set(me.concepts.operations, 'op_code')}] real=[${set(le.concepts.operations, 'op_code')}]`);
  if (!same(set(me.concepts.parts, 'part_no'), set(le.concepts.parts, 'part_no'))) d.push(`piezas: simulado=[${set(me.concepts.parts, 'part_no')}] real=[${set(le.concepts.parts, 'part_no')}]`);
  if (m.classify.cause_code !== l.classify.cause_code) d.push(`causa: simulado=${m.classify.cause_code} real=${l.classify.cause_code}`);
  if ((m.classify.field ?? null) !== (l.classify.field ?? null)) d.push(`campo: simulado=${m.classify.field ?? '—'} real=${l.classify.field ?? '—'}`);
  return d;
}

function versusExpected(r: { evidence: any; classify: any }, c: LiveCase): string[] {
  const d: string[] = [];
  if (r.classify.cause_code !== c.expect.cause_code) d.push(`causa esperada ${c.expect.cause_code}, obtuvo ${r.classify.cause_code}`);
  if ((c.expect.field ?? null) !== (r.classify.field ?? null)) d.push(`campo esperado ${c.expect.field ?? '—'}, obtuvo ${r.classify.field ?? '—'}`);
  if (!same(c.expect.missing, set(r.evidence.missing, 'kind'))) d.push(`faltantes esperados [${c.expect.missing}], obtuvo [${set(r.evidence.missing, 'kind')}]`);
  return d;
}

async function runAgents(llm: LlmClient, c: LiveCase) {
  const tax = loadTaxonomy();
  const fields = redactFields(c.fields, { knownNames: c.customer_names });
  const evidence = await llm.run('evidence-reader', 'evidence-reader.v1.md',
    evidencePayload(fields, c.evidence.map(e => ({ ...e, text: redactTextWithNames(e.text, c.customer_names) })), c.required_kinds), EvidenceReading);
  const classify = await llm.run('rejection-classifier', 'rejection-classifier.v1.md',
    classifierPayload(redactTextWithNames(c.plant_comment, c.customer_names), tax.causes), Classification);
  return { evidence: { output: evidence.output, usage: evidence.usage }, classify: { output: classify.output, usage: classify.usage } };
}
import { redact } from '../redact/index.js';
const redactTextWithNames = (t: string, names: string[]) => redact(t, { knownNames: names }).text;

export async function compareAgents(cases: LiveCase[], mock: LlmClient, live: LlmClient | null, model: string): Promise<CompareReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const m = await runAgents(mock, c);
    const res: CaseResult = { id: c.id, title: c.title, mock: { evidence: m.evidence, classify: m.classify }, diffs: [], versus_expected: { mock: versusExpected({ evidence: m.evidence.output, classify: m.classify.output }, c), live: [] } };
    if (live) {
      try {
        const l = await runAgents(live, c);
        res.live = { evidence: l.evidence, classify: l.classify };
        res.diffs = diffRuns({ evidence: m.evidence.output, classify: m.classify.output }, { evidence: l.evidence.output, classify: l.classify.output });
        res.versus_expected.live = versusExpected({ evidence: l.evidence.output, classify: l.classify.output }, c);
        const inT = l.evidence.usage.inputTokens + l.classify.usage.inputTokens, outT = l.evidence.usage.outputTokens + l.classify.usage.outputTokens;
        res.live_tokens = { input: inT, output: outT };
        res.live_cost_usd = +(l.evidence.usage.costUsd + l.classify.usage.costUsd).toFixed(6);
      } catch (e) { res.live = { error: (e as Error).message }; }
    }
    results.push(res);
  }
  const ran = results.filter(r => r.live && 'evidence' in r.live);
  const priced = pricesConfigured();
  const total = ran.reduce((s, r) => s + (r.live_cost_usd ?? 0), 0);
  const tokens = ran.reduce((s, r) => s + (r.live_tokens!.input + r.live_tokens!.output), 0);
  return {
    generated_at: new Date().toISOString(), model, prices_configured: priced, cases: results,
    summary: {
      cases: results.length, live_ran: ran.length, cases_with_diffs: ran.filter(r => r.diffs.length).length,
      total_cost_usd: ran.length && priced ? +total.toFixed(6) : null,
      avg_cost_per_prea_usd: ran.length && priced ? +(total / ran.length).toFixed(6) : null,
      avg_tokens_per_prea: ran.length ? Math.round(tokens / ran.length) : null,
    },
  };
}

export function reportToMarkdown(r: CompareReport): string {
  const s = r.summary;
  const L = [`# Agente simulado vs real (${r.model})`, '', `Generado: ${r.generated_at}. Solo fixtures ficticios, todo redactado y sellado antes de llamar al modelo.`, '',
    `- Casos: ${s.cases} · con corrida real: ${s.live_ran} · con diferencias: ${s.cases_with_diffs}`,
    `- Tokens promedio por PREA (2 llamadas: lector de texto + clasificador): ${s.avg_tokens_per_prea ?? 'n/d'}`,
    `- Costo por PREA: ${s.avg_cost_per_prea_usd !== null ? `US$ ${s.avg_cost_per_prea_usd} (total US$ ${s.total_cost_usd})` : r.prices_configured ? 'n/d (no hubo corrida real)' : 'n/d: define LLM_PRICE_IN y LLM_PRICE_OUT (USD por millón de tokens)'}`, ''];
  for (const c of r.cases) {
    L.push(`## ${c.id} · ${c.title}`);
    if (!c.live) L.push('- (solo simulado, sin corrida real)');
    else if ('error' in c.live) L.push(`- ERROR real: ${c.live.error}`);
    else {
      L.push(c.diffs.length ? '- Diferencias simulado ↔ real:' : '- Sin diferencias simulado ↔ real.', ...c.diffs.map(d => `  - ${d}`));
      L.push(`- Costo: ${c.live_cost_usd !== undefined && r.prices_configured ? `US$ ${c.live_cost_usd}` : 'n/d'} (${c.live_tokens!.input} in / ${c.live_tokens!.output} out)`);
      if (c.versus_expected.live.length) L.push('- Real vs esperado por el revisor:', ...c.versus_expected.live.map(d => `  - ${d}`));
    }
    if (c.versus_expected.mock.length) L.push('- Simulado vs esperado:', ...c.versus_expected.mock.map(d => `  - ${d}`));
    L.push('');
  }
  return L.join('\n');
}
