'use strict';
const express = require('express');
const { db, getRule, listRules, loadState, saveState, getRev } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

router.get('/reglas', (req, res) => res.json(listRules(req.query.status || null)));

router.get('/reglas/:id', (req, res) => {
  const r = getRule(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'Regla no encontrada.' });
});

router.get('/bitacora', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(db.prepare('SELECT * FROM rule_log ORDER BY ts DESC LIMIT ?').all(limit));
});

// Estado completo para la app (formato RS.d). ?since=<rev> evita reenviar si no hubo cambios.
router.get('/estado', (req, res) => {
  if (req.query.since !== undefined && Number(req.query.since) === getRev()) return res.json({ unchanged: true, rev: getRev() });
  res.json(loadState(req.user.agency && req.user.agency.id));
});

// Guarda el estado del cliente mezclándolo con el del servidor y devuelve el resultado.
router.put('/estado', (req, res) => {
  const st = req.body && req.body.state;
  if (!st || !Array.isArray(st.rules)) return res.status(400).json({ error: 'Estado no válido.' });
  const reset = !!req.body.reset;
  if (reset && req.user.role !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede restablecer.' });
  saveState(st, { reset, advisorId: req.user.id });
  res.json(loadState(req.user.agency && req.user.agency.id));
});

module.exports = router;
