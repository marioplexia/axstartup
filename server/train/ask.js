'use strict';
// Chat de pruebas del agente: responde con lo que aprendió de las PREAs aceptadas y de los pagos de planta.
// Con ANTHROPIC_API_KEY redacta un modelo con ese conocimiento como contexto; sin clave responde un motor local.
const { db } = require('../db');
const P = require('./parse');

const MODEL = process.env.TRAIN_MODEL || process.env.CHAT_MODEL || 'claude-sonnet-5-5';
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const m2 = n => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
const cod = c => c && (c.codigo || c.texto) ? [c.codigo, c.texto].filter(Boolean).join(' · ') : '—';

function conocimiento(agencyId) {
  const docs = db.prepare("SELECT * FROM train_docs WHERE agency_id = ? AND status = 'aprendida' AND kind IN ('prea','pago') ORDER BY id").all(agencyId).map(x => ({ ...x, d: JSON.parse(x.data || '{}') }));
  const preas = docs.filter(x => x.kind === 'prea'), pagos = docs.filter(x => x.kind === 'pago');
  preas.forEach(p => { p.pagos = pagos.filter(g => g.link_id === p.id); });
  const reglas = db.prepare('SELECT * FROM rules WHERE src_historico > 0 ORDER BY n DESC').all();
  return { preas, pagos, reglas };
}

function puntuar(c, p) {
  const d = p.d; let s = 0;
  const eq = (a, b) => a && b && String(a).toUpperCase() === String(b).toUpperCase();
  if (eq(c.queja && c.queja.codigo, d.queja && d.queja.codigo)) s += 6;
  if (eq(c.operacion && c.operacion.codigo, d.operacion && d.operacion.codigo)) s += 6;
  if (eq(c.causa && c.causa.codigo, d.causa && d.causa.codigo)) s += 2;
  if (eq(c.correccion && c.correccion.codigo, d.correccion && d.correccion.codigo)) s += 2;
  if (c.sistema && c.sistema !== 'Por clasificar' && c.sistema === d.sistema) s += 1;
  if (c.modelo && d.modelo && P.norm(c.modelo) === P.norm(d.modelo)) s += 3;
  if (c.anio && d.anio) { const dy = Math.abs(c.anio - d.anio); s += dy === 0 ? 2 : dy === 1 ? 1 : 0; }
  if (c.km && d.km) { const dk = Math.abs(c.km - d.km); s += dk <= 5000 ? 1.5 : dk <= 15000 ? 0.5 : 0; }
  const nums = new Set((d.piezas || []).map(x => (x.numero || '').toUpperCase()));
  (c.piezas || []).forEach(x => { if (x.numero && nums.has(x.numero.toUpperCase())) s += 3; });
  const hay = P.norm([d.queja && d.queja.texto, d.queja && d.queja.detalle, d.causa && d.causa.texto, d.correccion && d.correccion.texto, d.operacion && d.operacion.descripcion, ...(d.piezas || []).map(x => x.descripcion), d.modelo].join(' '));
  const pals = P.palabras([c.queja && c.queja.texto, c.queja && c.queja.detalle, c.causa && c.causa.texto, c.correccion && c.correccion.texto, c.operacion && c.operacion.descripcion, ...(c.piezas || []).map(x => x.descripcion), c._texto].join(' '));
  let h = 0; pals.forEach(w => { if (hay.includes(w) && h < 8) h++; });
  return s + h;
}

