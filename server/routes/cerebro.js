'use strict';
// Cerebro de la red: tiempo real (SSE), alertas, ciclos de autoaprendizaje.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('./auth');
const B = require('../brain/brain');
const C = require('../brain/cycles');

const router = express.Router();
router.use(requireAuth);

router.get('/cerebro/stream', B.stream);

const lista = (user, limite) => db.prepare('SELECT a.*, (SELECT 1 FROM brain_reads r WHERE r.alert_id = a.id AND r.advisor_id = ?) leida FROM brain_alerts a ORDER BY a.id DESC LIMIT ?').all(user.id, limite)
  .map(({ agency_id, data, leida, ...a }) => ({ ...a, propia: agency_id != null && agency_id === (user.agency && user.agency.id), leida: !!leida }));

router.get('/cerebro/alertas', (req, res) => {
  const a = lista(req.user, Math.min(Number(req.query.limite) || 40, 100));
  res.json({ alertas: a, sin_leer: a.filter(x => !x.leida && !x.propia).length });
});
router.post('/cerebro/alertas/leidas', (req, res) => {
  const ins = db.prepare('INSERT OR IGNORE INTO brain_reads (alert_id, advisor_id) SELECT id, ? FROM brain_alerts');
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  if (ids) ids.forEach(i => db.prepare('INSERT OR IGNORE INTO brain_reads (alert_id, advisor_id) SELECT id, ? FROM brain_alerts WHERE id = ?').run(req.user.id, i));
  else ins.run(req.user.id);
  res.json({ ok: true });
});
router.get('/cerebro/estado', (req, res) => {
  const riesgo = db.prepare('SELECT id, sys, q_text, n, rej FROM rules WHERE rej >= 1 ORDER BY CAST(rej AS REAL) / (n + rej) DESC, rej DESC LIMIT 6').all().map(r => ({ ...r, tasa: Math.round(r.rej / Math.max(1, r.n + r.rej) * 100) }));
  const top = db.prepare('SELECT sys, q_code, problema, correccion, veces, agencias FROM train_lessons ORDER BY veces DESC, id DESC LIMIT 6').all().map(l => ({ ...l, agencias: JSON.parse(l.agencias || '[]').length }));
  res.json({ ...C.estado(), riesgo, top_errores: top, modo_prueba: process.env.AX_MODO_PRUEBA === '1' });
});
router.post('/cerebro/ciclo', async (req, res) => {
  const r = await C.ciclo('manual: ' + req.user.name);
  res.json(r || { corriendo: true });
});
// Solo en modo de pruebas: simula que OTRA agencia de la red aprendió algo, para ver la difusión en tiempo real
router.post('/cerebro/simular', (req, res) => {
  if (process.env.AX_MODO_PRUEBA !== '1') return res.status(403).json({ error: 'Solo disponible en modo de pruebas.' });
  const tipo = ['rechazo', 'mal_cobro'].includes(req.body && req.body.tipo) ? req.body.tipo : 'rechazo';
  const a = tipo === 'rechazo'
    ? B.alerta({ tipo, severidad: 'alta', titulo: 'PREA rechazada en la red: ruido en suspensión delantera', texto: 'Faltó la evidencia del kilometraje y la causa era genérica → Captura la causa específica (buje de barra estabilizadora) y adjunta foto del tablero. Evítalo en tu PREA.', sys: 'Suspensión', q_code: 'SIM', agency_id: -1 })
    : B.alerta({ tipo, severidad: 'alta', titulo: 'Mal cobro de planta detectado', texto: 'La planta pagó 1.8 h en el cambio de polea aunque se solicitaron 2.5 h → Captura 1.8 h para evitar el ajuste. Revisa tu cobro y reclama si aplica.', sys: 'Motor', q_code: 'SIM', agency_id: -1 });
  res.json({ ok: true, alerta: a.id });
});

module.exports = router;
