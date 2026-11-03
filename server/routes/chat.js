'use strict';
// «Mi Agente»: chat sobre las PREAs, servicios, campañas y expedientes de la agencia.
// Con ANTHROPIC_API_KEY responde un modelo de Claude que consulta los datos con herramientas;
// sin clave responde un motor local por reglas que lee las mismas tablas.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('./auth');
const D = require('../chatdata');

const router = express.Router();
router.use(requireAuth);

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5-5';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* ---------------- periodos ---------------- */
function periodo(q) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth(), d0 = new Date(y, m, n.getDate()).getTime();
  let r;
  if (/\bhoy\b/.test(q)) r = { desde: d0, hasta: Date.now(), label: 'hoy' };
  else if (/\bayer\b/.test(q)) r = { desde: d0 - D.DAY, hasta: d0 - 1, label: 'ayer' };
  else if (/esta semana|ultimos? 7 dias|semana/.test(q)) r = { desde: d0 - 6 * D.DAY, hasta: Date.now(), label: 'en los últimos 7 días' };
  else if (/mes pasado|mes anterior/.test(q)) r = { desde: new Date(y, m - 1, 1).getTime(), hasta: new Date(y, m, 1).getTime() - 1, label: 'el mes pasado' };
  else if (/este mes|del mes|mensual/.test(q)) r = { desde: new Date(y, m, 1).getTime(), hasta: Date.now(), label: 'este mes' };
  else if (/este ano|del ano|anual/.test(q)) r = { desde: new Date(y, 0, 1).getTime(), hasta: Date.now(), label: 'este año' };
  else { const k = q.match(/ultimos?\s+(\d{1,2})\s+(mes|meses|dias)/); if (k) { const v = +k[1]; r = k[2] === 'dias' ? { desde: d0 - (v - 1) * D.DAY, hasta: Date.now(), label: `en los últimos ${v} días` } : { desde: new Date(y, m - v, n.getDate()).getTime(), hasta: Date.now(), label: `en los últimos ${v} meses` }; } }
  return r || null;
}

/* ---------------- motor local ---------------- */
const table = (rows, cols) => rows.length
  ? '| ' + cols.map(c => c[0]).join(' | ') + ' |\n| ' + cols.map(() => '---').join(' | ') + ' |\n' + rows.map(r => '| ' + cols.map(c => String(c[1](r) == null ? '—' : c[1](r)).replace(/\|/g, '/')).join(' | ') + ' |').join('\n')
  : '';
const COLS = {
  orden: ['Orden', r => r.orden], tipo: ['Tipo', r => r.tipo], cliente: ['Cliente', r => r.cliente], estado: ['Estado', r => r.estado],
  fecha: ['Fecha', r => r.fecha], monto: ['Monto', r => D.money(r.monto)], pieza: ['Pieza', r => r.pieza], epieza: ['Estado de la pieza', r => r.estado_pieza],
  llegada: ['Llegada', r => r.llegada || (r.estado_pieza === 'En planta' ? 'Disponible' : '—')], exp: ['Expediente', r => r.expediente], unidad: ['Unidad', r => r.unidad], serv: ['Servicio', r => r.tipo_servicio]
};
const more = b => b.total > b.mostradas ? `\n\nMuestro ${b.mostradas} de ${b.total}. Pídeme un filtro (cliente, periodo o estado) para acotar.` : '';
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

function estadoDe(q, kind) {
  const map = [[/preaprobad/, 'preaprobada'], [/aprobad|aprobe|aprobo|aprobaron|aprobamos|autoriz/, 'aprobada'], [/rechazad|rechaz|negad|denegad|nego|negaron/, 'rechazada'], [/requier\w* atencion|atencion|en revision/, 'atencion'],
    [/cerrad/, 'cerrada'], [/pagad|cobrad/, 'pagada'], [/realizad|completad|terminad/, 'realizada'], [/pendient|por realizar|programad/, 'pendiente']];
  for (const [re, st] of map) if (re.test(q)) {
    if (kind === 'servicio' && ['realizada', 'cerrada'].includes(st)) return 'pagada';
    if (kind === 'prea' && ['pagada', 'cerrada', 'realizada', 'pendiente'].includes(st)) return st === 'pendiente' ? 'preaprobada' : null;
    if (kind === 'campana' && st === 'pagada') return 'cerrada';
    return st;
  }
  return null;
}

