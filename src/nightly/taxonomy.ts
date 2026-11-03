import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const Cause = z.object({
  code: z.string(), label: z.string(), description: z.string(), keywords: z.array(z.string()).default([]),
  rule: z.object({ kind: z.enum(['required_evidence', 'required_field', 'deadline', 'duplicate']), severity: z.enum(['info', 'warning', 'blocker']).default('warning'),
    evidence_kind: z.string().optional(), keys: z.array(z.string()).optional(), window_days: z.number().optional() }).optional(),
});
export const Taxonomy = z.object({ version: z.number().int(), causes: z.array(Cause).min(1) });
export type Taxonomy = z.infer<typeof Taxonomy>;

export function loadTaxonomy(file = path.resolve(import.meta.dirname, '../../taxonomy/rejection-causes.yaml')): Taxonomy {
  const t = Taxonomy.parse(parse(fs.readFileSync(file, 'utf8')));
  if (!t.causes.some(c => c.code === 'otro')) throw new Error('la taxonomía debe incluir la causa "otro"');
  return t;
}
