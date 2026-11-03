'use strict';
// Una orden se considera CERRADA solo cuando se marca como cobrada (en Expedientes o al pagar el cobro en Cartera).
const { db } = require('./db');

const CERRABLES = { prea: ['aprobada'], servicio: ['pagada'], campana: ['realizada', 'cerrada'] };
const puedeCobrar = o => (CERRABLES[o.kind] || []).includes(o.status);
const shortAgency = n => String(n || '').replace(/^chevrolet\s+/i, '').toUpperCase();

function setCobrado(o, cobrado, userId) {
  const now = Date.now();
  const ex = db.prepare('SELECT * FROM cobros WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(o.id);
  if (cobrado) {
    if (o.kind !== 'servicio') {
      if (ex) { if (!ex.paid_at) db.prepare('UPDATE cobros SET paid_at = ? WHERE id = ?').run(now, ex.id); }
      else {
        const ag = db.prepare('SELECT name FROM agencies WHERE id = ?').get(o.agency_id), total = o.amount || 3500;
        db.prepare('INSERT INTO cobros (order_id, folio, concept, agency_id, advisor_id, installed_at, billed_at, parts_amount, total, paid_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(o.id, o.id, `Cobro ${o.id} · ${shortAgency(ag && ag.name)}`, o.agency_id, o.advisor_id, now, now, +(total * 0.35).toFixed(2), total, now, now);
      }
    }
    const st = o.kind === 'campana' ? 'cerrada' : o.status;
    db.prepare('UPDATE orders SET closed_at = ?, status = ?, resolved_at = IFNULL(resolved_at, ?), updated_at = ? WHERE id = ?').run(o.closed_at || now, st, now, now, o.id);
  } else {
    if (ex && ex.paid_at) db.prepare('UPDATE cobros SET paid_at = NULL WHERE id = ?').run(ex.id);
    const st = o.kind === 'campana' && o.status === 'cerrada' ? 'realizada' : o.status;
    db.prepare('UPDATE orders SET closed_at = NULL, status = ?, updated_at = ? WHERE id = ?').run(st, now, o.id);
  }
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
}

module.exports = { setCobrado, puedeCobrar };
