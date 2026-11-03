'use strict';
// Entrenamiento del agente: PREAs aceptadas y transacciones pagadas de planta (PDF o imagen) + chat de pruebas.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DB_PATH } = require('../db');
const { requireAuth } = require('./auth');
const { extraer, faltantes } = require('../train/extract');
const L = require('../train/learn');
const { responder } = require('../train/ask');

const router = express.Router();
router.use(requireAuth);
const DIR = process.env.TRAIN_DIR || path.join(path.dirname(DB_PATH), 'train');
fs.mkdirSync(DIR, { recursive: true });
const MAX = 20 * 1024 * 1024;
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function mimeReal(b) {                                  // por los primeros bytes, no por lo que diga el cliente
  if (b.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  if (b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}
const getDoc = id => db.prepare('SELECT * FROM train_docs WHERE id = ?').get(id);
const propio = (id, user) => { const d = getDoc(id); return d && d.agency_id === user.agency.id ? d : null; };
const set = (id, f) => { const k = Object.keys(f); db.prepare(`UPDATE train_docs SET ${k.map(x => x + ' = ?').join(', ')} WHERE id = ?`).run(...k.map(x => f[x]), id); };
const vista = d => {
  const x = d.data ? JSON.parse(d.data) : null;
  return { id: d.id, tipo: d.kind, nombre: d.name, estado: d.status, error: d.error, motor: d.engine, size: d.size, creado: d.created_at, aprendido: d.learned_at, regla: d.rule_id, reglaEstado: d.rule_id ? (() => { const x = db.prepare('SELECT id, n, status FROM rules WHERE id = ?').get(d.rule_id); return x ? { id: x.id, n: x.n, status: x.status, th: Math.max(1, Number((db.prepare("SELECT value FROM settings WHERE key = 'th'").get() || { value: 3 }).value)) } : null; })() : null, relacionada: d.link_id,
    resumen: x ? x.resumen : null, vehiculo: x && x.tipo === 'prea' ? [x.marca, x.modelo, x.anio].filter(Boolean).join(' ') : null, validacion: x ? (x._validacion || []) : [],
    modo: x && x._modo || null, comentarios: x && x.comentarios ? x.comentarios.length : 0, lecciones: x && x.lecciones ? x.lecciones.length : 0, total: x ? (x.tipo === 'prea' ? x.total_bruto : x.total_pagado) : null };
};

/* ---------- Procesamiento (uno a la vez) ---------- */
async function procesar(id, { forzar = false } = {}) {
  const doc = getDoc(id); if (!doc) return;
  set(id, { status: 'procesando', error: null });
  try {
    const buf = fs.readFileSync(path.join(DIR, path.basename(doc.path)));
    const tipo = doc.kind === 'pago' ? 'pago' : 'prea';
    const { data, texto, engine } = await extraer(tipo, buf, doc.mime);
    const falta = faltantes(tipo, data);
    if (doc.kind === 'prueba') { set(id, { status: 'leida', data: JSON.stringify(data), texto: texto.slice(0, 20000), engine, error: falta.length ? 'No pude leer: ' + falta.join(', ') : null }); return; }
    const base = { data: JSON.stringify(data), texto: texto.slice(0, 20000), engine };
    const dup = db.prepare("SELECT id FROM train_docs WHERE id != ? AND kind = ? AND agency_id = ? AND status = 'aprendida' AND hash = ?").get(id, doc.kind, doc.agency_id, doc.hash);
    if (dup) { set(id, { ...base, status: 'duplicada', error: 'Este archivo ya se había subido.' }); return; }
    if (tipo === 'prea') {
      const ya = (data.orden || data.folio) && db.prepare("SELECT id, data FROM train_docs WHERE id != ? AND kind = 'prea' AND agency_id = ? AND status = 'aprendida'").all(id, doc.agency_id).find(o => { const x = JSON.parse(o.data); return (data.folio && x.folio === data.folio) || (data.orden && x.orden === data.orden && (!data.vin || x.vin === data.vin)); });
      if (ya && !forzar) { set(id, { ...base, status: 'duplicada', error: 'Esta PREA ya está aprendida (mismo folio u orden de trabajo).' }); return; }
    }
    if (tipo === 'prea' && data.estado === 'rechazada') {            // el error también se aprende
      if (!(data.queja && (data.queja.codigo || data.queja.texto))) { set(id, { ...base, status: 'revisar', error: 'No pude leer la queja de esta PREA rechazada.' }); return; }
      db.transaction(() => { const r = L.aprenderError(doc, data); data._modo = 'error'; data._validacion = r.validacion; data._rej = r.rej; set(id, { data: JSON.stringify(data), texto: texto.slice(0, 20000), engine, status: 'aprendida', error: null, rule_id: r.rule ? r.rule.id : null, learned_at: Date.now() }); })();
      return;
    }
    if (falta.length) { set(id, { ...base, status: 'revisar', error: 'No pude leer: ' + falta.join(', ') + '. Revisa que el archivo sea legible o sube una versión más clara.' }); return; }
    db.transaction(() => {
      if (tipo === 'prea') {
        const r = L.aprenderPrea(doc, data); data._validacion = r.validacion;
        set(id, { data: JSON.stringify(data), texto: texto.slice(0, 20000), engine, status: 'aprendida', error: null, rule_id: r.rule.id, learned_at: Date.now() });
        // pagos que estaban esperando a esta PREA
        db.prepare("SELECT * FROM train_docs WHERE kind = 'pago' AND agency_id = ? AND status = 'aprendida' AND link_id IS NULL").all(doc.agency_id).forEach(g => {
          const gd = JSON.parse(g.data), rel = L.preaDelPago(doc.agency_id, gd);
          if (rel && rel.x.id === id) { L.olvidar(g); const a = L.aprenderPago({ ...g, agency_id: doc.agency_id }, gd); gd._validacion = a.validacion; gd._ajuste = a.ajuste; set(g.id, { data: JSON.stringify(gd), link_id: id, rule_id: a.rule ? a.rule.id : g.rule_id }); }
        });
      } else {
        const a = L.aprenderPago(doc, data); data._validacion = a.validacion; data._ajuste = a.ajuste;
        set(id, { data: JSON.stringify(data), texto: texto.slice(0, 20000), engine, status: 'aprendida', error: null, rule_id: a.rule ? a.rule.id : null, link_id: a.prea ? a.prea.id : null, learned_at: Date.now() });
      }
    })();
  } catch (e) { console.error('Entrenamiento:', e.message); set(id, { status: 'error', error: e.message }); }
}
const cola = []; let corriendo = false;
function encolar(id, op) { cola.push([id, op]); if (!corriendo) bombear(); }
async function bombear() { corriendo = true; while (cola.length) { const [id, op] = cola.shift(); await procesar(id, op); } corriendo = false; }
db.prepare("SELECT id FROM train_docs WHERE status IN ('pendiente','procesando') AND kind IN ('prea','pago')").all().forEach(d => encolar(d.id));   // tras un reinicio

/* ---------- Documentos ---------- */
function guardar(req, kind) {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error('El archivo está vacío.'), { http: 400 });
  if (buf.length > MAX) throw Object.assign(new Error('El archivo supera los 20 MB.'), { http: 413 });
  const mime = mimeReal(buf);
  if (!mime) throw Object.assign(new Error('Solo se aceptan PDF o imágenes (PNG, JPG, WEBP).'), { http: 400 });
  const nombre = path.basename(clean(req.query.nombre, 160).replace(/[\x00-\x1f\\/]/g, '_')) || 'documento';
  const ruta = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(DIR, ruta), buf);
  const id = db.prepare('INSERT INTO train_docs (kind, name, mime, size, path, hash, status, agency_id, advisor_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(kind, nombre, mime, buf.length, ruta, crypto.createHash('sha256').update(buf).digest('hex'), 'pendiente', req.user.agency.id, req.user.id, Date.now()).lastInsertRowid;
  return id;
}
const raw = express.raw({ type: () => true, limit: MAX + 1024 });

router.post('/entrenamiento/docs', raw, (req, res) => {
  const tipo = req.query.tipo === 'pago' ? 'pago' : req.query.tipo === 'prea' ? 'prea' : null;
  if (!tipo) return res.status(400).json({ error: 'Indica si es una PREA aceptada o una transacción pagada.' });
  try { const id = guardar(req, tipo); encolar(id); res.status(201).json(vista(getDoc(id))); } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});
router.get('/entrenamiento/docs', (req, res) => {
  const tipo = req.query.tipo === 'pago' ? 'pago' : 'prea';
  const rows = db.prepare('SELECT * FROM train_docs WHERE agency_id = ? AND kind = ? ORDER BY id DESC LIMIT 300').all(req.user.agency.id, tipo);
  const c = {}; rows.forEach(d => { c[d.status] = (c[d.status] || 0) + 1; });
  res.json({ items: rows.map(vista), conteo: c, procesando: rows.some(d => ['pendiente', 'procesando'].includes(d.status)) });
});
router.get('/entrenamiento/resumen', (req, res) => {
  const a = req.user.agency.id, n = (k, s) => db.prepare('SELECT COUNT(*) n FROM train_docs WHERE agency_id = ? AND kind = ? AND status = ?').get(a, k, s).n;
  const reglas = db.prepare('SELECT COUNT(*) n FROM rules WHERE src_historico > 0').get().n;
  res.json({ preas: n('prea', 'aprendida'), pagos: n('pago', 'aprendida'), reglas, pendientes: db.prepare("SELECT COUNT(*) n FROM train_docs WHERE agency_id = ? AND kind IN ('prea','pago') AND status IN ('pendiente','procesando')").get(a).n,
    revisar: db.prepare("SELECT COUNT(*) n FROM train_docs WHERE agency_id = ? AND kind IN ('prea','pago') AND status IN ('revisar','error')").get(a).n });
});
router.get('/entrenamiento/docs/:id', (req, res) => {
  const d = propio(req.params.id, req.user); if (!d) return res.status(404).json({ error: 'Documento no encontrado.' });
  const regla = d.rule_id ? db.prepare('SELECT id, sys, q_text, op, n, paid_n, status FROM rules WHERE id = ?').get(d.rule_id) : null;
  res.json({ ...vista(d), datos: d.data ? JSON.parse(d.data) : null, texto: (d.texto || '').slice(0, 6000), reglaInfo: regla });
});
router.get('/entrenamiento/docs/:id/archivo', (req, res) => {
  const d = propio(req.params.id, req.user); if (!d) return res.status(404).json({ error: 'Documento no encontrado.' });
  const p = path.join(DIR, path.basename(d.path)); if (!fs.existsSync(p)) return res.status(410).json({ error: 'El archivo ya no está en el servidor.' });
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`);
  res.type(d.mime); fs.createReadStream(p).pipe(res);
});
router.post('/entrenamiento/docs/:id/reintentar', (req, res) => {
  const d = propio(req.params.id, req.user); if (!d || d.kind === 'prueba') return res.status(404).json({ error: 'Documento no encontrado.' });
  if (d.status === 'aprendida') return res.status(400).json({ error: 'Este documento ya está aprendido.' });
  set(d.id, { status: 'pendiente', error: null }); encolar(d.id, { forzar: !!(req.body && req.body.forzar) });
  res.json(vista(getDoc(d.id)));
});
router.delete('/entrenamiento/docs/:id', (req, res) => {
  const d = propio(req.params.id, req.user); if (!d) return res.status(404).json({ error: 'Documento no encontrado.' });
  db.transaction(() => {
    if (d.kind === 'prea' && d.status === 'aprendida') {
      db.prepare("SELECT * FROM train_docs WHERE kind = 'pago' AND link_id = ?").all(d.id).forEach(g => set(g.id, { link_id: null }));
    }
    if (d.status === 'aprendida') L.olvidar(d);
    db.prepare('DELETE FROM train_docs WHERE id = ?').run(d.id);
  })();
  try { fs.unlinkSync(path.join(DIR, path.basename(d.path))); } catch (_) {}
  res.json({ ok: true });
});

/* ---------- Documentos de ejemplo para probar ---------- */
const EJEMPLOS = path.join(__dirname, '..', '..', 'samples');
const LISTA_EJ = { '1-PREA-aceptada-Aveo-2024-polea.pdf': 'PREA aceptada · Aveo 2024 · polea tensora', '1b-PREA-aceptada-Aveo-2024-polea-captura.png': 'La misma PREA como captura de pantalla (imagen)', '2-Pago-planta-Aveo-2024-polea.pdf': 'Pago de planta · Aveo 2024 · polea',
  '3-PREA-aceptada-Equinox-2023-sensor-oxigeno.pdf': 'PREA aceptada · Equinox 2023 · sensor de oxígeno', '6-PREA-aceptada-Aveo-2024-polea-b.pdf': 'Otra PREA aceptada · Aveo 2024 · polea', '7-PREA-aceptada-Aveo-2023-polea-c.pdf': 'Otra PREA aceptada · Aveo 2023 · polea', '8-PREA-aceptada-Onix-2025-polea.pdf': 'PREA aceptada de OTRO modelo · Onix 2025 · polea (parecida, no idéntica)', '9-PREA-rechazada-Aveo-2024-polea.pdf': 'PREA RECHAZADA · Aveo 2024 · el agente aprende del error', '4-Pago-planta-Equinox-2023-sensor-oxigeno.pdf': 'Pago de planta · Equinox 2023', '5-PREA-por-validar-Aveo-2024-polea.pdf': 'PREA por validar (con errores) · para el chat de pruebas' };
router.get('/entrenamiento/ejemplos', (req, res) => res.json(Object.keys(LISTA_EJ).filter(f => fs.existsSync(path.join(EJEMPLOS, f))).map(f => ({ archivo: f, descripcion: LISTA_EJ[f] }))));
router.get('/entrenamiento/ejemplos/:file', (req, res) => {
  const f = req.params.file, p = path.join(EJEMPLOS, path.basename(f));
  if (!LISTA_EJ[f] || !fs.existsSync(p)) return res.status(404).json({ error: 'Ejemplo no encontrado.' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f)}`); res.type(/\.pdf$/.test(f) ? 'application/pdf' : 'image/png'); fs.createReadStream(p).pipe(res);
});

