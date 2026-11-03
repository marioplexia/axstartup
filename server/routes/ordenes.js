'use strict';
// Bitácora de órdenes (PREAs, servicios y campañas) y su desempeño.
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

const DAY = 864e5;
const TPU_DIAS = 8;                                  // tiempo por unidad: registro → aprobación
const STATUS = {
  prea:     ['preaprobada', 'aprobada', 'rechazada', 'atencion'],
  servicio: ['pendiente', 'pagada', 'atencion'],
  campana:  ['pendiente', 'realizada', 'cerrada', 'rechazada', 'atencion']
};
const RESUELTOS = ['aprobada', 'pagada', 'realizada', 'cerrada', 'rechazada'];
const PARTES = ['por_pedir', 'pedida', 'en_planta', 'recibida'];

const sel = `SELECT o.*, a.name AS advisor_name, g.name AS agency_name
             FROM orders o LEFT JOIN advisors a ON a.id = o.advisor_id LEFT JOIN agencies g ON g.id = o.agency_id`;

function scope(user) {                               // el asesor ve su agencia; el admin ve todas
  return user.role === 'admin' ? { sql: '', args: [] } : { sql: ' AND o.agency_id = ?', args: [user.agency.id] };
}
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const folio = () => 'G-' + Array.from(crypto.randomBytes(8)).map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function tpuStats(rows) {
  const now = Date.now();
  let dentro = 0, fuera = 0, suma = 0, n = 0;
  rows.forEach(o => {
    const fin = o.resolved_at || now, dias = (fin - o.created_at) / DAY;
    if (o.resolved_at) { suma += dias; n++; }
    if (dias <= TPU_DIAS) dentro++; else fuera++;
  });
  const tot = dentro + fuera;
  return { limite: TPU_DIAS, promedio: n ? +(suma / n).toFixed(1) : 0, dentro, fuera, cumplimiento: tot ? Math.round(100 * dentro / tot) : 100 };
}

// Lista con filtros: tipo, estado, q, desde/hasta (yyyy-mm-dd), asesor
router.get('/ordenes', (req, res) => {
  const sc = scope(req.user);
  let where = 'WHERE 1=1' + sc.sql; const args = [...sc.args];
  const tipo = req.query.tipo;
  if (tipo && STATUS[tipo]) { where += ' AND o.kind = ?'; args.push(tipo); }
  if (req.query.estado) { where += ' AND o.status = ?'; args.push(String(req.query.estado)); }
  if (req.query.asesor) { where += ' AND o.advisor_id = ?'; args.push(String(req.query.asesor)); }
  if (req.query.incompletos === '1') where += ' AND o.ev_have < o.ev_need';
  const d = s => { const t = new Date(s + 'T00:00:00'); return isNaN(t) ? null : t.getTime(); };
  if (req.query.desde && d(req.query.desde) != null) { where += ' AND o.created_at >= ?'; args.push(d(req.query.desde)); }
  if (req.query.hasta && d(req.query.hasta) != null) { where += ' AND o.created_at < ?'; args.push(d(req.query.hasta) + DAY); }
  const q = clean(req.query.q, 80).toLowerCase();
  if (q) {
    where += ` AND (LOWER(o.id) LIKE ? OR LOWER(o.title) LIKE ? OR LOWER(o.detail) LIKE ? OR LOWER(IFNULL(o.vin,'')) LIKE ? OR LOWER(IFNULL(a.name,'')) LIKE ?)`;
    const l = '%' + q + '%'; args.push(l, l, l, l, l);
  }
  const items = db.prepare(sel + ' ' + where + ' ORDER BY o.created_at DESC LIMIT 500').all(...args);
  // TPU y conteos por estado del mismo tipo, sin los filtros de búsqueda
  const base = db.prepare(sel + ' WHERE o.kind = ?' + sc.sql).all(tipo && STATUS[tipo] ? tipo : 'prea', ...sc.args);
  const porEstado = {}; base.forEach(o => { porEstado[o.status] = (porEstado[o.status] || 0) + 1; });
  const asesores = db.prepare(`SELECT DISTINCT a.id, a.name FROM orders o JOIN advisors a ON a.id = o.advisor_id WHERE 1=1${sc.sql} ORDER BY a.name`).all(...sc.args);
  res.json({ items, total: items.length, tpu: tpuStats(base), porEstado, asesores });
});

