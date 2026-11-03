'use strict';
// Consultas de solo lectura sobre las órdenes. Las usan el motor local y las herramientas del modelo.
const { db } = require('./db');

const DAY = 864e5;
const KIND = { prea: 'PREA', servicio: 'Servicio', campana: 'Campaña' };
const ESTADO = { preaprobada: 'Preaprobada', aprobada: 'Aprobada', rechazada: 'Rechazada', atencion: 'Requiere atención', pendiente: 'Pendiente', pagada: 'Pagada', realizada: 'Realizada', cerrada: 'Cerrada' };
const PIEZA = { por_pedir: 'Por pedir', pedida: 'Pedida', en_planta: 'En planta', recibida: 'Recibida' };
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const fecha = t => { const d = new Date(t), p = n => (n < 10 ? '0' : '') + n; return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; };

function scope(user, alcance) {          // el asesor ve su agencia; «mias» limita a sus propias órdenes
  let sql = '', args = [];
  if (user.role !== 'admin') { sql += ' AND o.agency_id = ?'; args.push(user.agency.id); }
  if (alcance === 'mias') { sql += ' AND o.advisor_id = ?'; args.push(user.id); }
  return { sql, args };
}
const row = (o) => ({
  orden: o.id, tipo: KIND[o.kind], estado: ESTADO[o.status] || o.status, cliente: o.customer || null, asesor: o.advisor_name || null,
  fecha: fecha(o.created_at), resuelta: o.resolved_at ? fecha(o.resolved_at) : null, monto: Math.round(o.amount || 0),
  descripcion: (o.detail || o.title || '').slice(0, 160), vin: o.vin || null, km: o.km, regla: o.rule_id || null,
  pieza: o.part || null, estado_pieza: o.part_status ? PIEZA[o.part_status] : null, llegada: o.due_at && o.part_status === 'pedida' ? fecha(o.due_at) : null,
  unidad: o.unit || null, tipo_servicio: o.svc_type || null, expediente: `${o.ev_have}/${o.ev_need}`, expediente_completo: o.ev_have >= o.ev_need
});

function buscar(user, alcance, f) {
  f = f || {};
  let where = 'WHERE 1=1', args = [];
  const sc = scope(user, alcance); where += sc.sql; args = args.concat(sc.args);
  if (f.tipo && KIND[f.tipo]) { where += ' AND o.kind = ?'; args.push(f.tipo); }
  if (f.estado) { where += ' AND o.status = ?'; args.push(f.estado); }
  if (f.estado_pieza) { where += ' AND o.part_status = ?'; args.push(f.estado_pieza); }
  if (f.con_pieza) where += " AND o.part_status IN ('por_pedir','pedida','en_planta')";
  if (f.cliente) { where += ' AND LOWER(IFNULL(o.customer,\'\')) LIKE ?'; args.push('%' + String(f.cliente).toLowerCase() + '%'); }
  if (f.texto) { where += " AND (LOWER(o.id) LIKE ? OR LOWER(o.title) LIKE ? OR LOWER(o.detail) LIKE ? OR LOWER(IFNULL(o.vin,'')) LIKE ? OR LOWER(IFNULL(o.part,'')) LIKE ?)"; const l = '%' + String(f.texto).toLowerCase() + '%'; args.push(l, l, l, l, l); }
  if (f.expediente_incompleto) where += ' AND o.ev_have < o.ev_need';
  const col = ['aprobada', 'rechazada', 'pagada', 'cerrada', 'realizada'].includes(f.estado) ? 'o.resolved_at' : 'o.created_at';   // aprobadas/pagadas: por fecha de resolución
  if (f.desde) { where += ` AND ${col} >= ?`; args.push(f.desde); }
  if (f.hasta) { where += ` AND ${col} <= ?`; args.push(f.hasta); }
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o ${where}`).get(...args).n;
  const lim = Math.max(1, Math.min(40, Number(f.limite) || 15));
  const rows = db.prepare(`SELECT o.*, a.name AS advisor_name FROM orders o LEFT JOIN advisors a ON a.id = o.advisor_id ${where} ORDER BY o.created_at DESC LIMIT ?`).all(...args, lim);
  return { total, mostradas: rows.length, ordenes: rows.map(row) };
}

function resumen(user, alcance, desde, hasta) {
  const sc = scope(user, alcance), a = [desde || 0, hasta || Date.now(), ...sc.args];
  const r = db.prepare(`SELECT o.kind, o.status, COUNT(*) n, IFNULL(SUM(o.amount),0) monto FROM orders o WHERE o.created_at BETWEEN ? AND ?${sc.sql} GROUP BY o.kind, o.status`).all(...a);
  const por = {};
  r.forEach(x => { (por[KIND[x.kind]] = por[KIND[x.kind]] || { total: 0, monto: 0, estados: {} }); const k = por[KIND[x.kind]]; k.total += x.n; k.monto += x.monto; k.estados[ESTADO[x.status] || x.status] = x.n; });
  const piezas = {};
  db.prepare(`SELECT o.part_status s, COUNT(*) n FROM orders o WHERE o.part_status IN ('por_pedir','pedida','en_planta')${sc.sql} GROUP BY o.part_status`).all(...sc.args).forEach(x => { piezas[PIEZA[x.s]] = x.n; });
  const inc = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE o.ev_have < o.ev_need${sc.sql}`).get(...sc.args).n;
  const cobrado = db.prepare(`SELECT IFNULL(SUM(o.amount),0) s FROM orders o WHERE ((o.kind='servicio' AND o.status='pagada') OR (o.kind='prea' AND o.status='aprobada')) AND o.resolved_at BETWEEN ? AND ?${sc.sql}`).get(desde || 0, hasta || Date.now(), ...sc.args).s;
  return { por_tipo: por, piezas, expedientes_incompletos: inc, monto_aprobado_o_cobrado: Math.round(cobrado) };
}

