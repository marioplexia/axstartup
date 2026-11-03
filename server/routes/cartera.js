'use strict';
// Agente de Cartera: piezas instaladas y cobradas a la planta, saldos por recuperar.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

const DAY = 864e5;
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const scope = user => user.role === 'admin' ? { sql: '', args: [] } : { sql: ' AND c.agency_id = ?', args: [user.agency.id] };
const dias = c => c.paid_at ? null : Math.max(0, Math.floor((Date.now() - c.billed_at) / DAY));
const estado = c => c.paid_at ? 'pagado' : (dias(c) > 60 ? 'vencido' : 'por_cobrar');
const BUCKETS = [['0-15', 0, 15], ['16-30', 16, 30], ['31-60', 31, 60], ['+60', 61, 1e9]];
const sel = `SELECT c.*, (SELECT COUNT(*) FROM cobro_comments k WHERE k.cobro_id = c.id) AS comentarios FROM cobros c WHERE 1=1`;
const out = c => ({ id: c.id, orden: c.order_id, folio: c.folio, concepto: c.concept, instalacion: c.installed_at, cobro: c.billed_at, piezas: c.parts_amount, total: c.total, dias: dias(c), estado: estado(c), pagado_el: c.paid_at, comentarios: c.comentarios || 0 });
const shortAgency = n => String(n || '').replace(/^chevrolet\s+/i, '').toUpperCase();

function resumen(rows) {
  const open = rows.filter(c => !c.paid_at), paid = rows.filter(c => c.paid_at);
  const sum = (a, k) => a.reduce((s, c) => s + c[k], 0);
  const total = sum(rows, 'total');
  return {
    piezas_instaladas: +sum(rows.filter(c => c.installed_at), 'parts_amount').toFixed(2),
    cartera_total: +total.toFixed(2), por_cobrar: +sum(open, 'total').toFixed(2), recuperado: +sum(paid, 'total').toFixed(2),
    pct_recuperacion: total ? +(100 * sum(paid, 'total') / total).toFixed(1) : 0, abiertos: open.length,
    antiguedad: BUCKETS.map(([k, a, b]) => { const g = open.filter(c => { const d = dias(c); return d >= a && d <= b; }); return { k, monto: +sum(g, 'total').toFixed(2), n: g.length }; })
  };
}

router.get('/cartera', (req, res) => {
  const sc = scope(req.user);
  const all = db.prepare(sel + sc.sql + ' ORDER BY c.billed_at ASC, c.id ASC').all(...sc.args);
  let items = all;
  const e = clean(req.query.estado, 12);
  if (e) items = items.filter(c => estado(c) === e || (e === 'abierto' && !c.paid_at));
  const q = clean(req.query.q, 60).toLowerCase();
  if (q) items = items.filter(c => (c.folio + ' ' + c.concept).toLowerCase().includes(q));
  res.json({ ...resumen(all), items: items.map(out), total: all.length });
});

router.post('/cartera/:id/pago', (req, res) => {
  const sc = scope(req.user), c = db.prepare(sel + ' AND c.id = ?' + sc.sql).get(req.params.id, ...sc.args);
  if (!c) return res.status(404).json({ error: 'Cobro no encontrado.' });
  const pagado = !!(req.body && req.body.pagado);
  const ord = c.order_id && db.prepare('SELECT * FROM orders WHERE id = ?').get(c.order_id);
  if (ord) require('../closing').setCobrado(ord, pagado, req.user.id);
  else db.prepare('UPDATE cobros SET paid_at = ? WHERE id = ?').run(pagado ? Date.now() : null, c.id);
  db.prepare('INSERT INTO cobro_comments (cobro_id, advisor_id, text, created_at) VALUES (?,?,?,?)').run(c.id, req.user.id, pagado ? 'Pago registrado.' : 'Cobro reabierto.', Date.now());
  res.json(out(db.prepare(sel + ' AND c.id = ?').get(c.id)));
});

