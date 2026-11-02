import { z } from 'zod';
import { withTenant, type Tenant } from '../db/pool.js';
import type { LlmClient } from '../llm/client.js';
import { redact, redactFields } from '../ingest/redact.js';
import { runChecklist, type Draft, type Finding, type PriorPrea, type RuleRow } from './checklist.js';

export const EvidenceReading = z.object({
  concepts: z.object({
    operations: z.array(z.object({ op_code: z.string(), hours: z.number().optional() })),
    parts: z.array(z.object({ part_no: z.string(), quantity: z.number().default(1) })),
  }),
  evidence_detected: z.array(z.string()),
  missing: z.array(z.object({ kind: z.string(), reason: z.string() })),
  notes: z.array(z.string()).max(5),
});
export type EvidenceReading = z.infer<typeof EvidenceReading>;

export const DraftSchema = z.object({
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  evidence: z.array(z.object({ kind: z.string(), filename: z.string().optional(), text: z.string().optional() })).default([]),
  repair_date: z.string().optional(), submit_date: z.string().optional(),
});
export const VerifyInput = z.object({ agency_id: z.uuid(), order_id: z.uuid().optional(), draft: DraftSchema, customer_names: z.array(z.string()).default([]), today: z.string().optional() });
export type VerifyInput = z.infer<typeof VerifyInput>;

export interface VerifyResult { id: string; findings: Finding[]; blocked: boolean; rule_versions: Array<{ rule_id: string; rule_key: string; version: number }>; reading: EvidenceReading | null }

export async function verifyDraft(tenant: Tenant, raw: unknown, llm: LlmClient): Promise<VerifyResult> {
  const inp = VerifyInput.parse(raw);
  const today = inp.today ?? new Date().toISOString().slice(0, 10);
  return withTenant(tenant, async c => {
    const ag = await c.query('select brand_id from agencies where id=$1', [inp.agency_id]);
    if (!ag.rowCount) throw new Error('agencia no existe en el grupo');
    const brandId = ag.rows[0].brand_id;

    // Todo lo que toca al modelo o se guarda va redactado.
    const names = inp.customer_names;
    const safe: Draft = {
      fields: redactFields(inp.draft.fields, { knownNames: names }) as Draft['fields'],
      evidence: inp.draft.evidence.map(e => ({ ...e, text: e.text ? redact(e.text, { knownNames: names }).text : undefined })),
      repair_date: inp.draft.repair_date, submit_date: inp.draft.submit_date,
    };

    const rules = (await c.query(
      `select id, rule_key, version, kind, title, severity, condition from rules
        where brand_id=$1 and loop=1 and status='active'
          and (valid_from is null or valid_from <= $2::date) and (valid_to is null or valid_to >= $2::date)
        order by rule_key`, [brandId, today])).rows as RuleRow[];

    const prior: PriorPrea[] = (await c.query(
      `select o.id order_id, o.order_number, o.vin, o.claim_date::text claim_date, v.fields
         from orders o join lateral (select fields from prea_versions where order_id=o.id order by version_no desc limit 1) v on true
        where o.brand_id=$1`, [brandId])).rows;

    // Agente lector de evidencia: extrae y detecta faltantes. Si falla, el checklist sigue funcionando.
    let reading: EvidenceReading | null = null;
    const requiredKinds = [...new Set(rules.filter(r => r.condition.type === 'required_evidence').map(r => r.condition.evidence_kind as string))];
    if (safe.evidence.length || requiredKinds.length) {
      try {
        const r = await llm.run('evidence-reader', 'evidence-reader.v1.md', { fields: safe.fields, evidence: safe.evidence, required_kinds: requiredKinds }, EvidenceReading);
        reading = r.output;
        await c.query(
          `insert into llm_calls(group_id,order_id,agent,model,prompt_hash,input_tokens,output_tokens,cost_usd) values ($1,$2,'evidence-reader',$3,$4,$5,$6,$7)`,
          [tenant.groupId, inp.order_id ?? null, r.usage.model, r.usage.promptHash, r.usage.inputTokens, r.usage.outputTokens, r.usage.costUsd]);
      } catch { reading = null; }
    }

    const findings = runChecklist(rules, safe, { today, prior, detectedKinds: new Set(reading?.evidence_detected ?? []), currentOrderId: inp.order_id });
    if (reading) {
      for (const m of reading.missing) {
        if (findings.some(f => f.field === m.kind)) continue;
        findings.push({ key: `evidence_reader:missing:${m.kind}`, source: 'evidence_reader', rule_id: null, rule_key: null, rule_version: null, severity: 'warning', message: `Evidencia posiblemente faltante "${m.kind}": ${m.reason}`, field: m.kind });
      }
      for (const n of reading.notes) findings.push({ key: `evidence_reader:note:${n.slice(0, 40)}`, source: 'evidence_reader', rule_id: null, rule_key: null, rule_version: null, severity: 'info', message: n });
    }

    const used = [...new Map(findings.filter(f => f.rule_id).map(f => [f.rule_id!, { rule_id: f.rule_id!, rule_key: f.rule_key!, version: f.rule_version! }])).values()];
    const ins = await c.query(
      `insert into verifications(group_id,agency_id,order_id,created_by,draft,findings,rule_versions) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [tenant.groupId, inp.agency_id, inp.order_id ?? null, tenant.userId ?? null, JSON.stringify(safe), JSON.stringify(findings), JSON.stringify(used)]);
    await c.query(`insert into events(group_id,agency_id,type,action,payload) values ($1,$2,'prea','verified',$3)`,
      [tenant.groupId, inp.agency_id, JSON.stringify({ verification_id: ins.rows[0].id, findings: findings.length })]);
    return { id: ins.rows[0].id, findings, blocked: findings.some(f => f.severity === 'blocker'), rule_versions: used, reading };
  });
}

export const OverrideInput = z.object({ finding_key: z.string().min(1), reason: z.string().trim().min(5, 'la razón es obligatoria') });
export async function ignoreFinding(tenant: Tenant, verificationId: string, raw: unknown) {
  const o = OverrideInput.parse(raw);
  return withTenant(tenant, async c => {
    const v = await c.query('select agency_id, findings from verifications where id=$1', [verificationId]);
    if (!v.rowCount) throw new Error('verificación no encontrada');
    const f = (v.rows[0].findings as Finding[]).find(x => x.key === o.finding_key);
    if (!f) throw new Error('hallazgo no existe en esta verificación');
    const r = await c.query(`insert into finding_overrides(group_id,verification_id,rule_id,finding_key,reason,user_id) values ($1,$2,$3,$4,$5,$6) returning id`,
      [tenant.groupId, verificationId, f.rule_id, o.finding_key, o.reason, tenant.userId ?? null]);
    await c.query(`insert into audit_log(group_id,actor_id,actor_role,action,entity,entity_id,data) values ($1,$2,$3,'finding.ignored','verifications',$4,$5)`,
      [tenant.groupId, tenant.userId ?? null, tenant.role ?? null, verificationId, JSON.stringify({ finding_key: o.finding_key, rule_key: f.rule_key })]);
    await c.query(`insert into events(group_id,agency_id,type,action,payload) values ($1,$2,'prea','finding_ignored',$3)`, [tenant.groupId, v.rows[0].agency_id, JSON.stringify({ verification_id: verificationId, finding_key: o.finding_key })]);
    return { id: r.rows[0].id };
  });
}