function aceptadaEl(d) { return d.fecha_aceptacion || d.fecha || null; }
function ejemplo(p) {
  const d = p.d, veh = [d.marca, d.modelo, d.anio].filter(Boolean).join(' ');
  const pz = (d.piezas || []).map(x => `${x.numero} ${x.descripcion} ×${x.cantidad || 1} (${m2(x.precio)})`).join('; ') || '—';
  return `**PREA aceptada de ejemplo: ${d.folio || d.orden || 'sin folio'}**${d.orden && d.folio ? ' (orden ' + d.orden + ')' : ''} · ${veh || 'vehículo sin identificar'}${d.km ? ' · ' + d.km.toLocaleString('en-US') + ' km' : ''}${aceptadaEl(d) ? ' · aceptada el ' + fmt(aceptadaEl(d)) : ''}\n\n` +
    ['| Campo | Cómo se llenó |', '| --- | --- |', `| Queja | ${cod(d.queja)} |`, `| Causa | ${cod(d.causa)} |`, `| Corrección | ${cod(d.correccion)} |`,
      `| Operación | ${[d.operacion && d.operacion.codigo, d.operacion && d.operacion.descripcion].filter(Boolean).join(' · ') || '—'} |`, `| Tiempo | ${d.horas != null ? d.horas + ' h' : '—'} |`,
      `| Piezas | ${pz} |`, `| Total | ${m2(d.total_bruto)} |`, `| Autorización | ${d.codigo_autorizacion || '—'} |`].join('\n');
}
function leccionesDe(p) {
  const l = (p.d.lecciones || []);
  if (!l.length) return '';
  return '**Errores que tuvo en el pasado y cómo se corrigieron**\n\n' + l.map(x => `- ${x.fecha ? fmt(x.fecha) + ' · ' : ''}${x.tipo === 'rechazo' ? 'La planta la rechazó' : 'La planta pidió corregir'}: «${x.problema}»${x.correccion ? ' Se corrigió así: «' + x.correccion + '»' : ''}`).join('\n');
}
function pagoDe(p) {
  if (!p.pagos || !p.pagos.length) return '';
  const d = p.d;
  return '**Lo que pagó la planta**\n\n' + p.pagos.map(g => {
    const x = g.d, aj = (x.ajustes || []).filter(a => a.monto).map(a => `${a.concepto} (${m2(a.monto)})`).join(', '), dif = [];
    if (d.horas != null && x.horas_pagadas != null && d.horas !== x.horas_pagadas) dif.push(`se solicitaron ${d.horas} h y se pagaron ${x.horas_pagadas} h`);
    (x.piezas || []).forEach(pg => { const q = (d.piezas || []).find(y => (y.numero || '').toUpperCase() === (pg.numero || '').toUpperCase()); if (q && q.precio != null && pg.monto_pagado != null && Math.abs(q.precio - pg.monto_pagado) > 0.005) dif.push(`${pg.numero}: se solicitó ${m2(q.precio)} y la planta pagó ${m2(pg.monto_pagado)}`); });
    if (d.total_bruto != null && x.total_pagado != null && Math.abs(d.total_bruto - x.total_pagado) > 0.005) dif.push(`se solicitaron ${m2(d.total_bruto)} y se pagaron ${m2(x.total_pagado)}`);
    return `- ${x.referencia_pago || 'Pago'}${x.fecha_pago ? ' (' + fmt(x.fecha_pago) + ')' : ''}: ${x.horas_pagadas != null ? x.horas_pagadas + ' h' : ''}${x.tarifa_mo ? ' × ' + m2(x.tarifa_mo) : ''}${x.mano_obra_pagada != null ? ' = ' + m2(x.mano_obra_pagada) + ' de mano de obra' : ''}; piezas ${m2(x.total_piezas_pagado)}${aj ? '; ajustes: ' + aj : ''}; **total pagado ${m2(x.total_pagado)}**` +
      (dif.length ? `\n  - Diferencias frente a lo que se solicitó: ${dif.join('; ')}.` : '\n  - La planta pagó exactamente lo solicitado.');
  }).join('\n');
}
function reglaDe(p) {
  if (!p.rule_id) return '';
  const r = db.prepare('SELECT * FROM rules WHERE id = ?').get(p.rule_id); if (!r) return '';
  const tot = r.n + 2 * (r.rej || 0), conf = Math.max(1, Math.min(98, Math.round(100 * (1 - Math.exp(-r.n / 3)) * (r.n / Math.max(tot, 1)))));
  return `**Regla aprendida:** ${r.id} · ${r.n} ${r.n === 1 ? 'PREA aceptada' : 'PREAs aceptadas'} · confianza ${conf}% · ${r.status}${r.paid_n ? ` · la planta ha pagado ${r.paid_n} ${r.paid_n === 1 ? 'vez' : 'veces'} (${(r.paid_hours_sum / r.paid_n).toFixed(1)} h en promedio)` : ''}`;
}

