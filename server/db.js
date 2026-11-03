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

// Migración: columnas del tablero de inicio (cliente, pieza, unidad, tipo de servicio)
{
  const have = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  [['customer', 'TEXT'], ['part', 'TEXT'], ['part_status', 'TEXT'], ['part_ordered_at', 'INTEGER'],
   ['due_at', 'INTEGER'], ['unit', 'TEXT'], ['svc_type', 'TEXT'], ['closed_at', 'INTEGER']]
    .forEach(([n, t]) => { if (!have.includes(n)) db.exec(`ALTER TABLE orders ADD COLUMN ${n} ${t}`); });
}
{
  const add = (tabla, cols) => { const have = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name); cols.forEach(([n, t]) => { if (!have.includes(n)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${n} ${t}`); }); };
  add('rules', [['paid_n', 'INTEGER NOT NULL DEFAULT 0'], ['paid_hours_sum', 'REAL NOT NULL DEFAULT 0'], ['paid_amount_sum', 'REAL NOT NULL DEFAULT 0']]);
  add('chat_threads', [['kind', "TEXT NOT NULL DEFAULT 'mi'"]]);
}

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


// ---------- Estado compartido (mismo formato que RS.d en index.html) ----------
const getSet = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const putSet = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const getRev = () => Number(getSet('rev', 0));

function group(rows, key) {
  const m = {};
  rows.forEach(r => (m[r[key]] = m[r[key]] || []).push(r));
  return m;
}

function loadState() {
  const parts = group(db.prepare('SELECT * FROM rule_parts').all(), 'rule_id');
  const kws = group(db.prepare('SELECT * FROM rule_keywords').all(), 'rule_id');
  const dist = group(db.prepare('SELECT * FROM rule_distribution').all(), 'rule_id');
  const rules = db.prepare('SELECT * FROM rules ORDER BY id').all().map(r => {
    const pm = {}; (parts[r.id] || []).forEach(p => (pm[p.part_no] = { d: p.descr, q: p.qty, pr: p.price, n: p.n }));
    const dm = {}; (dist[r.id] || []).forEach(x => (dm[x.advisor_id] = x.delivered_at));
    return {
      id: r.id, sys: r.sys, q: [r.q_code, r.q_text], c: [r.c_code, r.c_text], r: [r.r_code, r.r_text],
      op: r.op, opd: r.op_desc, h: r.hours, hSum: r.hours_sum, parts: pm,
      kw: (kws[r.id] || []).map(k => k.keyword), n: r.n, rej: r.rej, status: r.status,
      created: r.created_at, updated: r.updated_at,
      src: { base: r.src_base, historico: r.src_historico, asesor: r.src_asesor }, dist: dm
    };
  });
  const vars = group(db.prepare('SELECT * FROM rule_variants ORDER BY id DESC').all(), 'rule_id');
  const les = {}; db.prepare('SELECT * FROM train_lessons ORDER BY id DESC').all().forEach(l => { const k = l.sys + '|' + l.q_code; (les[k] = les[k] || []); if (les[k].length < 8 && !les[k].some(x => x.p === l.problema)) les[k].push({ p: l.problema, c: l.correccion || '', t: JSON.parse(l.temas || '[]') }); });
  rules.forEach(r => {
    r.ctx = (vars[r.id] || []).slice(0, 12).map(v => ({ mo: v.modelo || '', an: v.anio || null, km: v.km || null, op: v.op, opd: v.op_desc, h: v.hours, c: [v.c_code, v.c_text], r: [v.r_code, v.r_text], parts: JSON.parse(v.parts || '[]') }));
    r.les = les[r.sys + '|' + r.q[0]] || [];
  });
  const log = db.prepare('SELECT ts, type, rule_id, msg FROM rule_log ORDER BY ts DESC, id DESC LIMIT 120')
    .all().map(l => ({ t: l.ts, type: l.type, rule: l.rule_id || '', msg: l.msg }));
  const advisors = db.prepare('SELECT id, name FROM advisors WHERE active = 1 ORDER BY created_at, id').all();
  return {
    rev: getRev(), advisors,
    state: {
      v: 1, rules, log,
      cfg: { th: Number(getSet('th', 1)), auto: getSet('auto', 'true') === 'true' },
      stats: { q: Number(getSet('stats_q', 0)), hit: Number(getSet('stats_hit', 0)) },
      seq: Math.max(Number(getSet('seq', 0)), rules.length)
    }
  };
}

// Mezcla el estado de un cliente: gana la regla con `updated` más reciente; la distribución y la bitácora solo se suman.
const saveState = db.transaction((st, { reset = false, advisorId = null } = {}) => {
  if (reset) {
    ['rule_log', 'rule_distribution', 'rule_parts', 'rule_keywords', 'rules'].forEach(t => db.exec(`DELETE FROM ${t}`));
  }
  const exists = db.prepare('SELECT id, sys, q_code, updated_at FROM rules WHERE id = ?');
  const upRule = db.prepare(`INSERT INTO rules
    (id,sys,q_code,q_text,c_code,c_text,r_code,r_text,op,op_desc,hours,hours_sum,n,rej,status,src_base,src_historico,src_asesor,created_at,updated_at)
    VALUES (@id,@sys,@q0,@q1,@c0,@c1,@r0,@r1,@op,@opd,@h,@hSum,@n,@rej,@status,@sb,@sh,@sa,@created,@updated)
    ON CONFLICT(id) DO UPDATE SET sys=excluded.sys,q_code=excluded.q_code,q_text=excluded.q_text,c_code=excluded.c_code,c_text=excluded.c_text,
      r_code=excluded.r_code,r_text=excluded.r_text,op=excluded.op,op_desc=excluded.op_desc,hours=excluded.hours,hours_sum=excluded.hours_sum,
      n=excluded.n,rej=excluded.rej,status=excluded.status,src_base=excluded.src_base,src_historico=excluded.src_historico,
      src_asesor=excluded.src_asesor,updated_at=excluded.updated_at`);
  const delParts = db.prepare('DELETE FROM rule_parts WHERE rule_id=?');
  const insPart = db.prepare('INSERT INTO rule_parts (rule_id,part_no,descr,qty,price,n) VALUES (?,?,?,?,?,?)');
  const delKw = db.prepare('DELETE FROM rule_keywords WHERE rule_id=?');
  const insKw = db.prepare('INSERT OR IGNORE INTO rule_keywords (rule_id,keyword) VALUES (?,?)');
  const insDist = db.prepare('INSERT OR IGNORE INTO rule_distribution (rule_id,advisor_id,delivered_at) VALUES (?,?,?)');
  const validAdv = new Set(db.prepare('SELECT id FROM advisors').all().map(a => a.id));
  let seq = Math.max(Number(getSet('seq', 0)), Number(st.seq) || 0);
  const nextId = () => 'R-' + ('000' + (++seq)).slice(-4);
  let changed = reset;

  for (const r of st.rules || []) {
    let id = String(r.id || '');
    if (!/^R-\d{4,}$/.test(id) || !Array.isArray(r.q) || !Array.isArray(r.c) || !Array.isArray(r.r)) continue;
    const cur = exists.get(id);
    if (cur && (cur.sys !== r.sys || cur.q_code !== r.q[0])) id = nextId();   // dos clientes crearon el mismo id
    else if (cur && cur.updated_at > r.updated) continue;                      // el servidor tiene algo más nuevo
    else if (cur && cur.updated_at === r.updated) { /* sin cambios de regla; aún puede traer distribución */ }
    const src = r.src || {};
    if (!cur || cur.updated_at !== r.updated || id !== r.id) {
      upRule.run({ id, sys: r.sys, q0: r.q[0], q1: r.q[1], c0: r.c[0], c1: r.c[1], r0: r.r[0], r1: r.r[1], op: r.op, opd: r.opd,
        h: +r.h || 0, hSum: +r.hSum || 0, n: r.n | 0, rej: r.rej | 0, status: r.status, sb: src.base | 0, sh: src.historico | 0, sa: src.asesor | 0,
        created: r.created, updated: r.updated });
      delParts.run(id); delKw.run(id);
      Object.entries(r.parts || {}).forEach(([no, p]) => insPart.run(id, no, p.d, +p.q || 0, +p.pr || 0, p.n | 0));
      (r.kw || []).forEach(w => insKw.run(id, String(w)));
      changed = true;
    }
    Object.entries(r.dist || {}).forEach(([adv, ts]) => {
      if (validAdv.has(adv) && insDist.run(id, adv, ts).changes) changed = true;
    });
  }

  const insLog = db.prepare('INSERT OR IGNORE INTO rule_log (ts,type,rule_id,advisor_id,msg) VALUES (?,?,?,?,?)');
  for (const l of (st.log || []).slice(0, 120)) {
    if (l && l.msg && insLog.run(l.t, String(l.type || 'info'), l.rule || '', advisorId, l.msg).changes) changed = true;
  }

  if (st.cfg) {
    const th = String(Math.max(1, st.cfg.th | 0 || 1)), auto = String(!!st.cfg.auto);
    if (th !== getSet('th', '1') || auto !== getSet('auto', 'true')) changed = true;
    putSet('th', th); putSet('auto', auto);
  }
  if (st.stats) {
    const q = Math.max(Number(getSet('stats_q', 0)), st.stats.q | 0), hit = Math.max(Number(getSet('stats_hit', 0)), st.stats.hit | 0);
    if (reset) { putSet('stats_q', st.stats.q | 0); putSet('stats_hit', st.stats.hit | 0); }
    else { if (q !== Number(getSet('stats_q', 0)) || hit !== Number(getSet('stats_hit', 0))) changed = true; putSet('stats_q', q); putSet('stats_hit', hit); }
  }
  putSet('seq', seq);
  if (changed) putSet('rev', getRev() + 1);
});

// Una sola PREA aceptada ya basta para activar una regla (antes eran 3): se ajusta una vez, sin pisar cambios posteriores del Tablero
if (!getSet('th1_migrated', '')) {
  putSet('th', '1'); putSet('th1_migrated', '1');
  if (getSet('auto', 'true') === 'true') {     // las reglas que esperaban llegar al umbral ya lo cumplen: se activan y se reparten
    const now = Date.now(), pend = db.prepare("SELECT id FROM rules WHERE status = 'aprendizaje' AND n >= 1").all(), advs = db.prepare('SELECT id FROM advisors WHERE active = 1').all();
    pend.forEach(r => { db.prepare("UPDATE rules SET status = 'activa', updated_at = ? WHERE id = ?").run(now, r.id); advs.forEach(a => db.prepare('INSERT OR IGNORE INTO rule_distribution (rule_id, advisor_id, delivered_at) VALUES (?,?,?)').run(r.id, a.id, now)); logEvent('activada', r.id, `Regla ${r.id} se activó: ahora una sola PREA aceptada basta`); });
  }
  putSet('rev', getRev() + 1);
}

module.exports = { db, DB_PATH, confidence, getRule, listRules, logEvent, loadState, saveState, getRev };
