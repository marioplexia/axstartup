'use strict';
// Tablero de inicio: PREAs aprobadas, piezas en pedido, campañas y servicios, con sus listas.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

const DAY = 864e5;
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function scope(req) {                       // agencia del asesor (admin: todas) y filtro opcional por asesor
  let sql = ''; const args = [];
  if (req.user.role !== 'admin') { sql += ' AND o.agency_id = ?'; args.push(req.user.agency.id); }
  const as = clean(req.query.asesor, 40);
  if (as) { sql += ' AND o.advisor_id = ?'; args.push(as); }
  return { sql, args };
}
const addMonths = (t, n) => { const d = new Date(t); d.setMonth(d.getMonth() + n); return d.getTime(); };
function ventanaMeses(q) {
  const meses = [3, 6, 12].includes(+q.meses) ? +q.meses : 6, y = new Date().getFullYear();
  const anio = Number.isInteger(+q.anio) && +q.anio >= 2000 && +q.anio <= y ? +q.anio : y;
  const to = anio < y ? new Date(anio, 11, 31, 23, 59, 59, 999).getTime() : Date.now();
  const from = addMonths(to, -meses);
  return { meses, anio, from, to, pfrom: addMonths(from, -meses), pto: from - 1 };
}
function ventanaPeriodo(p) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth(), m0 = new Date(y, m, 1).getTime();
  if (p === 'mes_pasado') { const f = new Date(y, m - 1, 1).getTime(); return { p, from: f, to: m0 - 1, pfrom: new Date(y, m - 2, 1).getTime(), pto: f - 1 }; }
  if (p === '3m') { const f = new Date(y, m - 2, 1).getTime(); return { p, from: f, to: Date.now(), pfrom: new Date(y, m - 5, 1).getTime(), pto: f - 1 }; }
  return { p: 'mes', from: m0, to: Date.now(), pfrom: new Date(y, m - 1, 1).getTime(), pto: m0 - 1 };
}
const get = (sql, ...a) => db.prepare(sql).all(...a);
const like = q => '%' + clean(q, 60).toLowerCase() + '%';
const qSql = ` AND (LOWER(o.id) LIKE ? OR LOWER(IFNULL(o.customer,'')) LIKE ?)`;

function preasCount(sc, from, to) {
  const r = { aprobadas: 0, negadas: 0 };
  get(`SELECT o.status s, COUNT(*) n FROM orders o WHERE o.kind='prea' AND o.status IN ('aprobada','rechazada') AND o.resolved_at BETWEEN ? AND ?${sc.sql} GROUP BY o.status`, from, to, ...sc.args)
    .forEach(x => { if (x.s === 'aprobada') r.aprobadas = x.n; else r.negadas = x.n; });
  return r;
}
const tasa = c => (c.aprobadas + c.negadas) ? +(100 * c.aprobadas / (c.aprobadas + c.negadas)).toFixed(1) : 0;

router.get('/inicio/asesores', (req, res) => {
  const sc = scope({ user: req.user, query: {} });
  res.json(get(`SELECT DISTINCT a.id, a.name FROM orders o JOIN advisors a ON a.id = o.advisor_id WHERE 1=1${sc.sql} ORDER BY a.name`, ...sc.args));
});