function local(user, alcance, msg) {
  const q = norm(msg), per = periodo(q), f = {};
  if (per) { f.desde = per.desde; f.hasta = per.hasta; }
  const L = per ? ' ' + per.label : '';

  if (/^\s*(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|que tal|saludos)\W*$/.test(q))
    return `¡Hola, ${user.name}! Soy **Mi Agente**. Puedo contarte sobre tus **PREAs**, **servicios**, **campañas**, **piezas** y **expedientes**.\n\nPor ejemplo: "¿Cuántas PREAs aprobé este mes?" o "¿Qué piezas me faltan por pedir?".`;
  if (/^\s*(gracias|muchas gracias|ok|listo|perfecto|genial)\W*$/.test(q)) return 'Con gusto. Cuando quieras revisar otra cosa, aquí estoy.';

  // 1) folios concretos
  const ids = [...new Set((String(msg).match(/\b(?:G-[A-Z0-9]{6,10}|GA\d{3,6}|S-[A-Z0-9]{4,10})\b/gi) || []).map(x => x.toUpperCase()))].slice(0, 3);
  if (ids.length) return ids.map(id => {
    const o = D.detalle(user, alcance, id);
    if (!o) return `No encontré la orden **${id}** en tu agencia.`;
    const l = [`**${o.orden}** · ${o.tipo} · **${o.estado}**`];
    if (o.cliente) l.push(`- Cliente: ${o.cliente}`);
    l.push(`- Asesor: ${o.asesor || '—'} · Registrada el ${o.fecha}` + (o.resuelta ? ` · Resuelta el ${o.resuelta}` : ''));
    if (o.vin) l.push(`- Vehículo: VIN ${o.vin}` + (o.km != null ? `, ${o.km.toLocaleString('en-US')} km` : ''));
    if (o.unidad) l.push(`- Unidad: ${o.unidad}`);
    if (o.tipo_servicio) l.push(`- Servicio: ${o.tipo_servicio}`);
    if (o.monto) l.push(`- Monto: ${D.money(o.monto)}`);
    if (o.pieza) l.push(`- Pieza: ${o.pieza} (${o.estado_pieza || 'sin autorizar'}${o.llegada ? ', llega el ' + o.llegada : ''})`);
    l.push(`- Expediente: ${o.expediente}` + (o.expediente_completo ? ' (completo)' : ' (incompleto)'));
    if (o.regla) l.push(`- Regla del agente: ${o.regla}`);
    if (o.descripcion) l.push(`\n${o.descripcion}`);
    return l.join('\n');
  }).join('\n\n');

  // 2) tipo, cliente y estado mencionados
  let kind = /campan/.test(q) ? 'campana' : /servicio|mantenimiento|reparacion|instalacion|diagnostico|inspeccion/.test(q) ? 'servicio' : /prea|garantia|reclamacion/.test(q) ? 'prea' : null;
  const cl = db.prepare(`SELECT DISTINCT customer c FROM orders WHERE customer IS NOT NULL`).all().map(x => x.c).find(c => q.includes(norm(c)));
  if (cl) f.cliente = cl;
  if (kind) f.tipo = kind;
  const cie = /sin cerrar|\bactiv[ao]s?\b/.test(q) ? 'activa' : /\bcerrad[ao]s?\b|\bcobrad[ao]s?\b/.test(q) ? 'cerrada' : null;
  if (cie) f.cierre = cie;
  const st = estadoDe(cie ? q.replace(/cerrad[ao]s?|cobrad[ao]s?/g, '') : q, kind);
  if (st) f.estado = st;
  const cuenta = /cuantas?|cuantos?|total|numero de|how many/.test(q);

  // 3) expedientes
  if (/expediente|evidencia|documentos?/.test(q)) {
    f.expediente_incompleto = !/completo/.test(q) || /incompleto/.test(q);
    if (/\bcompletos?\b/.test(q) && !/incompleto/.test(q)) f.expediente_incompleto = false;
    const b = D.buscar(user, alcance, { ...f, limite: 15 });
    if (!f.expediente_incompleto) { const r = D.resumen(user, alcance); return `Todos los demás expedientes están completos. Hay **${r.expedientes_incompletos}** con documentos pendientes; pregúntame por ellos si quieres verlos.`; }
    if (!b.total) return `Buen trabajo: no hay órdenes con el expediente incompleto${L}.`;
    return `Hay **${plural(b.total, 'orden con el expediente incompleto', 'órdenes con el expediente incompleto')}**${L}:\n\n${table(b.ordenes, [COLS.orden, COLS.tipo, COLS.cliente, COLS.exp, COLS.estado])}${more(b)}`;
  }

  // 4) piezas
  if (/pieza|refaccion|pedido|pedir|en planta/.test(q) && kind !== 'servicio' && kind !== 'campana') {
    const ep = /por pedir|faltan|falta|sin pedir|no he pedido/.test(q) ? 'por_pedir' : /en planta|disponibl|llegaron|llego/.test(q) ? 'en_planta' : /pedida|en camino|en transito|llegan|llegada/.test(q) ? 'pedida' : null;
    const r = D.resumen(user, alcance);
    const b = D.buscar(user, alcance, { con_pieza: true, estado_pieza: ep, cliente: f.cliente, limite: 15 });
    const head = `Piezas de PREAs autorizadas: **${r.piezas['En planta'] || 0}** en planta, **${r.piezas['Pedida'] || 0}** pedidas en camino y **${r.piezas['Por pedir'] || 0}** por pedir.`;
    if (cuenta && !ep) return head;
    if (!b.total) return `${head}\n\nNo hay piezas con ese filtro.`;
    return `${head}\n\n${table(b.ordenes, [COLS.orden, COLS.cliente, COLS.pieza, COLS.epieza, COLS.llegada])}${more(b)}`;
  }

  // 4b) cartera: saldos por recuperar y antigüedad
  if (/cartera|saldos?\b|antiguedad|por recuperar|recuperaci|recuperad|cobros? (abiert|pendient|vencid)|(mas de|mayor(es)? a)\s*\d+\s*dias|sin pagar/.test(q)) {
    const m = q.match(/(?:mas de|mayor(?:es)? a)\s*(\d+)\s*dias/), min = m ? +m[1] : 0, c = D.cartera(user, alcance, min);
    const head = `Tu cartera es de **${D.money(c.cartera_total)}**: recuperaste **${D.money(c.recuperado)}** (${c.pct_recuperacion}%) y quedan **${D.money(c.por_cobrar)}** por cobrar en **${c.cobros_abiertos}** cobros abiertos.`;
    const ant = c.antiguedad.map(a => `- ${a.rango_dias} días: ${D.money(a.monto)} (${a.cobros})`).join('\n');
    if (!c.total_abiertos_con_filtro) return `${head}\n\nNo hay cobros abiertos${min ? ' con más de ' + min + ' días' : ''}.`;
    return `${head}\n\n**Antigüedad de saldos**\n${ant}\n\n**Cobros abiertos${min ? ' con más de ' + min + ' días' : ''}** (${c.total_abiertos_con_filtro}):\n\n${table(c.abiertos, [['Orden', r => r.orden], ['Días', r => r.dias], ['Total', r => D.money(r.total)], ['Estado', r => r.estado]])}`;
  }

  // 5) cuánto se cobró / monto
  if (/cobr|factur|ingres|dinero|monto|importe|vend|gane|ganado|pago|pagos/.test(q) && !/pendient|por cobrar/.test(q)) {
    const p = per || periodo('este mes'), r = D.resumen(user, alcance, p.desde, p.hasta);
    const b1 = D.buscar(user, alcance, { tipo: 'servicio', estado: 'pagada', desde: p.desde, hasta: p.hasta, limite: 1 });
    const b2 = D.buscar(user, alcance, { tipo: 'prea', estado: 'aprobada', desde: p.desde, hasta: p.hasta, limite: 1 });
    return `${p.label[0].toUpperCase() + p.label.slice(1)} llevas **${D.money(r.monto_aprobado_o_cobrado)}** entre PREAs aprobadas y servicios pagados:\n\n- PREAs aprobadas: **${b2.total}**\n- Servicios pagados: **${b1.total}**\n\nTambién puede haber campañas realizadas sin cobrar; pregúntame "campañas pendientes de cobro".`;
  }

  // 6) reglas aprendidas
  if (/regla|aprend/.test(q)) {
    const rs = D.reglas();
    return `El agente tiene **${rs.length}** reglas principales:\n\n${table(rs, [['Regla', r => r.id], ['Sistema', r => r.sistema], ['Queja', r => r.queja], ['Horas', r => r.horas], ['Casos', r => r.casos_aceptados], ['Estado', r => r.estado]])}`;
  }

  // 7) TPU / retrasos
  if (/tpu|tiempo por unidad|ciclo|retras|atrasad|fuera de tiempo|vencid/.test(q)) {
    const t = D.tpu(user, alcance);
    const a = `El límite de TPU es de **${t.limite_dias} días**. ` + (t.ciclo_promedio_dias == null ? 'Aún no hay PREAs aprobadas para calcular el ciclo.' : `El ciclo promedio de tus PREAs aprobadas es de **${t.ciclo_promedio_dias} días**.`);
    return t.pendientes_fuera_de_tpu ? `${a}\n\nTienes **${t.pendientes_fuera_de_tpu}** PREAs abiertas fuera de TPU:\n\n${table(t.ordenes, [COLS.orden, COLS.cliente, COLS.estado, COLS.fecha])}` : `${a}\n\nNo tienes PREAs abiertas fuera de TPU.`;
  }

  // 8) por cobrar (campañas realizadas)
  if (/por cobrar|pendientes? de cobro|sin cobrar/.test(q)) { f.tipo = 'campana'; f.estado = 'realizada'; kind = 'campana'; }

  // 9) conteos y listas por tipo
  if (!kind && !f.cliente && !cuenta && !/lista|muestr|cuales|que .*(hay|tengo)/.test(q)) {
    const r = D.resumen(user, alcance, f.desde, f.hasta), ls = [];
    Object.entries(r.por_tipo).forEach(([k, v]) => ls.push(`- **${k}s**: ${v.total} (${Object.entries(v.estados).map(([e, n]) => `${n} ${e.toLowerCase()}`).join(', ')})`));
    if (!ls.length) return `No encontré órdenes${L}.`;
    const claro = /resumen|general|panorama|como voy|como vamos|todo|estado de la agencia/.test(q);
    return `${claro ? '' : 'No estoy seguro de haber entendido, pero esto es lo que veo'}${claro ? 'Esto es lo que veo' : ''}${L || ' en tu agencia'}:\n\n${ls.join('\n')}\n\nPiezas: ${Object.entries(r.piezas).map(([e, n]) => `${n} ${e.toLowerCase()}`).join(', ') || 'sin piezas pendientes'}. Expedientes incompletos: **${r.expedientes_incompletos}**.\n\nPuedes pedirme el detalle de cualquier tipo, un cliente o un folio.`;
  }
  const b = D.buscar(user, alcance, { ...f, limite: 12 });
  const nom = kind ? { prea: 'PREA', servicio: 'servicio', campana: 'campaña' }[kind] + (b.total === 1 ? '' : 's') : (b.total === 1 ? 'orden' : 'órdenes');
  const filtro = [f.cierre ? (f.cierre === 'activa' ? 'activa' : 'cerrada') + (b.total === 1 ? '' : 's') : '', f.estado ? D.ESTADO[f.estado].toLowerCase() + (b.total === 1 ? '' : 's') : '', f.cliente ? 'de ' + f.cliente : ''].filter(Boolean).join(' ');
  if (!b.total) return `No encontré ${nom}${filtro ? ' ' + filtro : ''}${L}.`;
  const cols = kind === 'campana' ? [COLS.orden, COLS.cliente, COLS.unidad, COLS.estado, COLS.fecha] : kind === 'servicio' ? [COLS.orden, COLS.cliente, COLS.serv, COLS.fecha, COLS.monto] : [COLS.orden, COLS.tipo, COLS.cliente, COLS.estado, COLS.fecha, COLS.monto];
  const head = `${cuenta ? 'Tienes' : 'Encontré'} **${b.total} ${nom}${filtro ? ' ' + filtro : ''}**${L}.`;
  return cuenta && b.total > 12 ? head : `${head}\n\n${table(b.ordenes, cols)}${more(b)}`;
}