/* ---------- Chat de pruebas ---------- */
router.post('/entrenamiento/prueba/archivos', raw, (req, res) => {
  try { const id = guardar(req, 'prueba'); res.status(201).json({ id, nombre: getDoc(id).name }); } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});
router.post('/entrenamiento/chat', async (req, res) => {
  const msg = clean(req.body && req.body.mensaje, 3000), ids = (Array.isArray(req.body && req.body.archivos) ? req.body.archivos : []).map(Number).filter(Boolean).slice(0, 3);
  if (!msg && !ids.length) return res.status(400).json({ error: 'Escribe tu pregunta o sube una PREA.' });
  const now = Date.now();
  let hilo = Number(req.body.hilo) || 0;
  if (hilo && !db.prepare("SELECT 1 FROM chat_threads WHERE id = ? AND advisor_id = ? AND kind = 'prueba'").get(hilo, req.user.id)) hilo = 0;
  const subidos = [];
  for (const id of ids) {
    let d = propio(id, req.user); if (!d || d.kind !== 'prueba') continue;
    if (d.status === 'pendiente') await procesar(d.id);
    d = getDoc(d.id); subidos.push({ id: d.id, name: d.name, error: d.error, d: d.data ? JSON.parse(d.data) : null, status: d.status });
  }
  const adj = subidos.length ? '\n\nAdjunto: ' + subidos.map(s => s.name).join(', ') : '';
  const titulo = (msg || (subidos[0] && subidos[0].name) || 'Prueba').slice(0, 60);
  if (!hilo) hilo = db.prepare("INSERT INTO chat_threads (advisor_id, title, created_at, updated_at, kind) VALUES (?,?,?,?,'prueba')").run(req.user.id, titulo, now, now).lastInsertRowid;
  db.prepare('INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?,?,?,?)').run(hilo, 'user', (msg || 'Valida esta PREA') + adj, now);
  const hist = db.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 10').all(hilo).reverse();
  let r;
  try { r = await responder({ user: req.user, mensaje: msg || 'Valida esta PREA', subidos, historial: hist }); } catch (e) { console.error(e); r = { texto: 'No pude consultar lo aprendido en este momento. Intenta de nuevo.', origen: 'error' }; }
  db.prepare('INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?,?,?,?)').run(hilo, 'assistant', r.texto, Date.now());
  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(Date.now(), hilo);
  res.json({ hilo, respuesta: r.texto, origen: r.origen, lecturas: subidos.map(s => ({ id: s.id, nombre: s.name, estado: s.status, error: s.error, resumen: s.d && s.d.resumen })) });
});
router.get('/entrenamiento/chat/hilos', (req, res) => res.json(db.prepare("SELECT id, title, updated_at FROM chat_threads WHERE advisor_id = ? AND kind = 'prueba' ORDER BY updated_at DESC LIMIT 30").all(req.user.id)));
router.get('/entrenamiento/chat/hilos/:id', (req, res) => {
  const h = db.prepare("SELECT id, title FROM chat_threads WHERE id = ? AND advisor_id = ? AND kind = 'prueba'").get(req.params.id, req.user.id);
  if (!h) return res.status(404).json({ error: 'Conversación no encontrada.' });
  res.json({ ...h, mensajes: db.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id').all(h.id) });
});
router.delete('/entrenamiento/chat/hilos/:id', (req, res) => { db.prepare("DELETE FROM chat_threads WHERE id = ? AND advisor_id = ? AND kind = 'prueba'").run(req.params.id, req.user.id); res.json({ ok: true }); });

module.exports = router;