/* ---- PREAs aprobadas ---- */
router.get('/inicio/preas', (req, res) => {
  const w = ventanaMeses(req.query), sc = scope(req);
  const c = preasCount(sc, w.from, w.to), p = preasCount(sc, w.pfrom, w.pto);
  res.json({ ...c, prev: p, d_aprobadas: c.aprobadas - p.aprobadas, d_negadas: c.negadas - p.negadas, tasa: tasa(c), meses: w.meses, anio: w.anio });
});
router.get('/inicio/preas/lista', (req, res) => {
  const w = ventanaMeses(req.query), sc = scope(req);
  let where = `o.kind='prea' AND o.status='aprobada' AND o.resolved_at BETWEEN ? AND ?${sc.sql}`; const args = [w.from, w.to, ...sc.args];
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${where}`).get(...args).n;
  if (clean(req.query.q, 60)) { where += qSql; args.push(like(req.query.q), like(req.query.q)); }
  const items = get(`SELECT o.id, o.kind, o.customer AS cliente, o.resolved_at AS fecha, o.amount AS monto FROM orders o WHERE ${where} ORDER BY o.resolved_at ASC LIMIT 500`, ...args);
  const c = preasCount(sc, w.from, w.to), p = preasCount(sc, w.pfrom, w.pto);
  res.json({ items, total, ...c, d_aprobadas: c.aprobadas - p.aprobadas, d_negadas: c.negadas - p.negadas, tasa: tasa(c) });
});

/* ---- Piezas en pedido ---- */
router.get('/inicio/piezas', (req, res) => {
  const w = ventanaMeses(req.query), sc = scope(req);
  const est = { en_planta: 0, pedida: 0, por_pedir: 0 };
  get(`SELECT o.part_status s, COUNT(*) n FROM orders o WHERE o.part_status IN ('en_planta','pedida','por_pedir')${sc.sql} GROUP BY o.part_status`, ...sc.args).forEach(x => { est[x.s] = x.n; });
  const span = w.to - w.from, days = Math.max(1, Math.round(span / DAY)), step = days > 200 ? 7 : 1, n = Math.ceil(days / step);
  const serie = (from, to) => {
    const arr = new Array(n).fill(0);
    get(`SELECT o.part_ordered_at t FROM orders o WHERE o.part_ordered_at BETWEEN ? AND ?${sc.sql}`, from, to, ...sc.args)
      .forEach(x => { const i = Math.min(n - 1, Math.floor((x.t - from) / DAY / step)); arr[i]++; });
    let acc = 0; return arr.map(v => (acc += v));
  };
  const marcas = []; let last = -1;
  for (let i = 0; i < n; i++) { const d = new Date(w.from + i * step * DAY), k = d.getFullYear() * 12 + d.getMonth(); if (k !== last) { marcas.push({ i, l: MESES[d.getMonth()] }); last = k; } }
  res.json({ ...est, total: est.en_planta + est.pedida + est.por_pedir, org: serie(w.from, w.to), comp: serie(w.pfrom, w.pto), marcas, n, meses: w.meses });
});
function entrega(o) {
  if (o.part_status === 'por_pedir') return 'Sin pedir';
  if (o.part_status === 'en_planta') return 'Disponible';
  const d = Math.ceil((o.due_at - Date.now()) / DAY);
  return d > 1 ? `Llega en ${d} días` : d === 1 ? 'Llega mañana' : d === 0 ? 'Llega hoy' : 'Entrega retrasada';
}
router.get('/inicio/piezas/lista', (req, res) => {
  const sc = scope(req);
  let where = `o.part_status IN ('en_planta','pedida','por_pedir')${sc.sql}`; const args = [...sc.args];
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${where}`).get(...args).n;
  if (['en_planta', 'pedida', 'por_pedir'].includes(req.query.estado)) { where += ' AND o.part_status = ?'; args.push(req.query.estado); }
  if (clean(req.query.q, 60)) { where += qSql; args.push(like(req.query.q), like(req.query.q)); }
  const rows = get(`SELECT o.id, o.kind, o.customer AS cliente, o.part AS pieza, o.part_status AS estado, o.due_at FROM orders o WHERE ${where} ORDER BY o.created_at ASC LIMIT 500`, ...args);
  const est = { en_planta: 0, pedida: 0, por_pedir: 0 };
  get(`SELECT o.part_status s, COUNT(*) n FROM orders o WHERE o.part_status IN ('en_planta','pedida','por_pedir')${sc.sql} GROUP BY o.part_status`, ...sc.args).forEach(x => { est[x.s] = x.n; });
  res.json({ items: rows.map(o => ({ ...o, entrega: entrega({ part_status: o.estado, due_at: o.due_at }) })), total, ...est });
});