router.post('/ordenes', (req, res) => {
  const b = req.body || {};
  const kind = STATUS[b.tipo] ? b.tipo : 'prea';
  const title = clean(b.titulo, 160);
  if (!title) return res.status(400).json({ error: 'Escribe un título para la orden.' });
  const monto = Math.max(0, Number(b.monto) || 0), km = Number.isFinite(Number(b.km)) ? Math.max(0, Math.round(Number(b.km))) : null;
  const now = Date.now();
  const ev = Math.max(1, Math.min(20, Math.round(Number(b.ev_need) || 5)));
  const row = {
    id: folio(), kind, status: STATUS[kind][0], title, detail: clean(b.detalle, 600),
    vin: clean(b.vin, 17) || null, km, amount: monto, rule_id: clean(b.rule_id, 20) || null,
    customer: clean(b.cliente, 80) || null, part: clean(b.pieza, 80) || null, unit: clean(b.unidad, 60) || null, svc_type: clean(b.tipo_servicio, 40) || null,
    advisor_id: req.user.id, agency_id: req.user.agency.id, ev_have: Math.max(0, Math.min(ev, Math.round(Number(b.ev_have) || 0))), ev_need: ev, created_at: now, updated_at: now
  };
  db.prepare(`INSERT INTO orders (id,kind,status,title,detail,vin,km,amount,rule_id,customer,part,unit,svc_type,advisor_id,agency_id,ev_have,ev_need,created_at,updated_at)
              VALUES (@id,@kind,@status,@title,@detail,@vin,@km,@amount,@rule_id,@customer,@part,@unit,@svc_type,@advisor_id,@agency_id,@ev_have,@ev_need,@created_at,@updated_at)`).run(row);
  res.status(201).json(db.prepare(sel + ' WHERE o.id = ?').get(row.id));
});

router.get('/ordenes/:id', (req, res) => {
  const sc = scope(req.user);
  const o = db.prepare(sel + ' WHERE o.id = ?' + sc.sql).get(req.params.id, ...sc.args);
  o ? res.json(o) : res.status(404).json({ error: 'Orden no encontrada.' });
});

router.patch('/ordenes/:id', (req, res) => {
  const sc = scope(req.user);
  const o = db.prepare(sel + ' WHERE o.id = ?' + sc.sql).get(req.params.id, ...sc.args);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada.' });
  const b = req.body || {}, now = Date.now();
  let status = o.status, resolved = o.resolved_at, ev = o.ev_have;
  if (b.status !== undefined) {
    if (!STATUS[o.kind].includes(b.status)) return res.status(400).json({ error: 'Estado no válido para este tipo de orden.' });
    status = b.status;
    resolved = RESUELTOS.includes(status) ? (o.resolved_at || now) : null;
  }
  if (b.ev_have !== undefined) {
    const n = Math.round(Number(b.ev_have));
    if (!Number.isFinite(n) || n < 0 || n > o.ev_need) return res.status(400).json({ error: 'Evidencias fuera de rango.' });
    ev = n;
  }
  let pst = o.part_status, pord = o.part_ordered_at, due = o.due_at;
  if (o.kind === 'prea' && status === 'aprobada' && o.part && !pst) pst = 'por_pedir';   // PREA autorizada: hay que pedir la pieza
  if (b.part_status !== undefined) {
    if (!o.part || !PARTES.includes(b.part_status)) return res.status(400).json({ error: 'Estado de pieza no válido.' });
    pst = b.part_status;
    if (pst === 'pedida') { pord = now; due = now + Math.max(1, Math.min(60, Math.round(Number(b.eta_dias) || 7))) * DAY; }
    else if (pst === 'en_planta') { pord = pord || now; due = now; }
    else if (pst === 'por_pedir') { pord = null; due = null; }
  }
  db.prepare('UPDATE orders SET status=?, resolved_at=?, ev_have=?, part_status=?, part_ordered_at=?, due_at=?, updated_at=? WHERE id=?').run(status, resolved, ev, pst, pord, due, now, o.id);
  const nuevo = db.prepare(sel + ' WHERE o.id = ?').get(o.id);
  try { require('./cartera').sync(nuevo); } catch (e) { console.error('cartera:', e.message); }
  res.json(nuevo);
});

