// Agente simulado y determinista para pruebas y demo. Imita el contrato del prompt, no el criterio del modelo.
const KEYWORDS: Array<[kind: string, re: RegExp]> = [
  ['foto', /foto|imagen/i], ['orden_reparacion', /orden de reparaci[oó]n/i],
  ['diagnostico', /diagn[oó]stico|dtc|escaneo/i], ['factura', /factura/i],
];

export function mockComplete(agent: string, input: any): unknown {
  if (agent === 'evidence-reader') {
    const ev: Array<{ kind?: string; text?: string; filename?: string }> = input.evidence ?? [];
    const all = ev.map(e => `${e.filename ?? ''} ${e.text ?? ''}`).join('\n');
    const ops = [...new Set(all.match(/\bOP-[A-Z]{2}-\d{3}\b/g) ?? [])].map(op_code => ({ op_code }));
    const parts = [...new Set(all.match(/\bPZ-[A-Z]{2}-\d{4}\b/g) ?? [])].map(part_no => ({ part_no, quantity: 1 }));
    const detected = new Set<string>(ev.map(e => e.kind).filter(Boolean) as string[]);
    for (const e of ev) for (const [k, re] of KEYWORDS) if (re.test(`${e.filename ?? ''} ${e.text ?? ''}`)) detected.add(k);
    const missing = (input.required_kinds ?? []).filter((k: string) => !detected.has(k)).map((kind: string) => ({ kind, reason: 'no se encontró en la evidencia' }));
    const declared = new Set<string>([...(input.fields?.work_op ? [String(input.fields.work_op)] : [])]);
    const notes = ops.filter(o => declared.size && !declared.has(o.op_code)).map(o => `La evidencia menciona ${o.op_code}, distinta de la operación del borrador`);
    return { concepts: { operations: ops, parts }, evidence_detected: [...detected], missing, notes: notes.slice(0, 5) };
  }
  if (agent === 'rejection-classifier') {
    const t: string = (input.comment ?? '').toLowerCase();
    const tax: Array<{ code: string; kw: string[] }> = input.taxonomy ?? [];
    const hit = tax.find(c => c.kw.some(k => t.includes(k.toLowerCase())));
    return { cause_code: hit?.code ?? 'otro', confidence: hit ? 0.9 : 0.3, evidence_kind: hit ? (input.evidence_hint ?? null) : null };
  }
  throw new Error('agente mock desconocido: ' + agent);
}