// Compara el caso del usuario con la PREA aceptada y devuelve lo que hay que corregir
function comparar(c, p) {
  const d = p.d, out = [], temas = new Set((d.lecciones || []).flatMap(l => l.temas || []));
  const hayCause = c.causa && c.causa.codigo, pago = (p.pagos || [])[0] && p.pagos[0].d;
  const ok = t => out.push({ n: 'ok', t }), er = t => out.push({ n: 'error', t }), av = t => out.push({ n: 'aviso', t });
  const same = (a, b) => a && b && String(a).toUpperCase() === String(b).toUpperCase();
  if (c.queja && c.queja.codigo) same(c.queja.codigo, d.queja.codigo) ? ok(`La queja ${c.queja.codigo} coincide con la PREA aceptada.`) : av(`Tu queja es ${c.queja.codigo} y la de la PREA aceptada ${d.queja.codigo}; confirma que sea el mismo caso.`);
  if (hayCause) same(c.causa.codigo, d.causa.codigo) ? ok(`La causa ${c.causa.codigo} es la correcta.`) : er(`Tu causa ${c.causa.codigo}${c.causa.texto ? ' (' + c.causa.texto.toLowerCase() + ')' : ''} no corresponde a la queja. En la PREA aceptada se usó **${cod(d.causa)}**.${temas.has('código de causa') ? ' Así la rechazaron antes.' : ''}`);
  else if (c.causa !== undefined && c._doc) av(`No capturaste el código de causa; en la PREA aceptada fue **${cod(d.causa)}**.`);
  if (c.correccion && c.correccion.codigo && !same(c.correccion.codigo, d.correccion.codigo)) av(`Tu corrección es ${c.correccion.codigo}; la aceptada usó ${cod(d.correccion)}.`);
  if (c.operacion && c.operacion.codigo) same(c.operacion.codigo, d.operacion.codigo) ? ok(`La operación ${c.operacion.codigo} es la misma.`) : av(`Tu operación es ${c.operacion.codigo}; la aceptada usó ${d.operacion.codigo}.`);
  else if (c._doc) av(`No capturaste la operación de trabajo; la aceptada usó **${d.operacion.codigo}**.`);
  const estandar = pago && pago.horas_pagadas != null ? pago.horas_pagadas : d.horas;
  if (c.horas != null && estandar != null) c.horas > estandar * 1.05 ? er(`Capturaste **${c.horas} h** y la planta paga **${estandar} h** ${pago ? '(tiempo pagado)' : '(tiempo de la PREA aceptada)'}.${temas.has('tiempo de mano de obra') ? ' La planta pidió justificar ese tiempo antes.' : ''}`) : ok(`El tiempo de ${c.horas} h está dentro de lo que paga la planta (${estandar} h).`);
  else if (c._doc && c.horas == null) av(`No capturaste el tiempo de trabajo; la planta paga ${estandar} h.`);
  const nums = (c.piezas || []).map(x => (x.numero || '').toUpperCase());
  (d.piezas || []).forEach(x => { if (c._doc && !nums.includes((x.numero || '').toUpperCase())) av(`Falta la pieza **${x.numero} ${x.descripcion}** que sí se incluyó en la PREA aceptada.`); });
  (c.piezas || []).forEach(x => {
    const ref = (d.piezas || []).find(y => (y.numero || '').toUpperCase() === (x.numero || '').toUpperCase());
    if (!ref) { av(`La pieza ${x.numero} ${x.descripcion || ''} no aparece en la PREA aceptada; justifícala.`); return; }
    const pg = pago && (pago.piezas || []).find(y => (y.numero || '').toUpperCase() === (x.numero || '').toUpperCase()), precio = pg && pg.monto_pagado != null ? pg.monto_pagado : ref.precio;
    if (x.precio != null && precio != null && Math.abs(x.precio - precio) > 0.5) av(`El precio de ${x.numero} es ${m2(x.precio)}; ${pg ? 'la planta pagó' : 'la PREA aceptada usó'} ${m2(precio)}.`);
  });
  if (c._doc) {
    if (!c.km) (temas.has('kilometraje') ? er : av)(`Falta el **kilometraje exacto**.${temas.has('kilometraje') ? ' Fue una de las razones del rechazo anterior.' : ''}`); else ok(`Kilometraje capturado (${c.km.toLocaleString('en-US')} km).`);
    if (!c.vin) av('Falta el VIN.');
  }
  if (temas.has('fotografías') || temas.has('evidencia')) av(`Adjunta ${[temas.has('fotografías') ? 'las fotografías del componente' : '', temas.has('evidencia') ? 'el ticket de diagnóstico o la captura GDS2' : ''].filter(Boolean).join(' y ')}: la planta lo pidió en la PREA aceptada.`);
  if (c.total_bruto != null && c.horas != null) { const esperado = c.horas * (c.tarifa_mo || d.tarifa_mo || 0) + (c.piezas || []).reduce((s, x) => s + (x.precio || 0) * (x.cantidad || 1), 0); if (esperado && Math.abs(esperado - c.total_bruto) / esperado > 0.05) av(`El total bruto ${m2(c.total_bruto)} no coincide con horas × tarifa + piezas (${m2(esperado)}).`); }
  return out;
}
function recomendacion(c, p) {
  const d = p.d, pago = (p.pagos || [])[0] && p.pagos[0].d, h = pago && pago.horas_pagadas != null ? pago.horas_pagadas : d.horas;
  const row = (k, v, ch) => `| ${k} | ${v}${ch ? ' ← corregido' : ''} |`, same = (a, b) => a && b && String(a).toUpperCase() === String(b).toUpperCase();
  return '**Así debería quedar tu PREA**\n\n' + ['| Campo | Valor sugerido |', '| --- | --- |',
    row('Queja', cod(d.queja), c.queja && c.queja.codigo && !same(c.queja.codigo, d.queja.codigo)), row('Causa', cod(d.causa), c.causa && !same(c.causa.codigo, d.causa.codigo)),
    row('Corrección', cod(d.correccion), c.correccion && c.correccion.codigo && !same(c.correccion.codigo, d.correccion.codigo)), row('Operación', [d.operacion.codigo, d.operacion.descripcion].filter(Boolean).join(' · '), c.operacion && c.operacion.codigo && !same(c.operacion.codigo, d.operacion.codigo)),
    row('Tiempo', h != null ? h + ' h' : '—', c.horas != null && h != null && c.horas !== h), row('Piezas', (d.piezas || []).map(x => `${x.numero} ×${x.cantidad || 1}`).join(', ') || '—', false)].join('\n');
}

