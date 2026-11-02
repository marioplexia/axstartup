/** Lista de verificación determinista (bucle 1). Cada hallazgo apunta a la regla que lo generó. */
export interface RuleRow { id: string; rule_key: string; version: number; kind: string; title: string; severity: 'info' | 'warning' | 'blocker'; condition: any }
export interface Draft {
  fields: Record<string, string | number | null | undefined>;
  evidence: Array<{ kind: string; filename?: string; text?: string }>;
  repair_date?: string; submit_date?: string;
}
export interface Finding {
  key: string; source: 'checklist' | 'evidence_reader'; rule_id: string | null; rule_key: string | null; rule_version: number | null;
  severity: 'info' | 'warning' | 'blocker'; message: string; field?: string;
}
export interface PriorPrea { order_id: string; order_number: string; vin: string | null; fields: Record<string, any>; claim_date: string | null }

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function matches(when: any, d: Draft): boolean {
  if (!when) return true;
  const v = d.fields[when.field];
  if ('equals' in when) return String(v ?? '') === String(when.equals);
  if (when.in) return when.in.map(String).includes(String(v ?? ''));
  if (when.prefix) return String(v ?? '').startsWith(when.prefix);
  if (when.contains) return String(v ?? '').toLowerCase().includes(String(when.contains).toLowerCase());
  return true;
}
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

export function runChecklist(rules: RuleRow[], d: Draft, opts: { today: string; prior?: PriorPrea[]; detectedKinds?: Set<string>; currentOrderId?: string }): Finding[] {
  const out: Finding[] = [];
  const mk = (r: RuleRow, message: string, field?: string): Finding => ({
    key: `${r.rule_key}${field ? ':' + field : ''}`, source: 'checklist', rule_id: r.id, rule_key: r.rule_key, rule_version: r.version, severity: r.severity, message, field });
  for (const r of rules) {
    const cond = r.condition;
    if (!matches(cond.when, d)) continue;
    switch (cond.type) {
      case 'required_field':
        if (blank(d.fields[cond.field])) out.push(mk(r, `Falta el campo "${cond.field}". ${r.title}`, cond.field));
        break;
      case 'required_evidence': {
        const have = new Set([...d.evidence.map(e => e.kind), ...(opts.detectedKinds ?? [])]);
        if (!have.has(cond.evidence_kind)) out.push(mk(r, `Falta evidencia "${cond.evidence_kind}". ${r.title}`, cond.evidence_kind));
        break;
      }
      case 'deadline': {
        const from = d.repair_date, to = d.submit_date ?? opts.today;
        if (from && days(from, to) > cond.max_days) out.push(mk(r, `Plazo excedido: ${days(from, to)} días entre reparación y envío (máximo ${cond.max_days}). ${r.title}`));
        break;
      }
      case 'duplicate': {
        const keys: string[] = cond.keys ?? ['vin', 'work_op'];
        const dup = (opts.prior ?? []).find(p => p.order_id !== opts.currentOrderId &&
          keys.every(k => !blank(d.fields[k]) && String(k === 'vin' ? (p.vin ?? p.fields.vin) : p.fields[k]) === String(d.fields[k])) &&
          (!cond.window_days || !p.claim_date || days(p.claim_date, d.submit_date ?? opts.today) <= cond.window_days));
        if (dup) out.push(mk(r, `Posible duplicado de la orden ${dup.order_number} (${keys.join(' + ')}). ${r.title}`));
        break;
      }
      case 'code_pair': {
        const v = d.fields[cond.then.field];
        if (!blank(v) && cond.then.in && !cond.then.in.map(String).includes(String(v))) out.push(mk(r, `"${cond.then.field}" = ${v} no es consistente con ${cond.if?.field ?? 'el caso'}. ${r.title}`, cond.then.field));
        break;
      }
    }
  }
  return out;
}
