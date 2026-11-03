import type pg from 'pg';
import { withTenant, type Tenant } from '../db/pool.js';
import { BundleSchema, type Bundle } from './schema.js';
import { redact, redactFields, hashRef, sha } from '../redact/index.js';

type Fields = Record<string, string | number | null>;
export interface IngestResult {
  orderId: string; orderCreated: boolean;
  versions: { inserted: number; skipped: number };
  comments: { inserted: number; skipped: number };
  transactions: { inserted: number; skipped: number };
  anomalies: string[]; needsReview: boolean;
}

const stableJson = (o: unknown): string => JSON.stringify(o, (_k, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

/** Reconstruye la primera versión revirtiendo los cambios posteriores a first_submitted_at. */
export function reconstructFirst(current: Fields, history: NonNullable<Bundle['prea']>['field_history'], firstAt: string):
  { ok: true; fields: Fields; reverted: number } | { ok: false; reason: string } {
  const cut = Date.parse(firstAt);
  const later = history.filter(h => Date.parse(h.at) > cut).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const f: Fields = { ...current };
  for (const h of later) {
    if (f[h.field] !== h.to) return { ok: false, reason: `historial inconsistente en "${h.field}"` };
    f[h.field] = h.from;
  }
  return { ok: true, fields: f, reverted: later.length };
}

export async function ingestOrder(tenant: Tenant, raw: unknown): Promise<IngestResult> {
  const b = BundleSchema.parse(raw);
  return withTenant(tenant, async c => {
    const anomalies: string[] = [];
    const note = async (kind: string, detail: object) => {
      const d = JSON.stringify(detail);
      const ex = await c.query(`select 1 from ingest_anomalies where agency_id=$1 and order_number=$2 and kind=$3 and detail=$4::jsonb`, [b.agency_id, b.order_number, kind, d]);
      if (!ex.rowCount) await c.query(`insert into ingest_anomalies(group_id,agency_id,order_number,kind,detail) values ($1,$2,$3,$4,$5)`, [tenant.groupId, b.agency_id, b.order_number, kind, d]);
      anomalies.push(kind);
    };

    const ag = await c.query('select brand_id from agencies where id=$1', [b.agency_id]);
    if (!ag.rowCount) throw new Error('agencia no existe en el grupo');
    const names = b.customer_names;

    const o = await c.query(
      `insert into orders(group_id,agency_id,brand_id,order_number,vin,odometer,claim_date)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (agency_id,order_number) do nothing returning id`,
      [tenant.groupId, b.agency_id, ag.rows[0].brand_id, b.order_number, b.vin ?? null, b.odometer ?? null, b.claim_date ?? null]);
    const orderCreated = !!o.rowCount;
    const orderId: string = orderCreated ? o.rows[0].id : (await c.query('select id from orders where agency_id=$1 and order_number=$2', [b.agency_id, b.order_number])).rows[0].id;
    const res: IngestResult = { orderId, orderCreated, versions: { inserted: 0, skipped: 0 }, comments: { inserted: 0, skipped: 0 }, transactions: { inserted: 0, skipped: 0 }, anomalies, needsReview: false };

    // ---------- PREA ----------
    const prea = b.prea;
    type V = { submitted_at: string | null; fields: Fields; text: string; source: 'submitted' | 'reconstructed' };
    let versions: V[] = [];
    if (!prea || (!prea.versions.length && !prea.current)) {
      await note('missing_prea', {});
    } else {
      const seen = new Set<string>();
      const known = [...prea.versions].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
      for (const v of known) {
        const h = sha(stableJson(v.fields));
        if (seen.has(h)) { await note('duplicate_prea', { submitted_at: v.submitted_at, fields_hash: h }); continue; }
        seen.add(h);
        versions.push({ submitted_at: v.submitted_at, fields: v.fields as Fields, text: v.text, source: 'submitted' });
      }
      if (!versions.length && prea.current) {
        const cur = prea.current.fields as Fields;
        if (prea.first_submitted_at && prea.field_history.length) {
          const r = reconstructFirst(cur, prea.field_history, prea.first_submitted_at);
          if (r.ok) {
            if (r.reverted > 0) {
              versions.push({ submitted_at: prea.first_submitted_at, fields: r.fields, text: '', source: 'reconstructed' });
              versions.push({ submitted_at: null, fields: cur, text: prea.current.text, source: 'submitted' });
            } else versions.push({ submitted_at: prea.first_submitted_at, fields: cur, text: prea.current.text, source: 'submitted' });
          } else {
            await note('missing_first_version', { reason: r.reason });
            versions.push({ submitted_at: null, fields: cur, text: prea.current.text, source: 'submitted' });
          }
        } else {
          await note('missing_first_version', { reason: 'sin historial para reconstruir' });
          versions.push({ submitted_at: null, fields: cur, text: prea.current.text, source: 'submitted' });
        }
      } else if (prea.current && !seen.has(sha(stableJson(prea.current.fields)))) {
        // estado actual distinto de las versiones conocidas: versión posterior sin fecha de envío
        versions.push({ submitted_at: null, fields: prea.current.fields as Fields, text: prea.current.text, source: 'submitted' });
      }
      for (const [i, v] of versions.entries()) {
        const r = await c.query(
          `insert into prea_versions(group_id,order_id,version_no,submitted_at,fields,text_redacted,source)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict (order_id,version_no) do nothing`,
          [tenant.groupId, orderId, i + 1, v.submitted_at, JSON.stringify(redactFields(v.fields, { knownNames: names })), redact(v.text, { knownNames: names }).text, v.source]);
        r.rowCount ? res.versions.inserted++ : res.versions.skipped++;
      }
      for (const m of prea.comments) {
        const body = redact(m.body, { knownNames: [...names, m.author] }).text;
        const ch = sha([m.author_role, new Date(m.authored_at).toISOString(), body].join('|'));
        const r = await c.query(
          `insert into prea_comments(group_id,order_id,author_role,author_ref,authored_at,body_redacted,content_hash)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict (order_id,content_hash) do nothing`,
          [tenant.groupId, orderId, m.author_role, hashRef(m.author), m.authored_at, body, ch]);
        r.rowCount ? res.comments.inserted++ : res.comments.skipped++;
      }
    }

    for (const e of b.evidence) {
      const r = await c.query(
        `insert into evidence_files(group_id,order_id,kind,filename,version_no,sha256,extracted) values ($1,$2,$3,$4,$5,$6,$7) on conflict (order_id,kind,filename,version_no) do nothing`,
        [tenant.groupId, orderId, e.kind, e.filename, e.version_no, e.sha256 ?? null, e.text ? JSON.stringify({ text: redact(e.text, { knownNames: names }).text }) : null]);
      void r;
    }

    // ---------- Transacciones ----------
    if (!b.transactions.length) await note('missing_transaction', {});
    const seenTx = new Set<string>();
    for (const t of b.transactions) {
      if (seenTx.has(t.tx_number)) { await note('duplicate_transaction', { tx_number: t.tx_number }); continue; }
      seenTx.add(t.tx_number);
      const total = +t.lines.reduce((a, l) => a + l.amount_paid, 0).toFixed(2);
      const ins = await c.query(
        `insert into transactions(group_id,order_id,tx_number,claim_date,paid_at,total_paid,is_adjustment)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (order_id,tx_number) do nothing returning id`,
        [tenant.groupId, orderId, t.tx_number, t.claim_date ?? null, t.paid_at ?? null, total, t.is_adjustment]);
      if (!ins.rowCount) {
        res.transactions.skipped++;
        const ex = await c.query('select id,total_paid from transactions where order_id=$1 and tx_number=$2', [orderId, t.tx_number]);
        if (Number(ex.rows[0].total_paid) !== total) await note('conflicting_reingest', { tx_number: t.tx_number, stored_total: Number(ex.rows[0].total_paid), incoming_total: total });
        continue;
      }
      res.transactions.inserted++;
      for (const [i, l] of t.lines.entries())
        await c.query(
          `insert into transaction_lines(group_id,transaction_id,line_no,concept,part_no,op_code,description,quantity,unit_price,hours,rate,amount_paid)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [tenant.groupId, ins.rows[0].id, i + 1, l.concept, l.part_no ?? null, l.op_code ?? null, l.description ? redact(l.description, { knownNames: names }).text : null, l.quantity, l.unit_price ?? null, l.hours ?? null, l.rate ?? null, l.amount_paid]);
    }
    const totalTx = (await c.query('select count(*)::int n, count(*) filter (where is_adjustment)::int adj from transactions where order_id=$1', [orderId])).rows[0];
    if (totalTx.n > 1) await note(totalTx.adj ? 'later_adjustment' : 'duplicate_transaction', { transactions: totalTx.n, adjustments: totalTx.adj });

    // ---------- Estado ----------
    const bad = (await c.query(`select count(*)::int n from ingest_anomalies where agency_id=$1 and order_number=$2`, [b.agency_id, b.order_number])).rows[0].n > 0;
    res.needsReview = bad;
    await c.query('update orders set ingest_status=$2 where id=$1', [orderId, bad ? 'needs_review' : 'ok']);

    const changed = orderCreated || res.versions.inserted + res.comments.inserted + res.transactions.inserted > 0;
    if (changed) {
      await c.query(`insert into audit_log(group_id,actor_id,actor_role,action,entity,entity_id,data) values ($1,$2,$3,'order.ingest','orders',$4,$5)`,
        [tenant.groupId, tenant.userId ?? null, tenant.role ?? null, orderId, JSON.stringify({ order_number: b.order_number, versions: res.versions.inserted, comments: res.comments.inserted, transactions: res.transactions.inserted, anomalies: [...new Set(anomalies)] })]);
      await c.query(`insert into events(group_id,agency_id,type,action,payload) values ($1,$2,'prea','ingested',$3)`, [tenant.groupId, b.agency_id, JSON.stringify({ order_id: orderId, order_number: b.order_number })]);
    }
    return res;
  });
}
