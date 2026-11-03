'use strict';
// Expedientes: archivos y evidencias de las PREAs, servicios y campañas.
// Los archivos se guardan en disco (junto a la base, en el volumen persistente) y sus datos en SQLite.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DB_PATH } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
const FILES_DIR = process.env.FILES_DIR || path.join(path.dirname(DB_PATH), 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
const MAX_BYTES = 25 * 1024 * 1024;

const SECCIONES = {
  evidencias: { corto: 'Evidencias', largo: { prea: 'Evidencias de la PREA', servicio: 'Evidencias del servicio', campana: 'Evidencias de la campaña' }, desc: 'Ticket de diagnóstico, fotos del componente, capturas GDS2.' },
  factura: { corto: 'Factura', largo: 'Factura', desc: 'Factura emitida por la reparación o el servicio.' },
  firmados: { corto: 'Documentos firmados', largo: 'Documentos firmados por el cliente', desc: 'Carta de conformidad y hoja de entrega al cierre del procedimiento.' },
  cobro: { corto: 'Cobro a planta', largo: 'Cobro a planta', desc: 'Comprobantes de cobro y pago recibido.' },
  destruccion: { corto: 'Destrucción de pieza', largo: 'Destrucción de la pieza (15 días)', desc: 'Fotografías de la pieza destruida tras el resguardo de 15 días.' }
};
const POR_TIPO = { prea: ['evidencias', 'factura', 'firmados', 'cobro', 'destruccion'], servicio: ['evidencias', 'factura', 'firmados'], campana: ['evidencias', 'firmados', 'cobro'] };
const BLOQUEADAS = /\.(exe|bat|cmd|com|scr|msi|dll|js|mjs|vbs|ps1|sh|jar|apk|app|dmg|iso|html?|svg)$/i;
const IMAGENES = /^image\/(png|jpe?g|gif|webp)$/;

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const seccionesDe = kind => (POR_TIPO[kind] || POR_TIPO.prea).map(k => ({ key: k, corto: SECCIONES[k].corto, largo: typeof SECCIONES[k].largo === 'object' ? SECCIONES[k].largo[kind] : SECCIONES[k].largo, desc: SECCIONES[k].desc }));
const scope = user => user.role === 'admin' ? { sql: '', args: [] } : { sql: ' AND o.agency_id = ?', args: [user.agency.id] };
const orden = (id, user) => { const sc = scope(user); return db.prepare('SELECT o.* FROM orders o WHERE UPPER(o.id) = UPPER(?)' + sc.sql).get(String(id), ...sc.args); };

function sync(o) {                          // ev_have/ev_need de la orden = secciones con al menos un archivo
  const sec = POR_TIPO[o.kind] || POR_TIPO.prea;
  const hechas = db.prepare('SELECT COUNT(DISTINCT section) n FROM expediente_files WHERE order_id = ?').get(o.id).n;
  db.prepare('UPDATE orders SET ev_have = ?, ev_need = ?, updated_at = ? WHERE id = ?').run(Math.min(hechas, sec.length), sec.length, Date.now(), o.id);
  return { hechas: Math.min(hechas, sec.length), total: sec.length };
}
const audit = (o, user, action, detail) => db.prepare('INSERT INTO expediente_audit (order_id, advisor_id, action, detail, created_at) VALUES (?,?,?,?,?)').run(o.id, user.id, action, detail || null, Date.now());
const fileOut = f => ({ id: f.id, nombre: f.name, mime: f.mime, size: f.size, nota: f.note, demo: !!f.demo, ts: f.created_at, autor: f.autor || null, seccion: f.section });

/* ---- Lista ---- */
router.get('/expedientes', requireAuth, (req, res) => {
  const sc = scope(req.user);
  let where = 'WHERE 1=1' + sc.sql; const args = [...sc.args];
  if (['prea', 'servicio', 'campana'].includes(req.query.tipo)) { where += ' AND o.kind = ?'; args.push(req.query.tipo); }
  const q = clean(req.query.q, 80).toLowerCase();
  if (q) { where += " AND (LOWER(o.id) LIKE ? OR LOWER(IFNULL(o.vin,'')) LIKE ? OR LOWER(IFNULL(o.customer,'')) LIKE ? OR LOWER(o.status) LIKE ? OR LOWER(o.title) LIKE ? OR LOWER(o.detail) LIKE ?)"; const l = '%' + q + '%'; args.push(l, l, l, l, l, l); }
  const rows = db.prepare(`SELECT o.*, a.name AS advisor_name,
      (SELECT COUNT(DISTINCT f.section) FROM expediente_files f WHERE f.order_id = o.id) AS hechas,
      (SELECT c.paid_at FROM cobros c WHERE c.order_id = o.id ORDER BY c.id DESC LIMIT 1) AS cobro_paid,
      (SELECT c.billed_at FROM cobros c WHERE c.order_id = o.id ORDER BY c.id DESC LIMIT 1) AS cobro_billed
    FROM orders o LEFT JOIN advisors a ON a.id = o.advisor_id ${where} ORDER BY o.created_at DESC LIMIT 400`).all(...args);
  let items = rows.map(o => {
    const total = (POR_TIPO[o.kind] || POR_TIPO.prea).length, hechas = Math.min(o.hechas, total);
    return { id: o.id, tipo: o.kind, status: o.status, cliente: o.customer, vin: o.vin, detalle: o.detail, monto: Math.round(o.amount || 0), hechas, total, asesor: o.advisor_name, creada: o.created_at,
      cobro: o.cobro_billed == null ? null : (o.cobro_paid ? 'pagado' : 'por_cobrar') };
  });
  const tot = items.length, comp = items.filter(i => i.hechas >= i.total).length;
  if (req.query.estado === 'completo') items = items.filter(i => i.hechas >= i.total);
  if (req.query.estado === 'incompleto') items = items.filter(i => i.hechas < i.total);
  res.json({ items, total: tot, completos: comp, incompletos: tot - comp });
});

/* ---- Detalle ---- */
router.get('/expedientes/:orden', requireAuth, (req, res) => {
  const o = orden(req.params.orden, req.user);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada.' });
  const files = db.prepare('SELECT f.*, a.name AS autor FROM expediente_files f LEFT JOIN advisors a ON a.id = f.advisor_id WHERE f.order_id = ? ORDER BY f.id').all(o.id);
  const secciones = seccionesDe(o.kind).map(s => { const fs_ = files.filter(f => f.section === s.key).map(fileOut); return { ...s, estado: fs_.length ? 'completo' : 'falta', archivos: fs_ }; });
  const hechas = secciones.filter(s => s.estado === 'completo').length;
  const cobro = db.prepare('SELECT billed_at, paid_at, total FROM cobros WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(o.id);
  const adv = db.prepare('SELECT name FROM advisors WHERE id = ?').get(o.advisor_id);
  res.json({
    orden: { id: o.id, tipo: o.kind, status: o.status, detalle: o.detail, titulo: o.title, vin: o.vin, km: o.km, cliente: o.customer, monto: Math.round(o.amount || 0), asesor: adv && adv.name, creada: o.created_at },
    cobro: cobro ? { estado: cobro.paid_at ? 'pagado' : 'por_cobrar', total: cobro.total, dias: cobro.paid_at ? null : Math.floor((Date.now() - cobro.billed_at) / 864e5) } : null,
    secciones, hechas, total: secciones.length, avance: Math.round(100 * hechas / secciones.length), documentos: files.length,
    auditoria: db.prepare('SELECT u.id, u.action AS accion, u.detail AS detalle, u.created_at AS ts, IFNULL(a.name, \'Sistema\') AS autor FROM expediente_audit u LEFT JOIN advisors a ON a.id = u.advisor_id WHERE u.order_id = ? ORDER BY u.id DESC LIMIT 200').all(o.id)
  });
});

/* ---- Subir (cuerpo binario; sin dependencias de multipart) ---- */
router.post('/expedientes/:orden/:seccion/archivos', requireAuth, express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), (req, res) => {
  const o = orden(req.params.orden, req.user);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada.' });
  if (!(POR_TIPO[o.kind] || []).includes(req.params.seccion)) return res.status(400).json({ error: 'Esa sección no existe en este expediente.' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'El archivo está vacío.' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'El archivo supera los 25 MB.' });
  const nombre = path.basename(clean(req.query.nombre, 140).replace(/[\x00-\x1f\\/]/g, '_')) || 'archivo';
  if (BLOQUEADAS.test(nombre)) return res.status(400).json({ error: 'Ese tipo de archivo no se puede guardar en el expediente.' });
  const mime = clean(req.headers['x-mime'], 100) || 'application/octet-stream', ruta = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(FILES_DIR, ruta), buf);
  const id = db.prepare('INSERT INTO expediente_files (order_id, section, name, mime, size, note, path, advisor_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(o.id, req.params.seccion, nombre, mime, buf.length, clean(req.query.nota, 300) || null, ruta, req.user.id, Date.now()).lastInsertRowid;
  audit(o, req.user, 'Subió un archivo', `${SECCIONES[req.params.seccion].corto}: ${nombre}`);
  res.status(201).json({ id, progreso: sync(o) });
});

/* ---- Descargar / ver ---- */
function archivo(req, res) {
  const f = db.prepare('SELECT f.* FROM expediente_files f WHERE f.id = ?').get(req.params.id);
  const o = f && orden(f.order_id, req.user);
  return o ? { f, o } : null;
}
router.get('/expedientes/archivos/:id', requireAuth, (req, res) => {
  const r = archivo(req, res);
  if (!r) return res.status(404).json({ error: 'Archivo no encontrado.' });
  const { f } = r, inline = IMAGENES.test(f.mime || '') && !req.query.descargar;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  if (f.demo || !f.path) { res.type('text/plain; charset=utf-8'); return res.send('Archivo de ejemplo: este documento es parte de los datos de demostración y no tiene contenido.'); }
  const p = path.join(FILES_DIR, path.basename(f.path));
  if (!fs.existsSync(p)) return res.status(410).json({ error: 'El archivo ya no está en el servidor.' });
  res.type(IMAGENES.test(f.mime || '') ? f.mime : (/^application\/pdf$/.test(f.mime || '') ? 'application/pdf' : 'application/octet-stream'));
  fs.createReadStream(p).pipe(res);
});
router.delete('/expedientes/archivos/:id', requireAuth, (req, res) => {
  const r = archivo(req, res);
  if (!r) return res.status(404).json({ error: 'Archivo no encontrado.' });
  const { f, o } = r;
  db.prepare('DELETE FROM expediente_files WHERE id = ?').run(f.id);
  if (f.path) { try { fs.unlinkSync(path.join(FILES_DIR, path.basename(f.path))); } catch (_) {} }
  audit(o, req.user, 'Eliminó un archivo', `${SECCIONES[f.section] ? SECCIONES[f.section].corto : f.section}: ${f.name}`);
  res.json({ ok: true, progreso: sync(o) });
});
router.patch('/expedientes/archivos/:id', requireAuth, express.json(), (req, res) => {
  const r = archivo(req, res);
  if (!r) return res.status(404).json({ error: 'Archivo no encontrado.' });
  db.prepare('UPDATE expediente_files SET note = ? WHERE id = ?').run(clean(req.body && req.body.nota, 300) || null, r.f.id);
  audit(r.o, req.user, 'Editó la nota', r.f.name);
  res.json({ ok: true });
});

router.SECCIONES = POR_TIPO;
module.exports = router;
