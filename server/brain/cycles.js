'use strict';
// Bucles de autoaprendizaje del cerebro: corren solos (cada minuto y tras cada aprendizaje) y mejoran lo que la red ya sabe.
//  1 consolidar  -> detecta reglas de riesgo (muchos rechazos)         5 autoevaluar -> deja uno fuera y mide si la red lo predeciría
//  2 patrones    -> errores que se repiten en varias agencias          6 reflexionar -> convierte los errores en una guía/checklist por regla
//  3 desvíos     -> la planta paga menos de lo cobrado (por regla)     7 registrar   -> bitácora de ciclos y métricas
const { db } = require('../db');
const B = require('./brain');

const MODEL = process.env.TRAIN_MODEL || process.env.CHAT_MODEL || 'claude-sonnet-5-5';
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const DIA = 24 * 3600 * 1000;
let corriendo = false, timer = null, ultimo = null;

const yaAvisado = (tipo, rule_id, titulo) =>
  !!db.prepare('SELECT 1 FROM brain_alerts WHERE tipo = ? AND IFNULL(rule_id,\'\') = ? AND titulo = ? AND created_at > ?').get(tipo, rule_id || '', B.anonimizar(titulo), Date.now() - DIA);

// 1. reglas de riesgo
function riesgo(acc) {
  db.prepare('SELECT * FROM rules WHERE rej >= 2').all().forEach(r => {
    const tasa = r.rej / Math.max(1, r.n + r.rej);
    if (tasa < 0.3) return;
    const t = 'Regla en riesgo: ' + r.q_text.toLowerCase();
    if (yaAvisado('riesgo', r.id, t)) return;
    B.alerta({ tipo: 'riesgo', severidad: 'alta', titulo: t, texto: `${r.rej} de ${r.n + r.rej} PREAs con esta queja fueron rechazadas (${Math.round(tasa * 100)} %). Revisa causa, corrección y evidencias antes de enviar.`, rule_id: r.id, sys: r.sys, q_code: r.q_code });
    acc.push(`riesgo ${r.id}`);
  });
}
// 2. errores confirmados por varias agencias
function patrones(acc) {
  db.prepare('SELECT * FROM train_lessons WHERE veces >= 2').all().forEach(l => {
    const n = JSON.parse(l.agencias || '[]').length; if (n < 2) return;
    const r = db.prepare('SELECT id FROM rules WHERE sys = ? AND q_code = ?').get(l.sys, l.q_code), t = `Patrón en ${n} agencias: ${l.problema.slice(0, 70)}`;
    if (yaAvisado('patron', r && r.id, t)) return;
    B.alerta({ tipo: 'patron', severidad: 'alta', titulo: t, texto: `${l.problema}${l.correccion ? ' → ' + l.correccion : ''} Ya se vio ${l.veces} veces.`, rule_id: r && r.id, sys: l.sys, q_code: l.q_code });
    acc.push('patrón');
  });
}
// 3. desvíos de pago: lo cobrado vs. lo pagado por la planta
function desvios(acc) {
  const filas = db.prepare("SELECT o.rule_id, COUNT(*) n, SUM(c.total - c.paid_amount) dif FROM cobros c JOIN orders o ON o.id = c.order_id WHERE c.paid_amount IS NOT NULL AND c.paid_amount < c.total - 0.5 AND o.rule_id IS NOT NULL GROUP BY o.rule_id HAVING n >= 2").all();
  filas.forEach(f => {
    const r = db.prepare('SELECT * FROM rules WHERE id = ?').get(f.rule_id); if (!r) return;
    const t = 'La planta paga menos en: ' + r.q_text.toLowerCase();
    if (yaAvisado('desvio', r.id, t)) return;
    B.alerta({ tipo: 'desvio', severidad: 'aviso', titulo: t, texto: `${f.n} cobros pagados con $${Math.round(f.dif).toLocaleString('en-US')} menos de lo solicitado. Revisa tiempo y precios de pieza.`, rule_id: r.id, sys: r.sys, q_code: r.q_code });
    acc.push('desvío ' + r.id);
  });
}
// 5. leave-one-out: ¿la regla, sin esa PREA, habría predicho la operación y el tiempo?
function autoevaluar() {
  let total = 0, ok = 0;
  const porRegla = {};
  db.prepare('SELECT rule_id, op, hours FROM rule_variants WHERE hours IS NOT NULL').all().forEach(v => { (porRegla[v.rule_id] = porRegla[v.rule_id] || []).push(v); });
  Object.values(porRegla).forEach(vs => {
    if (vs.length < 2) return;
    vs.forEach((v, i) => {
      const resto = vs.filter((_, j) => j !== i), prom = resto.reduce((t, x) => t + x.hours, 0) / resto.length;
      total++;
      if (resto.some(x => x.op === v.op) && (prom === 0 || Math.abs(v.hours - prom) / prom <= 0.2)) ok++;
    });
  });
  return { evaluadas: total, aciertos: ok, precision: total ? Math.round(ok / total * 100) : null };
}
// 6. reflexión: guía por regla a partir de sus errores (con modelo si hay clave; si no, motor local)
async function guiaIA(r, ls) {
  const resp = await fetch(BASE + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(40000), headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: 'Resume en máximo 5 viñetas cortas, en español de México, qué debe cuidar un asesor de garantías al capturar esta PREA para que la planta la acepte. Usa SOLO los errores dados; no inventes datos.', messages: [{ role: 'user', content: JSON.stringify({ queja: r.q_text, operacion: r.op, errores: ls.map(l => ({ problema: l.problema, correccion: l.correccion, veces: l.veces })) }) }] }) });
  const j = await resp.json(); if (!resp.ok) throw new Error('modelo'); return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
