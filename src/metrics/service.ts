import { withTenant, type Tenant } from '../db/pool.js';
import { computeMetrics, type OutcomeRow } from './compute.js';

export async function loadOutcomeRows(tenant: Tenant, opts: { from?: string; to?: string; agencyId?: string } = {}): Promise<OutcomeRow[]> {
  return withTenant(tenant, async c => (await c.query(
    `select o.agency_id, o.order_id, o.result, o.rounds, o.days_to_acceptance::float days_to_acceptance, o.estimate_error,
            (o.accepted_at is not null and o.total_paid is not null and o.paid_by_concept <> '{}'::jsonb
              and (o.accepted_at at time zone 'America/Mexico_City')::date = (o.created_at at time zone 'America/Mexico_City')::date) complete_same_day,
            coalesce((select sum(cost_usd) from llm_calls l where l.order_id=o.order_id),0)::float llm_cost_usd,
            coalesce((select sum(input_tokens+output_tokens) from llm_calls l where l.order_id=o.order_id),0)::int llm_tokens
       from outcomes o
      where ($1::date is null or coalesce(o.accepted_at, o.created_at)::date >= $1::date)
        and ($2::date is null or coalesce(o.accepted_at, o.created_at)::date <= $2::date)
        and ($3::uuid is null or o.agency_id = $3::uuid)`, [opts.from ?? null, opts.to ?? null, opts.agencyId ?? null])).rows as OutcomeRow[]);
}

/** Métricas por marca y por agencia. Un asesor solo ve su agencia. */
export async function getMetrics(tenant: Tenant & { agencyId?: string }, opts: { from?: string; to?: string; agencyId?: string } = {}) {
  const scoped = tenant.role === 'advisor' ? tenant.agencyId : opts.agencyId;
  const rows = await loadOutcomeRows(tenant, { ...opts, agencyId: scoped });
  const names = await withTenant(tenant, async c => (await c.query('select id, name from agencies order by name')).rows as Array<{ id: string; name: string }>);
  const byAgency = names.filter(a => !scoped || a.id === scoped).map(a => ({ agency_id: a.id, agency: a.name, ...computeMetrics(rows.filter(r => r.agency_id === a.id)) }));
  return { period: { from: opts.from ?? null, to: opts.to ?? null }, brand: tenant.role === 'advisor' ? undefined : computeMetrics(rows), agencies: byAgency };
}
