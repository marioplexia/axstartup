import type pg from 'pg';

export interface Case {
  order_id: string; order_number: string; agency_id: string; claim_date: string | null;
  result: 'accepted' | 'rejected'; rounds: number;
  v1: { fields: Record<string, any>; submitted_at: string | null };
  evidence_v1: string[];
}

/** Casos de aprendizaje: con resultado, ingesta limpia y NUNCA de la prueba ciega. */
export async function loadLearningCases(c: pg.PoolClient, opts: { split?: 'build' | 'blind' | 'learning' } = {}): Promise<Case[]> {
  const cond = opts.split === 'blind' ? `o.eval_split = 'blind'` : opts.split === 'build' ? `o.eval_split = 'build'` : `coalesce(o.eval_split,'build') <> 'blind'`;
  const r = await c.query(
    `select o.id order_id, o.order_number, o.agency_id, o.claim_date::text claim_date, oc.result, oc.rounds,
            v.fields, v.submitted_at,
            coalesce((select array_agg(distinct e.kind) from evidence_files e where e.order_id=o.id and e.version_no=1), '{}') evidence_v1
       from orders o
       join outcomes oc on oc.order_id=o.id
       join lateral (select fields, submitted_at from prea_versions where order_id=o.id and version_no=1) v on true
      where o.ingest_status='ok' and ${cond}
      order by o.claim_date, o.order_number`);
  return r.rows.map(x => ({ order_id: x.order_id, order_number: x.order_number, agency_id: x.agency_id, claim_date: x.claim_date, result: x.result, rounds: x.rounds,
    v1: { fields: x.fields, submitted_at: x.submitted_at ? new Date(x.submitted_at).toISOString() : null }, evidence_v1: x.evidence_v1 }));
}