/* ---------------- modelo (opcional) ---------------- */
const TOOLS = [
  { name: 'buscar_ordenes', description: 'Busca órdenes de la agencia (PREAs, servicios y campañas) con filtros. Devuelve el total y hasta 40 órdenes recientes.', input_schema: { type: 'object', properties: {
    tipo: { type: 'string', enum: ['prea', 'servicio', 'campana'] }, estado: { type: 'string', enum: ['preaprobada', 'aprobada', 'rechazada', 'atencion', 'pendiente', 'pagada', 'realizada', 'cerrada'] },
    estado_pieza: { type: 'string', enum: ['por_pedir', 'pedida', 'en_planta', 'recibida'] }, cliente: { type: 'string' }, texto: { type: 'string', description: 'folio, VIN, pieza o palabra del detalle' },
    expediente_incompleto: { type: 'boolean' }, cierre: { type: 'string', enum: ['activa', 'cerrada'], description: 'activa = aún no cobrada; cerrada = ya cobrada' }, desde: { type: 'string', description: 'fecha ISO yyyy-mm-dd' }, hasta: { type: 'string', description: 'fecha ISO yyyy-mm-dd' }, limite: { type: 'integer' } } } },
  { name: 'resumen', description: 'Totales por tipo y estado, piezas, expedientes incompletos y monto aprobado/cobrado en un periodo.', input_schema: { type: 'object', properties: { desde: { type: 'string' }, hasta: { type: 'string' } } } },
  { name: 'detalle_orden', description: 'Todos los datos de una orden por su folio (G-…, GA… o S-…).', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'reglas_aprendidas', description: 'Reglas de garantía que ha aprendido el agente.', input_schema: { type: 'object', properties: { texto: { type: 'string' } } } },
  { name: 'cartera', description: 'Cartera de cobros a la planta: total, recuperado, por cobrar, antigüedad de saldos y cobros abiertos (con mínimo de días opcional).', input_schema: { type: 'object', properties: { min_dias: { type: 'integer' } } } },
  { name: 'tpu', description: 'Tiempo por unidad: límite de días, ciclo promedio y PREAs abiertas fuera de tiempo.', input_schema: { type: 'object', properties: {} } }
];
const iso = s => { if (!s) return undefined; const t = new Date(String(s) + (String(s).length <= 10 ? 'T00:00:00' : '')).getTime(); return isNaN(t) ? undefined : t; };
function runTool(user, alcance, name, a) {
  a = a || {};
  if (name === 'buscar_ordenes') return D.buscar(user, alcance, { ...a, desde: iso(a.desde), hasta: a.hasta ? iso(a.hasta) + D.DAY - 1 : undefined, con_pieza: a.estado_pieza ? undefined : false });
  if (name === 'resumen') return D.resumen(user, alcance, iso(a.desde), a.hasta ? iso(a.hasta) + D.DAY - 1 : undefined);
  if (name === 'detalle_orden') return D.detalle(user, alcance, a.id) || { error: 'No existe esa orden en tu agencia.' };
  if (name === 'reglas_aprendidas') return D.reglas(a.texto);
  if (name === 'tpu') return D.tpu(user, alcance);
  if (name === 'cartera') return D.cartera(user, alcance, a.min_dias);
  return { error: 'Herramienta desconocida.' };
}
async function conModelo(user, alcance, historial) {
  const hoy = new Date().toLocaleDateString('es-MX', { dateStyle: 'full' });
  const system = `Eres «Mi Agente», el asistente de ${user.name} en la agencia ${user.agency.name}. Hoy es ${hoy}. Respondes en español de México, claro y breve.\n` +
    'Contestas preguntas sobre las PREAs (garantías), servicios, campañas, piezas y expedientes de la agencia. Usa SIEMPRE las herramientas para consultar datos; nunca inventes cifras, folios ni clientes. ' +
    'Si no hay datos, dilo. Formatea con **negritas**, listas con guiones y tablas en markdown (| a | b |) cuando listes órdenes. Cita el folio de cada orden. ' +
    (alcance === 'mias' ? 'El usuario pidió ver solo sus propias órdenes. ' : '') + 'No des consejos legales ni inventes políticas del fabricante.';
  const messages = historial.map(m => ({ role: m.role, content: m.content }));
  for (let i = 0; i < 6; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages })
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Error del modelo');
    messages.push({ role: 'assistant', content: j.content });
    const usos = j.content.filter(b => b.type === 'tool_use');
    if (j.stop_reason !== 'tool_use' || !usos.length) return j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    messages.push({ role: 'user', content: usos.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(runTool(user, alcance, u.name, u.input)).slice(0, 24000) })) });
  }
  throw new Error('Demasiadas consultas');
}