// Desempeño por periodo: dia | semana | mes
router.get('/desempeno', (req, res) => {
  const periodo = ['dia', 'semana', 'mes'].includes(req.query.periodo) ? req.query.periodo : 'semana';
  const hoy = startOfDay(), dias = { dia: 1, semana: 7, mes: 30 }[periodo];
  const desde = hoy - (dias - 1) * DAY, sc = scope(req.user);
  const rows = db.prepare(sel + ' WHERE o.created_at >= ?' + sc.sql).all(desde, ...sc.args);
  const cnt = (kind, st) => rows.filter(o => o.kind === kind && (!st || (Array.isArray(st) ? st.includes(o.status) : o.status === st))).length;
  const preas = rows.filter(o => o.kind === 'prea');
  const aprob = cnt('prea', 'aprobada'), rech = cnt('prea', 'rechazada');
  const cobrosHoy = db.prepare(`SELECT IFNULL(SUM(o.amount),0) s FROM orders o WHERE o.status IN ('pagada','aprobada') AND o.resolved_at >= ?${sc.sql}`).get(hoy, ...sc.args).s;
  const cobrosServ = db.prepare(`SELECT IFNULL(SUM(o.amount),0) s FROM orders o WHERE o.kind='servicio' AND o.status='pagada' AND o.resolved_at >= ?${sc.sql}`).get(hoy, ...sc.args).s;
  const resueltas = preas.filter(o => o.resolved_at);
  const ciclo = resueltas.length ? +(resueltas.reduce((s, o) => s + (o.resolved_at - o.created_at) / DAY, 0) / resueltas.length).toFixed(1) : null;
  const conRegla = preas.filter(o => o.rule_id).length;
  const serie = [];
  if (periodo === 'dia') {
    for (let h = 0; h < 24; h++) serie.push({ k: h + ':00', n: preas.filter(o => new Date(o.created_at).getHours() === h).length });
  } else {
    for (let i = 0; i < dias; i++) {
      const t = desde + i * DAY;
      serie.push({ k: new Date(t).toISOString().slice(0, 10), n: preas.filter(o => o.created_at >= t && o.created_at < t + DAY).length });
    }
  }
  res.json({
    periodo, desde,
    preas: { total: preas.length, preaprobadas: cnt('prea', 'preaprobada'), aprobadas: aprob, rechazadas: rech, atencion: cnt('prea', 'atencion') },
    servicios: { total: cnt('servicio'), pendientes: cnt('servicio', 'pendiente'), pagados: cnt('servicio', 'pagada'), cobros_hoy: cobrosServ },
    campanas: { total: cnt('campana'), pendientes: cnt('campana', 'pendiente'), realizadas: cnt('campana', ['realizada', 'cerrada']), rechazadas: cnt('campana', 'rechazada') },
    cobros_dia: cobrosHoy,
    ciclo_promedio: ciclo,
    precision: aprob + rech ? Math.round(100 * aprob / (aprob + rech)) : null,
    cobertura_reglas: preas.length ? Math.round(100 * conRegla / preas.length) : null,
    serie
  });
});

module.exports = router;