function detalle(user, alcance, id) {
  const sc = scope(user, alcance);
  const o = db.prepare(`SELECT o.*, a.name AS advisor_name FROM orders o LEFT JOIN advisors a ON a.id = o.advisor_id WHERE UPPER(o.id) = UPPER(?)${sc.sql}`).get(String(id), ...sc.args);
  return o ? row(o) : null;
}

function reglas(texto) {
  let w = '', a = [];
  if (texto) { w = 'WHERE LOWER(sys) LIKE ? OR LOWER(q_text) LIKE ? OR LOWER(op_desc) LIKE ? OR id = ?'; const l = '%' + String(texto).toLowerCase() + '%'; a = [l, l, l, String(texto).toUpperCase()]; }
  return db.prepare(`SELECT id, sys AS sistema, q_text AS queja, c_text AS causa, op, op_desc AS operacion, hours AS horas, n AS casos_aceptados, rej AS rechazos, status AS estado FROM rules ${w} ORDER BY n DESC LIMIT 12`).all(...a);
}

function tpu(user, alcance) {
  const sc = scope(user, alcance), now = Date.now();
  const res = db.prepare(`SELECT o.created_at c, o.resolved_at r FROM orders o WHERE o.kind='prea' AND o.status='aprobada' AND o.resolved_at IS NOT NULL${sc.sql}`).all(...sc.args);
  const prom = res.length ? res.reduce((s, x) => s + (x.r - x.c) / DAY, 0) / res.length : null;
  const fuera = db.prepare(`SELECT o.*, a.name AS advisor_name FROM orders o LEFT JOIN advisors a ON a.id = o.advisor_id WHERE o.kind='prea' AND o.resolved_at IS NULL AND o.created_at < ?${sc.sql} ORDER BY o.created_at ASC LIMIT 15`).all(now - 8 * DAY, ...sc.args);
  return { limite_dias: 8, ciclo_promedio_dias: prom == null ? null : +prom.toFixed(1), pendientes_fuera_de_tpu: fuera.length, ordenes: fuera.map(row) };
}

function cartera(user, alcance, minDias) {
  const sc = user.role === 'admin' ? '' : ' AND agency_id = ' + Number(user.agency.id);
  const all = db.prepare('SELECT * FROM cobros WHERE 1=1' + sc).all(), now = Date.now();
  const dias = c => Math.floor((now - c.billed_at) / DAY);
  const abiertos = all.filter(c => !c.paid_at && dias(c) >= (minDias || 0)).sort((a, b) => a.billed_at - b.billed_at);
  const tot = all.reduce((s, c) => s + c.total, 0), pag = all.filter(c => c.paid_at).reduce((s, c) => s + c.total, 0), ab = all.filter(c => !c.paid_at);
  return {
    cartera_total: Math.round(tot), recuperado: Math.round(pag), por_cobrar: Math.round(ab.reduce((s, c) => s + c.total, 0)), pct_recuperacion: tot ? +(100 * pag / tot).toFixed(1) : 0, cobros_abiertos: ab.length,
    antiguedad: [['0-15', 0, 15], ['16-30', 16, 30], ['31-60', 31, 60], ['+60', 61, 1e9]].map(([k, a, b]) => { const g = ab.filter(c => dias(c) >= a && dias(c) <= b); return { rango_dias: k, cobros: g.length, monto: Math.round(g.reduce((s, c) => s + c.total, 0)) }; }),
    abiertos: abiertos.slice(0, 25).map(c => ({ orden: c.folio, concepto: c.concept, dias: dias(c), total: Math.round(c.total), estado: dias(c) > 60 ? 'Vencido' : 'Por cobrar' })), total_abiertos_con_filtro: abiertos.length
  };
}

module.exports = { cartera, buscar, resumen, detalle, reglas, tpu, money, fecha, KIND, ESTADO, PIEZA, DAY };