/* ---------------- rutas ---------------- */
router.post('/chat', async (req, res) => {
  const msg = String((req.body && req.body.mensaje) || '').trim().slice(0, 2000);
  if (!msg) return res.status(400).json({ error: 'Escribe tu pregunta.' });
  const alcance = req.body.alcance === 'mias' ? 'mias' : 'agencia', now = Date.now();
  let hilo = Number(req.body.hilo) || 0;
  if (hilo && !db.prepare('SELECT 1 FROM chat_threads WHERE id = ? AND advisor_id = ?').get(hilo, req.user.id)) hilo = 0;
  if (!hilo) hilo = db.prepare('INSERT INTO chat_threads (advisor_id, title, created_at, updated_at) VALUES (?,?,?,?)').run(req.user.id, msg.length > 60 ? msg.slice(0, 57) + '…' : msg, now, now).lastInsertRowid;
  db.prepare('INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?,?,?,?)').run(hilo, 'user', msg, now);
  const hist = db.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 12').all(hilo).reverse();
  let texto, origen = 'local';
  try {
    if (process.env.ANTHROPIC_API_KEY) { texto = await conModelo(req.user, alcance, hist); origen = 'modelo'; }
  } catch (e) { console.error('Mi Agente: falló el modelo, uso el motor local:', e.message); texto = null; }
  if (!texto) { try { texto = local(req.user, alcance, msg); } catch (e) { console.error(e); texto = 'No pude consultar tus registros en este momento. Intenta de nuevo en unos segundos.'; } }
  db.prepare('INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?,?,?,?)').run(hilo, 'assistant', texto, Date.now());
  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(Date.now(), hilo);
  res.json({ hilo, respuesta: texto, origen });
});
router.get('/chat/hilos', (req, res) => res.json(db.prepare('SELECT id, title, updated_at FROM chat_threads WHERE advisor_id = ? ORDER BY updated_at DESC LIMIT 30').all(req.user.id)));
router.get('/chat/hilos/:id', (req, res) => {
  const h = db.prepare('SELECT id, title FROM chat_threads WHERE id = ? AND advisor_id = ?').get(req.params.id, req.user.id);
  if (!h) return res.status(404).json({ error: 'Conversación no encontrada.' });
  res.json({ ...h, mensajes: db.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id').all(h.id) });
});
router.delete('/chat/hilos/:id', (req, res) => {
  db.prepare('DELETE FROM chat_threads WHERE id = ? AND advisor_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.local = local;
module.exports = router;
