'use strict';
// Cerebro de la red: difunde en tiempo real lo que aprende (errores, rechazos, mal cobro de planta, reglas nuevas)
// a todas las agencias conectadas, y lo guarda como alertas para quien no estaba en línea.
const { db } = require('../db');

let hook = null;
const alAprender = f => { hook = f; };
const clientes = new Set();          // conexiones SSE abiertas: { res, advisorId, agencyId }

// Lo que una agencia aprende se comparte sin datos personales ni identificadores de la operación
function anonimizar(t) {
  return String(t == null ? '' : t)
    .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '[VIN]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]')
    .replace(/\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b|\b\d{4}\s?-\s?\d{3}\b/g, '[teléfono]')
    .replace(/\b(?:PREA|AUT|PAG)-[\w-]+\b/g, '[folio]')
    .replace(/\bG-[A-Z0-9]{5,10}\b|\bGA\d{3,6}\b/g, '[orden]')
    .replace(/\s+/g, ' ').replace(/ ([.,;:])/g, '$1').trim();
}

function publica(a, c) {              // lo que ve cada conexión: sin ids de agencia, solo si es la propia
  const { agency_id, data, ...r } = a;
  return { ...r, propia: agency_id != null && agency_id === c.agencyId };
}
function difundir(evento, payload) {
  clientes.forEach(c => {
    try { c.res.write(`event: ${evento}\ndata: ${JSON.stringify(evento === 'alerta' ? publica(payload, c) : payload)}\n\n`); } catch (_) { clientes.delete(c); }
  });
}

function alerta({ tipo, severidad = 'info', titulo, texto, rule_id = null, sys = null, q_code = null, agency_id = null, data = null }) {
  const now = Date.now(), t = anonimizar(titulo), x = anonimizar(texto);
  const id = db.prepare('INSERT INTO brain_alerts (tipo, severidad, titulo, texto, rule_id, sys, q_code, agency_id, data, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(tipo, severidad, t, x, rule_id, sys, q_code, agency_id, data ? JSON.stringify(data) : null, now).lastInsertRowid;
  const a = { id, tipo, severidad, titulo: t, texto: x, rule_id, sys, q_code, agency_id, created_at: now };
  difundir('alerta', a);
  if (hook && ['leccion', 'regla', 'rechazo', 'mal_cobro'].includes(tipo)) hook(tipo);
  return a;
}

// Conexión de tiempo real de un asesor (Server-Sent Events)
function stream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders && res.flushHeaders();
  res.write(`retry: 4000\n: conectado\n\n`);
  const c = { res, advisorId: req.user.id, agencyId: req.user.agency && req.user.agency.id };
  clientes.add(c);
  res.write(`event: listo\ndata: ${JSON.stringify({ conectados: clientes.size })}\n\n`);
  const latido = setInterval(() => { try { res.write(': latido\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(latido); clientes.delete(c); });
}

const conectados = () => clientes.size;

module.exports = { alAprender, alerta, difundir, stream, anonimizar, conectados };
