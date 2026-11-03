import { z } from 'zod';

const iso = z.string().refine(s => !Number.isNaN(Date.parse(s)), 'fecha ISO inválida');
const fields = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export const LineSchema = z.object({
  concept: z.enum(['labor', 'part', 'other']),
  part_no: z.string().optional(),
  op_code: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().default(1),
  unit_price: z.number().optional(),
  hours: z.number().optional(),
  rate: z.number().optional(),
  amount_paid: z.number(),
});

export const BundleSchema = z.object({
  agency_id: z.uuid(),
  order_number: z.string().min(1),
  vin: z.string().optional(),
  odometer: z.number().int().optional(),
  claim_date: z.string().optional(),
  customer_names: z.array(z.string()).default([]),     // solo para redactar; no se guardan
  prea: z.object({
    first_submitted_at: iso.optional(),
    versions: z.array(z.object({ submitted_at: iso, fields, text: z.string().default('') })).default([]),
    current: z.object({ fields, text: z.string().default('') }).optional(),
    field_history: z.array(z.object({ at: iso, field: z.string(), from: z.union([z.string(), z.number(), z.null()]), to: z.union([z.string(), z.number(), z.null()]) })).default([]),
    comments: z.array(z.object({ author_role: z.enum(['plant', 'advisor']), author: z.string(), authored_at: iso, body: z.string() })).default([]),
  }).optional(),
  evidence: z.array(z.object({ kind: z.string(), filename: z.string(), version_no: z.number().int().min(1).default(1), sha256: z.string().optional(), text: z.string().optional() })).default([]),
  transactions: z.array(z.object({
    tx_number: z.string(),
    claim_date: z.string().optional(),
    paid_at: z.string().optional(),
    is_adjustment: z.boolean().default(false),
    lines: z.array(LineSchema).min(1),
  })).default([]),
});
export type Bundle = z.infer<typeof BundleSchema>;
