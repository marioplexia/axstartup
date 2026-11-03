'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../db');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('⚠ JWT_SECRET no definido: las sesiones se invalidan al reiniciar.');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Límite simple de intentos de login por IP (en memoria)
const attempts = new Map();
function limited(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= 10;
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role,
           agency: { id: row.agency_id, name: row.agency_name, brand: row.brand } };
}
function sign(id) { return jwt.sign({ sub: id }, SECRET, { expiresIn: '7d' }); }

const USER_SQL = `SELECT a.*, g.name AS agency_name, g.brand FROM advisors a
                  LEFT JOIN agencies g ON g.id = a.agency_id`;

// Lista pública de agencias para el formulario de registro
router.get('/agencias', (_req, res) => {
  res.json(db.prepare('SELECT id, name, brand, region, city FROM agencies ORDER BY region, id').all());
});

router.post('/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const agencyId = Number(req.body.agency_id);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Correo no válido.' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  if (!db.prepare('SELECT 1 FROM agencies WHERE id = ?').get(agencyId))
    return res.status(400).json({ error: 'Selecciona una agencia.' });
  if (db.prepare('SELECT 1 FROM advisors WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const id = 'a' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const hash = await bcrypt.hash(password, 10);
  db.prepare(`INSERT INTO advisors (id, name, email, agency_id, password_hash, role, created_at)
              VALUES (?,?,?,?,?, 'asesor', ?)`).run(id, email.split('@')[0], email, agencyId, hash, Date.now());
  // El nuevo asesor recibe las reglas que ya están activas
  db.prepare(`INSERT OR IGNORE INTO rule_distribution (rule_id, advisor_id, delivered_at)
              SELECT id, ?, ? FROM rules WHERE status = 'activa'`).run(id, Date.now());
  db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'").run();
  const user = db.prepare(USER_SQL + ' WHERE a.id = ?').get(id);
  res.status(201).json({ token: sign(id), user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Intenta en 15 minutos.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const row = db.prepare(USER_SQL + ' WHERE a.email = ? AND a.active = 1').get(email);
  const ok = row && row.password_hash && await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    attempts.get(req.ip).push(Date.now());
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  res.json({ token: sign(row.id), user: publicUser(row) });
});

// Modo prueba (solo con AX_MODO_PRUEBA=1): entra como asesor de demostración sin contraseña.
const MODO_PRUEBA = process.env.AX_MODO_PRUEBA === '1';
router.get('/config', (_req, res) => res.json({ modoPrueba: MODO_PRUEBA }));
router.post('/prueba', (_req, res) => {
  if (!MODO_PRUEBA) return res.status(404).json({ error: 'No encontrado.' });
  const email = 'prueba@ax.test';
  let row = db.prepare(USER_SQL + ' WHERE a.email = ?').get(email);
  if (!row) {
    const ag = db.prepare('SELECT id FROM agencies ORDER BY id LIMIT 1').get();
    db.prepare(`INSERT INTO advisors (id, name, email, agency_id, password_hash, role, created_at)
                VALUES ('prueba', 'Asesor de prueba', ?, ?, NULL, 'asesor', ?)`).run(email, ag.id, Date.now());
    db.prepare(`INSERT OR IGNORE INTO rule_distribution (rule_id, advisor_id, delivered_at)
                SELECT id, 'prueba', ? FROM rules WHERE status = 'activa'`).run(Date.now());
    db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'").run();
    row = db.prepare(USER_SQL + ' WHERE a.id = ?').get('prueba');
  }
  res.json({ token: sign(row.id), user: publicUser(row) });
});

// Middleware: exige "Authorization: Bearer <token>"
function requireAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  try {
    const { sub } = jwt.verify(m ? m[1] : '', SECRET);
    const row = db.prepare(USER_SQL + ' WHERE a.id = ? AND a.active = 1').get(sub);
    if (!row) throw new Error('sin usuario');
    req.user = publicUser(row);
    next();
  } catch { res.status(401).json({ error: 'Sesión no válida.' }); }
}

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

module.exports = { router, requireAuth };
