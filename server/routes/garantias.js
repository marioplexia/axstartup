'use strict';
const express = require('express');
const { db, getRule, listRules } = require('../db');
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

module.exports = router;