router.get('/cartera/:id/comentarios', (req, res) => {
  const sc = scope(req.user), c = db.prepare(sel + ' AND c.id = ?' + sc.sql).get(req.params.id, ...sc.args);
  if (!c) return res.status(404).json({ error: 'Cobro no encontrado.' });
  res.json({ cobro: out(c), comentarios: db.prepare('SELECT k.id, k.text AS texto, k.created_at AS ts, IFNULL(a.name, \'Sistema\') AS autor FROM cobro_comments k LEFT JOIN advisors a ON a.id = k.advisor_id WHERE k.cobro_id = ? ORDER BY k.id').all(c.id) });
});
router.post('/cartera/:id/comentarios', (req, res) => {
  const sc = scope(req.user), c = db.prepare(sel + ' AND c.id = ?' + sc.sql).get(req.params.id, ...sc.args);
  if (!c) return res.status(404).json({ error: 'Cobro no encontrado.' });
  const t = clean(req.body && req.body.texto, 500);
  if (!t) return res.status(400).json({ error: 'Escribe el comentario.' });
  db.prepare('INSERT INTO cobro_comments (cobro_id, advisor_id, text, created_at) VALUES (?,?,?,?)').run(c.id, req.user.id, t, Date.now());
  res.status(201).json({ ok: true, comentarios: db.prepare('SELECT COUNT(*) n FROM cobro_comments WHERE cobro_id = ?').get(c.id).n });
});

// Pestaña «Agente»: lectura de la cartera y acciones sugeridas
router.get('/cartera/agente', (req, res) => {
  const sc = scope(req.user), all = db.prepare(sel + sc.sql + ' ORDER BY c.billed_at ASC').all(...sc.args), r = resumen(all);
  const open = all.filter(c => !c.paid_at).sort((a, b) => a.billed_at - b.billed_at);
  const money = n => '$' + Math.round(n).toLocaleString('en-US');
  const acciones = open.slice(0, 8).map(c => {
    const d = dias(c);
    return { id: c.id, folio: c.folio, dias: d, total: c.total, prioridad: d > 60 ? 'alta' : d > 30 ? 'media' : 'baja',
      texto: d > 60 ? `Escala el cobro de ${c.folio} con la planta: lleva ${d} días abierto.` : d > 30 ? `Da seguimiento a ${c.folio}: ${d} días sin pago.` : d > 15 ? `Recuerda a la planta el pago de ${c.folio} (${d} días).` : `${c.folio} va en tiempo (${d} días). Sin acción por ahora.` };
  });
  const viejo = open[0];
  res.json({
    resumen: open.length
      ? `Tienes **${open.length} ${open.length === 1 ? 'cobro abierto' : 'cobros abiertos'}** por **${money(r.por_cobrar)}**. ` + (viejo ? `El más antiguo es **${viejo.folio}** con **${dias(viejo)} días**. ` : '') + `Has recuperado **${r.pct_recuperacion}%** de la cartera (${money(r.recuperado)} de ${money(r.cartera_total)}).`
      : `No tienes saldos abiertos. Recuperaste **${r.pct_recuperacion}%** de la cartera (${money(r.recuperado)}).`,
    acciones, antiguedad: r.antiguedad
  });
});

// Mantiene la cartera al día cuando cambia una orden (campaña realizada/cerrada, pieza en planta)
function sync(o) {
  if (!o) return;
  const ex = db.prepare('SELECT * FROM cobros WHERE order_id = ?').get(o.id), now = Date.now();
  const ag = db.prepare('SELECT name FROM agencies WHERE id = ?').get(o.agency_id), concept = `Cobro ${o.id} · ${shortAgency(ag && ag.name)}`;
  const crear = (paid) => db.prepare('INSERT INTO cobros (order_id, folio, concept, agency_id, advisor_id, installed_at, billed_at, parts_amount, total, paid_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(o.id, o.id, concept, o.agency_id, o.advisor_id, now, now, +((o.amount || 3500) * 0.35).toFixed(2), o.amount || 3500, paid ? now : null, now);
  if (o.kind === 'campana') {
    if (o.status === 'realizada' && !ex) crear(false);
    else if (o.status === 'cerrada') { if (!ex) crear(true); else if (!ex.paid_at) db.prepare('UPDATE cobros SET paid_at = ? WHERE id = ?').run(now, ex.id); }
  } else if (o.kind === 'prea' && o.status === 'aprobada' && ['en_planta', 'recibida'].includes(o.part_status) && !ex) crear(false);
}

router.sync = sync;
module.exports = router;
