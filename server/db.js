'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'ax.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Confianza de una regla: misma fórmula que RS.conf en index.html
function confidence(r) {
  const tot = r.n + 2 * (r.rej || 0);
  const c = Math.round(100 * (1 - Math.exp(-r.n / 3)) * (r.n / Math.max(tot, 1)));
  return Math.max(1, Math.min(98, c));
}

function getRule(id) {
  const r = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  if (!r) return null;
  r.parts = db.prepare('SELECT part_no, descr, qty, price, n FROM rule_parts WHERE rule_id = ?').all(id);
  r.kw = db.prepare('SELECT keyword FROM rule_keywords WHERE rule_id = ?').all(id).map(x => x.keyword);
  r.dist = db.prepare('SELECT advisor_id, delivered_at FROM rule_distribution WHERE rule_id = ?').all(id);
  r.conf = confidence(r);
  return r;
}

function listRules(status) {
  const rows = status
    ? db.prepare('SELECT id FROM rules WHERE status = ? ORDER BY id').all(status)
    : db.prepare('SELECT id FROM rules ORDER BY id').all();
  return rows.map(x => getRule(x.id));
}

function logEvent(type, msg, ruleId = null, advisorId = null) {
  db.prepare('INSERT INTO rule_log (ts, type, rule_id, advisor_id, msg) VALUES (?,?,?,?,?)')
    .run(Date.now(), type, ruleId, advisorId, msg);
}

module.exports = { db, DB_PATH, confidence, getRule, listRules, logEvent };