/* ---- Campañas ---- */
function campCount(sc, from, to) {
  const r = { total: 0, cerrada: 0, realizada: 0, pendiente: 0 };
  get(`SELECT o.status s, COUNT(*) n FROM orders o WHERE o.kind='campana' AND o.created_at BETWEEN ? AND ?${sc.sql} GROUP BY o.status`, from, to, ...sc.args)
    .forEach(x => { if (r[x.s] !== undefined) r[x.s] = x.n; r.total += x.n; });
  return r;
}
router.get('/inicio/campanas', (req, res) => {
  const w = ventanaPeriodo(req.query.periodo), sc = scope(req);
  const c = campCount(sc, w.from, w.to), p = campCount(sc, w.pfrom, w.pto);
  res.json({ ...c, prev: p, delta: c.total - p.total, periodo: w.p });
});
router.get('/inicio/campanas/lista', (req, res) => {
  const w = ventanaPeriodo(req.query.periodo), sc = scope(req);
  let where = `o.kind='campana' AND o.created_at BETWEEN ? AND ?${sc.sql}`; const args = [w.from, w.to, ...sc.args];
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${where}`).get(...args).n;
  if (['cerrada', 'realizada', 'pendiente'].includes(req.query.estado)) { where += ' AND o.status = ?'; args.push(req.query.estado); }
  if (clean(req.query.q, 60)) { where += qSql; args.push(like(req.query.q), like(req.query.q)); }
  const rows = get(`SELECT o.id, o.kind, o.customer AS cliente, o.unit AS unidad, o.status AS estado, o.due_at FROM orders o WHERE ${where} ORDER BY o.created_at ASC LIMIT 500`, ...args);
  const c = campCount(sc, w.from, w.to), p = campCount(sc, w.pfrom, w.pto);
  const detalle = o => o.estado === 'cerrada' ? 'Cobrada y realizada' : o.estado === 'realizada' ? 'Realizada, pendiente de cobro'
    : o.due_at ? (d => d > 1 ? `Programada en ${d} días` : d === 1 ? 'Programada para mañana' : 'Programada para hoy')(Math.ceil((o.due_at - Date.now()) / DAY)) : 'Por programar';
  res.json({ items: rows.map(o => ({ ...o, detalle: detalle(o) })), total, ...c, delta: c.total - p.total });
});

/* ---- Servicios realizados ---- */
function svcRows(sc, from, to) {
  return get(`SELECT IFNULL(o.svc_type,'Otros') tipo, COUNT(*) n, IFNULL(SUM(o.amount),0) monto FROM orders o WHERE o.kind='servicio' AND o.status='pagada' AND o.created_at BETWEEN ? AND ?${sc.sql} GROUP BY tipo ORDER BY n DESC, tipo`, from, to, ...sc.args);
}
router.get('/inicio/servicios', (req, res) => {
  const w = ventanaPeriodo(req.query.periodo), sc = scope(req);
  const cur = svcRows(sc, w.from, w.to), prev = svcRows(sc, w.pfrom, w.pto), pm = Object.fromEntries(prev.map(x => [x.tipo, x.n]));
  const total = cur.reduce((s, x) => s + x.n, 0), ptotal = prev.reduce((s, x) => s + x.n, 0);
  res.json({ total, delta: total - ptotal, monto: cur.reduce((s, x) => s + x.monto, 0), tipos: cur.map(x => ({ tipo: x.tipo, n: x.n, prev: pm[x.tipo] || 0 })), periodo: w.p });
});
router.get('/inicio/servicios/lista', (req, res) => {
  const w = ventanaPeriodo(req.query.periodo), sc = scope(req);
  let where = `o.kind='servicio' AND o.status='pagada' AND o.created_at BETWEEN ? AND ?${sc.sql}`; const args = [w.from, w.to, ...sc.args];
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${where}`).get(...args).n;
  const tipos = svcRows(sc, w.from, w.to);
  if (clean(req.query.tipo, 40)) { where += " AND IFNULL(o.svc_type,'Otros') = ?"; args.push(clean(req.query.tipo, 40)); }
  if (clean(req.query.q, 60)) { where += qSql; args.push(like(req.query.q), like(req.query.q)); }
  const items = get(`SELECT o.id, o.kind, o.customer AS cliente, IFNULL(o.svc_type,'Otros') AS tipo, o.created_at AS fecha, o.amount AS monto FROM orders o WHERE ${where} ORDER BY o.created_at ASC LIMIT 500`, ...args);
  const cur = tipos.reduce((s, x) => s + x.n, 0), p = svcRows(sc, w.pfrom, w.pto).reduce((s, x) => s + x.n, 0);
  res.json({ items, total, tipos: tipos.map(x => x.tipo), realizados: cur, delta: cur - p, monto: tipos.reduce((s, x) => s + x.monto, 0), top: tipos[0] ? tipos[0].tipo : null });
});

/* ---- Acciones recomendadas ---- */
router.get('/inicio/acciones', (req, res) => {
  const sc = scope(req), n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const porPedir = n(`SELECT COUNT(*) n FROM orders o WHERE o.part_status='por_pedir'${sc.sql}`, ...sc.args);
  const porCobrar = n(`SELECT COUNT(*) n FROM orders o WHERE o.kind='campana' AND o.status='realizada'${sc.sql}`, ...sc.args);
  const atencion = n(`SELECT COUNT(*) n FROM orders o WHERE o.kind='prea' AND o.status='atencion'${sc.sql}`, ...sc.args);
  const items = [
    { k: 'piezas', n: porPedir, txt: porPedir === 1 ? 'Pide la pieza de 1 PREA ya autorizada' : `Pide las piezas de ${porPedir} PREAs ya autorizadas` },
    { k: 'campanas', n: porCobrar, txt: porCobrar === 1 ? 'Cobra 1 campaña ya realizada' : `Cobra ${porCobrar} campañas ya realizadas` },
    { k: 'atencion', n: atencion, txt: atencion === 1 ? 'Revisa 1 PREA que requiere atención' : `Revisa ${atencion} PREAs que requieren atención` }
  ].filter(x => x.n > 0);
  res.json({ total: items.reduce((s, x) => s + x.n, 0), items });
});

module.exports = router;