function resumenGeneral(k) {
  if (!k.preas.length && !k.pagos.length) return 'Todavía no he aprendido nada. Sube PREAs aceptadas y transacciones pagadas en **Tablero de agencia → Entrenamiento** y vuelve a preguntarme.';
  const temas = {}; k.preas.forEach(p => (p.d.lecciones || []).forEach(l => (l.temas || []).forEach(t => { temas[t] = (temas[t] || 0) + 1; })));
  const top = Object.entries(temas).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} (${n})`).join(', ');
  return `He aprendido **${k.preas.length} ${k.preas.length === 1 ? 'PREA aceptada' : 'PREAs aceptadas'}** y **${k.pagos.length} ${k.pagos.length === 1 ? 'transacción pagada' : 'transacciones pagadas'}**, que forman **${k.reglas.length} ${k.reglas.length === 1 ? 'regla' : 'reglas'}**.\n\n` +
    (k.reglas.length ? '| Regla | Sistema | Queja | Operación | PREAs | Pagos |\n| --- | --- | --- | --- | --- | --- |\n' + k.reglas.slice(0, 10).map(r => `| ${r.id} | ${r.sys} | ${r.q_text} | ${r.op} | ${r.n} | ${r.paid_n} |`).join('\n') : '') +
    (top ? `\n\nErrores más comunes en el historial de comentarios: ${top}.` : '') + '\n\nPregúntame por un caso concreto, por ejemplo «cambio de polea de un Aveo 2024 de 40 mil km», o sube una PREA para validarla.';
}
const STOP_PAGO = new Set(['cuanto', 'cuantos', 'paga', 'pago', 'pagan', 'pagos', 'planta', 'pagado', 'pagada', 'transaccion', 'transacciones', 'tarifa', 'sobre', 'cuanta', 'pagaron', 'fabricante']);
function preguntaPagos(k, q) {
  const pals = P.palabras(q).filter(w => !STOP_PAGO.has(w)), rel = g => { const pr = k.preas.find(p => p.id === g.link_id); return P.norm(JSON.stringify(g.d) + (pr ? JSON.stringify(pr.d) : '')); };
  const sel = k.pagos.filter(g => pals.length && pals.some(w => rel(g).includes(w)));
  const lista = (sel.length ? sel : k.pagos).slice(0, 6);
  if (!lista.length) return 'Todavía no he aprendido transacciones pagadas. Súbelas en **Entrenamiento → Transacciones pagadas de planta**.';
  return `Esto es lo que ha pagado la planta${sel.length || !pals.length ? '' : ' (no encontré un pago de ese tema; te muestro los más recientes)'}:\n\n| Pago | Operación | Horas | Mano de obra | Piezas | Total |\n| --- | --- | --- | --- | --- | --- |\n` +
    lista.map(g => { const x = g.d; return `| ${x.referencia_pago || g.name} | ${x.operacion && x.operacion.codigo || '—'} | ${x.horas_pagadas ?? '—'} | ${m2(x.mano_obra_pagada)} | ${m2(x.total_piezas_pagado)} | ${m2(x.total_pagado)} |`; }).join('\n');
}
function preguntaErrores(k, q, top) {
  const base = top.length ? top.map(t => t.p) : k.preas, ls = base.filter(p => (p.d.lecciones || []).length).slice(0, 4);
  if (!ls.length) return 'En las PREAs que aprendí no hay rechazos ni correcciones en el historial de comentarios.';
  return '**Errores que encontré en el historial de comentarios y cómo se corrigieron**\n\n' + ls.map(p => `PREA ${p.d.folio || p.d.orden} · ${[p.d.modelo, p.d.anio].filter(Boolean).join(' ')}:\n${(p.d.lecciones).map(x => `- «${x.problema}»${x.correccion ? ' → ' + x.correccion : ''}`).join('\n')}`).join('\n\n');
}

function localResponder({ k, mensaje, cand, subido }) {
  const q = P.norm(mensaje || '');
  if (!k.preas.length && !k.pagos.length) return resumenGeneral(k);
  if (!subido && /^\s*(hola|buenas|buenos dias|buenas tardes|que tal|hey)\W*$/.test(q)) return '¡Hola! Soy el agente de pruebas. Pregúntame cualquier cosa de lo que aprendí o sube una PREA para ver cómo la corregiría con base en las PREAs aceptadas.';
  const puntajes = k.preas.map(p => ({ p, s: puntuar(cand, p) })).sort((a, b) => b.s - a.s), top = puntajes.filter(x => x.s >= 4);
  if (!subido) {
    if (/pag(o|ó|a|aron|ada|adas)\b|tarifa|cuanto (paga|pago|pagan)|transaccion/.test(q) && !top.length) return preguntaPagos(k, mensaje);
    if (/que (has )?aprend|que sabes|resumen|cuantas|cuantos|conocimiento|todo lo que/.test(q) && !top.length) return resumenGeneral(k);
    if (/\breglas?\b/.test(q) && !top.length) return resumenGeneral(k);
    if (/error|rechaz|lecci|por que|corrig/.test(q)) return preguntaErrores(k, mensaje, top);
  }
  if (!top.length) return `No tengo una PREA aceptada parecida a ${subido ? 'la que subiste' : 'ese caso'}. ` + resumenGeneral(k);
  const best = top[0].p, partes = [];
  partes.push(subido ? `Analicé tu PREA${cand.resumen ? ' (' + cand.resumen + ')' : ''} y la comparé con lo que aprendí. Encontré **${top.length} ${top.length === 1 ? 'PREA aceptada parecida' : 'PREAs aceptadas parecidas'}**; la más cercana es esta:` : `Encontré **${top.length} ${top.length === 1 ? 'PREA aceptada parecida' : 'PREAs aceptadas parecidas'}**. Esto fue lo que sí funcionó:`);
  partes.push(ejemplo(best));
  const pg = pagoDe(best), ls = leccionesDe(best), rg = reglaDe(best);
  if (ls) partes.push(ls);
  if (pg) partes.push(pg);
  if (rg) partes.push(rg);
  if (subido || cand.horas != null || (cand.piezas || []).length || (cand.causa && cand.causa.codigo)) {
    const cmp = comparar(cand, best);
    if (cmp.length) {
      const e = cmp.filter(x => x.n === 'error'), a = cmp.filter(x => x.n === 'aviso'), o = cmp.filter(x => x.n === 'ok');
      partes.push('**Revisión de tu PREA contra ese ejemplo**\n\n' + [...e.map(x => '- ❌ ' + x.t), ...a.map(x => '- ⚠️ ' + x.t), ...o.map(x => '- ✅ ' + x.t)].join('\n'));
      if (e.length || a.length) partes.push(recomendacion(cand, best));
    }
  } else {
    const temas = [...new Set((best.d.lecciones || []).flatMap(l => l.temas || []))];
    if (temas.length) partes.push(`**Antes de enviarla revisa:** ${temas.join(', ')}.`);
  }
  if (top.length > 1) partes.push('También encontré: ' + top.slice(1, 3).map(x => `PREA ${x.p.d.folio || x.p.d.orden} (${[x.p.d.modelo, x.p.d.anio].filter(Boolean).join(' ')} · ${x.p.d.queja && x.p.d.queja.texto ? x.p.d.queja.texto.toLowerCase() : ''})`).join('; ') + '.');
  return partes.join('\n\n');
}

/* ---------- Con modelo ---------- */
async function conModelo({ k, mensaje, cand, subido, historial, user }) {
  const tops = k.preas.map(p => ({ p, s: puntuar(cand, p) })).sort((a, b) => b.s - a.s).slice(0, 4).filter(x => x.s >= 2 || k.preas.length <= 4);
  const ctx = {
    prea_aceptadas_similares: tops.map(({ p, s }) => ({ puntaje_similitud: s, folio: p.d.folio, orden: p.d.orden, vehiculo: [p.d.marca, p.d.modelo, p.d.anio].filter(Boolean).join(' '), km: p.d.km, fecha_aceptacion: aceptadaEl(p.d),
      queja: p.d.queja, causa: p.d.causa, correccion: p.d.correccion, operacion: p.d.operacion, horas: p.d.horas, tarifa_mo: p.d.tarifa_mo, piezas: p.d.piezas, total_bruto: p.d.total_bruto, codigo_autorizacion: p.d.codigo_autorizacion,
      comentarios: (p.d.comentarios || []).map(c => `${fmt(c.fecha)} ${c.origen}: ${c.texto}`), lecciones: p.d.lecciones, pagos_de_planta: (p.pagos || []).map(g => g.d) })),
    reglas_aprendidas: k.reglas.slice(0, 12).map(r => ({ id: r.id, sistema: r.sys, queja: r.q_text, operacion: r.op, horas_promedio: r.n ? +(r.hours_sum / r.n).toFixed(2) : null, preas: r.n, pagos: r.paid_n, estado: r.status })),
    totales: { preas: k.preas.length, pagos: k.pagos.length },
    caso_del_usuario: subido ? cand : (cand._texto ? { descripcion: cand._texto } : null)
  };
  const system = `Eres el agente de garantías de ${user.agency.name}, en modo de pruebas. Respondes en español de México, claro y práctico, a ${user.name}.\n` +
    'Respondes SOLO con el conocimiento que se te da (PREAs aceptadas, su historial de comentarios, los pagos de planta y las reglas aprendidas). No inventes códigos, piezas, tiempos ni precios. Si no hay una PREA parecida, dilo.\n' +
    'Cuando el usuario sube una PREA o describe un caso: 1) muestra la PREA aceptada más parecida como ejemplo (folio, vehículo, km, fecha y los campos tal como se llenaron, en una tabla markdown); 2) explica los errores que tuvo esa PREA en el pasado (rechazos y solicitudes de la planta) y cómo se corrigieron; 3) di lo que pagó la planta; 4) compara la PREA del usuario campo por campo y señala qué debe corregir (causa, corrección, operación, tiempo, piezas, kilometraje, evidencias); 5) cierra con cómo debería quedar. Usa **negritas**, listas con guiones y tablas | a | b |.';
  const messages = historial.slice(-8).map(m => ({ role: m.role, content: m.content }));
  messages[messages.length - 1] = { role: 'user', content: `${messages[messages.length - 1].content}\n\n<conocimiento>\n${JSON.stringify(ctx).slice(0, 60000)}\n</conocimiento>` };
  const r = await fetch(BASE + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(90000), headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, max_tokens: 2500, system, messages }) });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Error del modelo');
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function responder({ user, mensaje, subidos = [], historial = [] }) {
  const k = conocimiento(user.agency.id);
  const doc = subidos.find(s => s.d && s.d.tipo === 'prea');
  const cand = doc ? Object.assign({}, doc.d, { _doc: true, _texto: mensaje }) : Object.assign(P.parseTexto(mensaje || ''), { _texto: mensaje });
  const subido = !!doc;
  let texto = null, origen = 'local';
  if (process.env.ANTHROPIC_API_KEY && (k.preas.length || k.pagos.length)) {
    try { texto = await conModelo({ k, mensaje, cand, subido, historial, user }); origen = 'modelo'; } catch (e) { console.error('Agente de pruebas: falló el modelo, uso el motor local:', e.message); }
  }
  if (!texto) texto = localResponder({ k, mensaje, cand, subido });
  const fallidos = subidos.filter(s => !s.d || s.d.tipo !== 'prea');
  if (fallidos.length) texto += `\n\nNo pude leer como PREA: ${fallidos.map(s => s.name + (s.error ? ' (' + s.error + ')' : '')).join(', ')}.`;
  return { texto, origen };
}

module.exports = { responder, conocimiento, puntuar, localResponder };
