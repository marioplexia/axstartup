import { redact, sealForModel, toModelView } from '../redact/index.js';

/** Payloads que se mandan al modelo: siempre redactados, con VIN reducido y sellados (el cliente live exige el sello). */
export function evidencePayload(fields: Record<string, unknown>, evidence: Array<{ kind: string; filename?: string; text?: string }>, requiredKinds: string[]) {
  return sealForModel({
    fields: toModelView(fields),
    evidence: evidence.map(e => ({ ...e, text: e.text ? redact(e.text).text : undefined })),
    required_kinds: requiredKinds,
  });
}
export function classifierPayload(comment: string, taxonomy: Array<{ code: string; label: string; description: string; keywords?: string[] }>) {
  return sealForModel({ comment, taxonomy: taxonomy.map(({ code, label, description, keywords }) => ({ code, label, description, keywords })) });
}