async function reflexionar(acc) {
  const reglas = db.prepare('SELECT r.* FROM rules r WHERE EXISTS (SELECT 1 FROM train_lessons l WHERE l.sys = r.sys AND l.q_code = r.q_code)').all();
  let n = 0;
  for (const r of reglas) {
    const ls = db.prepare('SELECT * FROM train_lessons WHERE sys = ? AND q_code = ? ORDER BY veces DESC, id DESC LIMIT 8').all(r.sys, r.q_code);
    const g = db.prepare('SELECT n_lecciones FROM rule_guides WHERE rule_id = ?').get(r.id);
    if (g && g.n_lecciones === ls.length) continue;
    let guia = ls.map(l => `• ${l.problema}${l.correccion ? ' → ' + l.correccion : ''}${l.veces > 1 ? ` (visto ${l.veces} veces)` : ''}`).slice(0, 5).join('\n'), motor = 'local';
    if (process.env.ANTHROPIC_API_KEY) { try { const t = await guiaIA(r, ls); if (t) { guia = t; motor = 'modelo'; } } catch (_) {} }
    const temas = [...new Set(ls.flatMap(l => { try { return JSON.parse(l.temas || '[]'); } catch (_) { return []; } }))];
    db.prepare('INSERT INTO rule_guides (rule_id, guia, temas, motor, n_lecciones, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(rule_id) DO UPDATE SET guia=excluded.guia, temas=excluded.temas, motor=excluded.motor, n_lecciones=excluded.n_lecciones, updated_at=excluded.updated_at')
      .run(r.id, guia, JSON.stringify(temas), motor, ls.length, Date.now());
    n++;
  }
  if (n) acc.push(`${n} guía${n === 1 ? '' : 's'} actualizada${n === 1 ? '' : 's'}`);
  return n;
}

function metricas() {
  const c = q => db.prepare(q).get().n;
  return {
    reglas: c('SELECT COUNT(*) n FROM rules'), reglas_activas: c("SELECT COUNT(*) n FROM rules WHERE status = 'activa'"), variantes: c('SELECT COUNT(*) n FROM rule_variants'),
    lecciones: c('SELECT COUNT(*) n FROM train_lessons'), lecciones_confirmadas: c('SELECT COUNT(*) n FROM train_lessons WHERE veces >= 2'),
    preas: c("SELECT COUNT(*) n FROM train_docs WHERE kind='prea' AND status='aprendida'"), pagos: c("SELECT COUNT(*) n FROM train_docs WHERE kind='pago' AND status='aprendida'"),
    agencias_aportando: c('SELECT COUNT(DISTINCT agency_id) n FROM train_docs WHERE status=\'aprendida\''), guias: c('SELECT COUNT(*) n FROM rule_guides'), conectados: B.conectados()
  };
}

async function ciclo(motivo = 'programado') {
  if (corriendo) return null;
  corriendo = true; const t0 = Date.now(), acc = [];
  try {
    riesgo(acc); patrones(acc); desvios(acc);
    const ev = autoevaluar(); await reflexionar(acc);
    const m = { ...metricas(), ...ev };
    const id = db.prepare('INSERT INTO brain_cycles (ts, ms, motivo, metricas, acciones) VALUES (?,?,?,?,?)').run(t0, Date.now() - t0, motivo, JSON.stringify(m), JSON.stringify(acc)).lastInsertRowid;
    db.prepare('DELETE FROM brain_cycles WHERE id < ?').run(id - 200);
    ultimo = { id, ts: t0, ms: Date.now() - t0, motivo, metricas: m, acciones: acc };
    B.difundir('ciclo', { ts: t0, acciones: acc, metricas: m });
    return ultimo;
  } finally { corriendo = false; }
}

let deb = null;
function pedir(motivo) { clearTimeout(deb); deb = setTimeout(() => ciclo(motivo).catch(e => console.error('Ciclo del cerebro:', e.message)), 1500); }
function iniciar() {
  if (timer) return;
  B.alAprender(t => pedir('aprendió: ' + t));
  timer = setInterval(() => ciclo('programado').catch(e => console.error('Ciclo del cerebro:', e.message)), 60000);
  timer.unref && timer.unref();
  setTimeout(() => ciclo('arranque').catch(() => {}), 2000).unref && 0;
}
const estado = () => ({ ultimo, corriendo, metricas: metricas(), ciclos: db.prepare('SELECT id, ts, ms, motivo, acciones FROM brain_cycles ORDER BY id DESC LIMIT 12').all().map(c => ({ ...c, acciones: JSON.parse(c.acciones || '[]') })) });

module.exports = { ciclo, pedir, iniciar, estado, metricas };
