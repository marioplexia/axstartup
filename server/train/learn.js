'use strict';
// Aprendizaje: de cada PREA aceptada sale (o se refuerza) una regla del catálogo; cada pago de planta corrige horas y precios.
const crypto = require('crypto');
const { db, logEvent } = require('../db');
const P = require('./parse');
const B = require('../brain/brain');

const getSet = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : d; };
const putSet = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const bumpRev = () => putSet('rev', Number(getSet('rev', 0)) + 1);
const nextRuleId = () => { const n = Math.max(Number(getSet('seq', 0)), Number((db.prepare('SELECT COUNT(*) n FROM rules').get() || {}).n)) + 1; putSet('seq', n); return 'R-' + ('000' + n).slice(-4); };
const hash6 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6).toUpperCase();
const r1 = n => Math.round(n * 100) / 100;

function keywords(d) {
  const v = [d.modelo, d.queja && d.queja.texto, d.queja && d.queja.detalle, d.causa && d.causa.texto, ...(d.piezas || []).map(p => p.descripcion)].join(' ');
  return P.palabras(v).slice(0, 12);
}

const vehiculo = d => [d.marca, d.modelo, d.anio].filter(Boolean).join(' ');
function claveRegla(d) {
  const sys = d.sistema || 'Por clasificar';
  return { sys, qCode: (d.queja.codigo || '') || 'SC-' + hash6(P.norm(d.queja.texto || d.operacion.descripcion || '')) };
}
const CAMPOS_FIJOS = [['unidad', 'Unidad de negocio'], ['tipo_transaccion', 'Tipo de transacción'], ['bac', 'BAC'], ['reparador', 'Reparador'], ['marcador', 'Marcador de transacción'], ['contacto', 'Nombre de contacto'], ['telefono', 'Teléfono'], ['email', 'Correo del contacto']];
const leerDefaults = agencyId => { const m = {}; db.prepare('SELECT campo, valor FROM agency_defaults WHERE agency_id = ? AND n > 0').all(agencyId || 0).forEach(x => { (m[x.campo] = m[x.campo] || {})[x.valor] = 1; }); return m; };
function guardarVariante(doc, ruleId, d, h) {
  const ex = d.campos_extra || {};
  db.prepare(`INSERT INTO rule_variants (rule_id, doc_id, marca, modelo, anio, km, op, op_desc, c_code, c_text, r_code, r_text, hours, parts, tarifa, total_piezas, total_bruto, marcador, extra, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ruleId, doc.id, d.marca || '', d.modelo || '', d.anio || null, d.km || null, d.operacion.codigo || '', d.operacion.descripcion || '', d.causa.codigo || '', d.causa.texto || '', d.correccion.codigo || '', d.correccion.texto || '',
      h, JSON.stringify((d.piezas || []).map(p => [p.numero || 'S/N', p.descripcion || '', p.cantidad || 1, p.precio || 0])), d.tarifa_mo || null, d.total_piezas != null ? d.total_piezas : null, d.total_bruto != null ? d.total_bruto : null,
      ex.marcador || '', JSON.stringify({ tipo_transaccion: ex.tipo_transaccion, deducible: ex.deducible, tiempo_adicional: ex.tiempo_adicional, olh: ex.olh, elementos_adicionales: ex.elementos_adicionales }), Date.now());
}
// Datos fijos de CADA agencia (BAC, reparador, contacto...): se aprende el valor más frecuente de sus PREAs aceptadas
function sumarDefaults(agencyId, d, signo) {
  const ex = d.campos_extra || {}, usados = [];
  CAMPOS_FIJOS.forEach(([k]) => {
    const v = ex[k]; if (!v) return;
    db.prepare('INSERT INTO agency_defaults (agency_id, campo, valor, n) VALUES (?,?,?,?) ON CONFLICT(agency_id, campo, valor) DO UPDATE SET n = MAX(0, n + ?)').run(agencyId || 0, k, String(v), Math.max(0, signo), signo);
    usados.push([k, v]);
  });
  return usados;
}
const igual = (a, b) => String(a == null ? '' : a).trim().toUpperCase() === String(b == null ? '' : b).trim().toUpperCase();
const cod = c => c && (c.codigo || c.texto) ? [c.codigo, c.texto].filter(Boolean).join(' · ') : '';
function guardarLecciones(doc, k, lecs, origen) {
  const out = { nuevas: [], confirmadas: [] }, ag = doc.agency_id, now = Date.now();
  (lecs || []).forEach(l => {
    if (!l || !l.problema) return;
    const problema = B.anonimizar(l.problema), correccion = B.anonimizar(l.correccion || '');
    const ex = db.prepare('SELECT * FROM train_lessons WHERE sys = ? AND q_code = ? AND problema = ?').get(k.sys, k.qCode, problema);
    if (ex) {            // otra agencia (o el mismo error otra vez): se confirma y sube su peso
      const ags = JSON.parse(ex.agencias || '[]'), nueva = ag != null && !ags.includes(ag); if (nueva) ags.push(ag);
      db.prepare('UPDATE train_lessons SET veces = veces + 1, agencias = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ags), now, ex.id);
      out.confirmadas.push({ problema, agencias: ags.length, veces: ex.veces + 1, nuevaAgencia: nueva });
      return;
    }
    db.prepare('INSERT INTO train_lessons (doc_id, sys, q_code, problema, correccion, temas, tipo, origen, fecha, created_at, agency_id, veces, agencias, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(doc.id, k.sys, k.qCode, problema, correccion, JSON.stringify(l.temas || []), l.tipo || 'rechazo', origen, l.fecha || null, now, ag != null ? ag : null, 1, JSON.stringify(ag != null ? [ag] : []), now);
    out.nuevas.push({ problema, correccion, temas: l.temas || [] });
  });
  return out;
}
// Difunde a toda la red lo que se acaba de aprender
function avisarRed(doc, k, regla, res, tipo, titulo, sufijo) {
  if (!res.nuevas.length) return;
  const n = res.nuevas[0], mas = res.nuevas.length > 1 ? ` (y ${res.nuevas.length - 1} más)` : '';
  B.alerta({ tipo, severidad: tipo === 'leccion' ? 'aviso' : 'alta', titulo, texto: `${n.problema}${n.correccion ? ' → ' + n.correccion : ''}${mas}${sufijo || ''}`, rule_id: regla ? regla.id : null, sys: k.sys, q_code: k.qCode, agency_id: doc.agency_id });
}

function aprenderPrea(doc, d) {
  const now = Date.now(), K = claveRegla(d), sys = K.sys, qCode = K.qCode;
  let rule = db.prepare('SELECT * FROM rules WHERE sys = ? AND q_code = ?').get(sys, qCode), kind, val = [], contextoNuevo = false;
  const hRaw = Number(d.horas) || 0, pz = d.piezas || [];
  const h = hRaw || (rule ? rule.hours_sum / Math.max(rule.n, 1) : 0);
  const insPart = db.prepare('INSERT INTO rule_parts (rule_id, part_no, descr, qty, price, n) VALUES (?,?,?,?,?,1) ON CONFLICT(rule_id, part_no) DO UPDATE SET n = n + 1, qty = excluded.qty, price = excluded.price, descr = excluded.descr');
  const insKw = db.prepare('INSERT OR IGNORE INTO rule_keywords (rule_id, keyword) VALUES (?, ?)');
  if (!rule) {
    const id = nextRuleId();
    db.prepare(`INSERT INTO rules (id, sys, q_code, q_text, c_code, c_text, r_code, r_text, op, op_desc, hours, hours_sum, n, rej, status, src_base, src_historico, src_asesor, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,'aprendizaje',0,1,0,?,?)`)
      .run(id, sys, qCode, d.queja.texto || '', d.causa.codigo || '', d.causa.texto || '', d.correccion.codigo || '', d.correccion.texto || '', d.operacion.codigo || '', d.operacion.descripcion || '', hRaw, hRaw, now, now);
    pz.forEach(p => insPart.run(id, p.numero || 'S/N', p.descripcion || '', p.cantidad || 1, p.precio || 0));
    keywords(d).forEach(w => insKw.run(id, w));
    logEvent('creada', id, `Regla nueva ${id}: ${(d.queja.texto || '').toLowerCase()} → ${d.operacion.codigo || d.operacion.descripcion} (${sys}) · aprendida de «${doc.name}»`);
    rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(id); kind = 'creada';
    val.push({ nivel: 'ok', campo: 'regla', texto: `Se creó la regla ${id} con esta PREA.` });
  } else {
    const avg = rule.hours_sum / Math.max(rule.n, 1), parts = db.prepare('SELECT part_no FROM rule_parts WHERE rule_id = ?').all(rule.id).map(x => x.part_no);
    const previas = db.prepare('SELECT modelo, anio FROM rule_variants WHERE rule_id = ?').all(rule.id), veh = vehiculo(d);
    const dif = [];
    if (rule.op && d.operacion.codigo && rule.op !== d.operacion.codigo) dif.push(`opera con ${d.operacion.codigo} (la regla principal usa ${rule.op})`);
    if (rule.c_code && d.causa.codigo && rule.c_code !== d.causa.codigo) dif.push(`usa la causa ${d.causa.codigo} (la regla principal, ${rule.c_code})`);
    if (rule.r_code && d.correccion.codigo && rule.r_code !== d.correccion.codigo) dif.push(`usa la corrección ${d.correccion.codigo} (la regla principal, ${rule.r_code})`);
    if (hRaw && avg && Math.abs(hRaw - avg) / avg > 0.2) dif.push(`toma ${hRaw} h (promedio de la regla, ${r1(avg)} h)`);
    const nuevas = pz.filter(p => p.numero && !parts.includes(p.numero)).map(p => p.numero);
    if (nuevas.length) dif.push(`incluye piezas nuevas (${nuevas.join(', ')})`);
    const modeloNuevo = d.modelo && !previas.some(v => P.norm(v.modelo || '') === P.norm(d.modelo));
    contextoNuevo = !!modeloNuevo;
    if (modeloNuevo) val.push({ nivel: 'ok', campo: 'contexto', texto: `Contexto nuevo para la regla ${rule.id}: ${veh}.` });
    if (dif.length) val.push({ nivel: 'aviso', campo: 'variante', texto: `Variante aprendida${veh ? ' para ' + veh : ''}: ${dif.join('; ')}.` });
    if (!val.length) val.push({ nivel: 'ok', campo: 'regla', texto: `Coincide con la regla ${rule.id}.` });
    db.prepare('UPDATE rules SET n = n + 1, hours_sum = hours_sum + ?, hours = (hours_sum + ?) / (n + 1), src_historico = src_historico + 1, updated_at = ? WHERE id = ?').run(h, h, now, rule.id);
    pz.forEach(p => insPart.run(rule.id, p.numero || 'S/N', p.descripcion || '', p.cantidad || 1, p.precio || 0));
    const cnt = db.prepare('SELECT COUNT(*) n FROM rule_keywords WHERE rule_id = ?').get(rule.id).n;
    keywords(d).slice(0, Math.max(0, 14 - cnt)).forEach(w => insKw.run(rule.id, w));
    rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(rule.id); kind = 'reforzada';
    logEvent('reforzada', rule.id, `Regla ${rule.id} reforzada con la PREA «${doc.name}» · ${rule.n} en total`);
  }
  // Reglas por campo: qué valor aprendió de cada campo del formulario y si ya lo conocía
  const prev = db.prepare('SELECT * FROM rule_variants WHERE rule_id = ?').all(rule.id), ex = d.campos_extra || {}, reglas = [], defs = leerDefaults(doc.agency_id);
  const base = kind === 'creada' ? null : rule;
  const campo = (nombre, valor, conocido) => { if (valor == null || valor === '') return; reglas.push({ campo: nombre, valor: String(valor), estado: kind === 'creada' ? 'nuevo' : (conocido ? 'igual' : 'distinto') }); };
  campo('Queja', cod(d.queja), base && igual(base.q_code, d.queja.codigo));
  campo('Causa', cod(d.causa), base && prev.some(v => igual(v.c_code, d.causa.codigo)));
  campo('Corrección', cod(d.correccion), base && prev.some(v => igual(v.r_code, d.correccion.codigo)));
  campo('Operación de trabajo', [d.operacion.codigo, d.operacion.descripcion].filter(Boolean).join(' · '), base && prev.some(v => igual(v.op, d.operacion.codigo)));
  campo('Tiempo de trabajo', hRaw ? hRaw + ' h' : '', base && prev.some(v => v.hours === hRaw));
  campo('Números de pieza', pz.map(p => p.numero).join(', '), base && prev.some(v => JSON.parse(v.parts || '[]').map(x => x[0]).join(',') === pz.map(p => p.numero).join(',')));
  campo('Total de piezas', d.total_piezas != null ? '$' + d.total_piezas.toLocaleString('en-US') : '', base && prev.some(v => v.total_piezas === d.total_piezas));
  campo('Tarifa mano de obra', d.tarifa_mo ? '$' + d.tarifa_mo : '', base && prev.some(v => v.tarifa === d.tarifa_mo));
  campo('Total bruto', d.total_bruto != null ? '$' + d.total_bruto.toLocaleString('en-US') : '', base && prev.some(v => v.total_bruto === d.total_bruto));
  CAMPOS_FIJOS.forEach(([k, n]) => campo(n, ex[k], base && Object.keys(defs[k] || {}).some(x => igual(x, ex[k]))));
  campo('Deducible', ex.deducible != null ? '$' + ex.deducible : '', base && prev.some(v => (JSON.parse(v.extra || '{}')).deducible === ex.deducible));
  if (ex.tiempo_adicional) campo('Tiempo adicional', ex.tiempo_adicional + ' h', false);
  // Totales: el total bruto debe ser tiempo x tarifa + piezas
  const esperado = hRaw && d.tarifa_mo ? +(hRaw * d.tarifa_mo + (d.total_piezas != null ? d.total_piezas : pz.reduce((t, p) => t + (p.precio || 0) * (p.cantidad || 1), 0))).toFixed(2) : null;
  if (esperado && d.total_bruto != null && Math.abs(esperado - d.total_bruto) / Math.max(d.total_bruto, 1) > 0.03) val.push({ nivel: 'aviso', campo: 'totales', texto: `El total bruto ($${d.total_bruto.toLocaleString('en-US')}) no coincide con tiempo × tarifa + piezas ($${esperado.toLocaleString('en-US')}); se guardó tal como vino.` });
  const faltan = [!d.causa.codigo && !d.causa.texto && 'causa', !d.correccion.codigo && !d.correccion.texto && 'corrección', !(hRaw > 0) && 'tiempo', !pz.length && 'piezas', !d.tarifa_mo && 'tarifa', d.total_bruto == null && 'total bruto'].filter(Boolean);
  if (faltan.length) val.push({ nivel: 'aviso', campo: 'campos', texto: `Faltaron estos campos en el documento (se aprendió todo lo demás): ${faltan.join(', ')}.` });
  d._reglas = reglas;
  guardarVariante(doc, rule.id, d, hRaw);
  d._defs = sumarDefaults(doc.agency_id, d, +1);
  const nl = guardarLecciones(doc, K, d.lecciones, 'aceptada');
  if (nl.nuevas.length) val.push({ nivel: 'ok', campo: 'errores', texto: `Aprendí ${nl.nuevas.length} ${nl.nuevas.length === 1 ? 'error del historial' : 'errores del historial'} de esta queja.` });
  if (nl.confirmadas.length) val.push({ nivel: 'ok', campo: 'red', texto: `${nl.confirmadas.length} ${nl.confirmadas.length === 1 ? 'error ya lo conocía el cerebro' : 'errores ya los conocía el cerebro'}: se confirmaron con esta agencia.` });
  const vehTxt = vehiculo(d), hTxt = hRaw ? ` · ${hRaw} h` : '';
  if (kind === 'creada') B.alerta({ tipo: 'regla', titulo: 'La red aprendió una regla nueva', texto: `${d.queja.texto || qCode} → ${d.operacion.codigo || d.operacion.descripcion || 'operación'} (${sys}${vehTxt ? ' · ' + vehTxt : ''}${hTxt}).`, rule_id: rule.id, sys, q_code: qCode, agency_id: doc.agency_id });
  else if (contextoNuevo) B.alerta({ tipo: 'regla', titulo: 'Un caso conocido, en otro contexto', texto: `«${rule.q_text}» también se aprobó en ${vehTxt}${hTxt}.`, rule_id: rule.id, sys, q_code: qCode, agency_id: doc.agency_id });
  avisarRed(doc, K, rule, nl, 'leccion', 'Error aprendido en la red: ' + (d.queja.texto || qCode).toLowerCase());
  const th = Math.max(1, Number(getSet('th', 1)));
  if (rule.status === 'aprendizaje' && rule.n >= th) {
    if (getSet('auto', 'true') === 'true') {
      db.prepare("UPDATE rules SET status = 'activa', updated_at = ? WHERE id = ?").run(now, rule.id);
      db.prepare('SELECT id FROM advisors WHERE active = 1').all().forEach(a => db.prepare('INSERT OR IGNORE INTO rule_distribution (rule_id, advisor_id, delivered_at) VALUES (?,?,?)').run(rule.id, a.id, now));
      logEvent('activada', rule.id, `Regla ${rule.id} alcanzó ${rule.n} PREAs aceptadas y se distribuyó a los agentes`);
    } else { db.prepare("UPDATE rules SET status = 'por-aprobar', updated_at = ? WHERE id = ?").run(now, rule.id); logEvent('por-aprobar', rule.id, `Regla ${rule.id} lista con ${rule.n} PREAs; espera tu aprobación`); }
  }
  bumpRev();
  return { rule: db.prepare('SELECT * FROM rules WHERE id = ?').get(rule.id), kind, validacion: val };
}

// Una PREA rechazada no crea reglas con sus valores (estaban mal), pero sí enseña qué evitar
function aprenderError(doc, d) {
  const K = claveRegla(d), now = Date.now(), val = [], lecs = [];
  const rule = db.prepare('SELECT * FROM rules WHERE sys = ? AND q_code = ?').get(K.sys, K.qCode);
  (d.lecciones || []).forEach(l => lecs.push({ ...l, tipo: l.tipo || 'rechazo' }));
  if (!lecs.length) (d.comentarios || []).filter(c => c.origen === 'planta' && ['rechazo', 'solicitud'].includes(c.tipo)).forEach(c => lecs.push({ problema: c.texto, correccion: '', temas: [], tipo: c.tipo, fecha: c.fecha }));
  if (!lecs.length) lecs.push({ problema: 'La planta rechazó esta PREA (el archivo no trae el motivo en el historial de comentarios).', correccion: '', temas: [], tipo: 'rechazo' });
  let rej = 0;
  if (rule) {
    // se compara contra el contexto del mismo modelo (si ya se aprendió), no contra el promedio de todos
    const vm = d.modelo ? db.prepare('SELECT * FROM rule_variants WHERE rule_id = ? AND LOWER(modelo) = LOWER(?) ORDER BY id DESC LIMIT 1').get(rule.id, d.modelo) : null;
    const ref = vm ? { op: vm.op, c_code: vm.c_code, c_text: vm.c_text, h: vm.hours } : { op: rule.op, c_code: rule.c_code, c_text: rule.c_text, h: rule.hours_sum / Math.max(rule.n, 1) };
    const h = Number(d.horas) || 0, veh = vehiculo(d);
    if (d.causa.codigo && ref.c_code && d.causa.codigo !== ref.c_code) lecs.push({ problema: `En una PREA rechazada${veh ? ' (' + veh + ')' : ''} se capturó la causa ${d.causa.codigo}; lo aceptado es ${ref.c_code} (${ref.c_text}).`, correccion: `Usa la causa ${ref.c_code}.`, temas: ['código de causa'], tipo: 'solicitud' });
    if (d.operacion.codigo && ref.op && d.operacion.codigo !== ref.op) lecs.push({ problema: `En una PREA rechazada${veh ? ' (' + veh + ')' : ''} se usó la operación ${d.operacion.codigo}; lo aceptado es ${ref.op}.`, correccion: `Usa la operación ${ref.op}.`, temas: [], tipo: 'solicitud' });
    if (h && ref.h && h > ref.h * 1.2) lecs.push({ problema: `En una PREA rechazada${veh ? ' (' + veh + ')' : ''} se capturaron ${h} h; lo aceptado es ${r1(ref.h)} h.`, correccion: `Captura ${r1(ref.h)} h.`, temas: ['tiempo de mano de obra'], tipo: 'solicitud' });
    if (d.causa.codigo === ref.c_code && d.operacion.codigo === ref.op) {   // la regla habría producido esta misma PREA y la rechazaron
      db.prepare('UPDATE rules SET rej = rej + 1, updated_at = ? WHERE id = ?').run(now, rule.id); rej = 1;
      logEvent('rechazo', rule.id, `La planta rechazó una PREA con los mismos códigos de la regla ${rule.id} («${doc.name}»): baja su confianza`);
    }
    val.push({ nivel: 'aviso', campo: 'regla', texto: `Se aprendió del error de la regla ${rule.id}${rej ? ' y bajó su confianza' : ''}.` });
  } else val.push({ nivel: 'aviso', campo: 'regla', texto: 'Aún no hay regla para esta queja; el error se guardó y se avisará cuando se prepare una PREA igual.' });
  const nl = guardarLecciones(doc, K, lecs, 'rechazada'), nn = nl.nuevas.length;
  val.push({ nivel: 'ok', campo: 'errores', texto: nn ? `Aprendí ${nn} ${nn === 1 ? 'error' : 'errores'} de esta PREA rechazada y lo avisé a toda la red.` : 'Esos errores ya los conocía el cerebro (se confirmaron).' });
  logEvent('info', rule ? rule.id : '', `El agente aprendió de una PREA rechazada («${doc.name}»): ${nn} ${nn === 1 ? 'error nuevo' : 'errores nuevos'}`);
  avisarRed(doc, K, rule, nl, 'rechazo', 'PREA rechazada en la red: ' + (d.queja.texto || K.qCode).toLowerCase(), ' Evítalo en tu PREA.');
  bumpRev();
  return { rule: rule || null, kind: 'error', validacion: val, rej };
}

// Busca la PREA ya aprendida a la que pertenece un pago (orden de trabajo, autorización, folio o VIN)
function preaDelPago(agencyId, d) {
  const docs = db.prepare("SELECT * FROM train_docs WHERE kind = 'prea' AND status = 'aprendida' AND agency_id = ?").all(agencyId);
  const n = s => String(s || '').trim().toUpperCase();
  return docs.map(x => ({ x, p: JSON.parse(x.data || '{}') })).find(({ p }) =>
    (n(d.orden) && n(d.orden) === n(p.orden)) || (n(d.codigo_autorizacion) && n(d.codigo_autorizacion) === n(p.codigo_autorizacion)) ||
    (n(d.folio_prea) && n(d.folio_prea) === n(p.folio)) || (n(d.vin) && n(d.vin) === n(p.vin) && d.operacion.codigo && d.operacion.codigo === p.operacion.codigo)) || null;
}

function aprenderPago(doc, d) {
  const now = Date.now(), val = [], rel = preaDelPago(doc.agency_id, d);
  let rule = rel && rel.x.rule_id ? db.prepare('SELECT * FROM rules WHERE id = ?').get(rel.x.rule_id) : null;
  if (!rule && d.operacion.codigo) rule = db.prepare('SELECT * FROM rules WHERE op = ? ORDER BY n DESC LIMIT 1').get(d.operacion.codigo);
  const ajuste = { horas: 0, precios: [] };
  if (rel) {
    const p = rel.p;
    if (p.horas && d.horas_pagadas != null) {
      const dh = r1(d.horas_pagadas - p.horas);
      val.push(dh === 0 ? { nivel: 'ok', campo: 'tiempo', texto: `La planta pagó ${d.horas_pagadas} h, igual a lo solicitado.` } : { nivel: 'difiere', campo: 'tiempo', texto: `La planta pagó ${d.horas_pagadas} h y se solicitaron ${p.horas} h.` });
      ajuste.horas = dh;
    }
    if (p.total_bruto != null && d.total_pagado != null) {
      const dm = r1(d.total_pagado - p.total_bruto);
      val.push(dm === 0 ? { nivel: 'ok', campo: 'monto', texto: `Pagado $${d.total_pagado.toLocaleString('en-US')}, igual a lo solicitado.` } : { nivel: 'difiere', campo: 'monto', texto: `Pagado $${d.total_pagado.toLocaleString('en-US')} contra $${p.total_bruto.toLocaleString('en-US')} solicitados (${dm > 0 ? '+' : ''}${dm}).` });
    }
  } else val.push({ nivel: 'aviso', campo: 'PREA', texto: 'No encontré la PREA de este pago entre las aprendidas; se usó solo la operación.' });
  if (rule) {
    db.prepare('UPDATE rules SET paid_n = paid_n + 1, paid_hours_sum = paid_hours_sum + ?, paid_amount_sum = paid_amount_sum + ?, updated_at = ? WHERE id = ?').run(d.horas_pagadas || 0, d.total_pagado || 0, now, rule.id);
    if (ajuste.horas) db.prepare('UPDATE rules SET hours_sum = MAX(0, hours_sum + ?), hours = MAX(0, hours_sum + ?) / MAX(n, 1) WHERE id = ?').run(ajuste.horas, ajuste.horas, rule.id);
    (d.piezas || []).forEach(pg => {
      const pt = pg.numero && db.prepare('SELECT price FROM rule_parts WHERE rule_id = ? AND part_no = ?').get(rule.id, pg.numero);
      if (pt && pg.monto_pagado != null && Math.abs(pt.price - pg.monto_pagado) > 0.005) {
        db.prepare('UPDATE rule_parts SET price = ? WHERE rule_id = ? AND part_no = ?').run(pg.monto_pagado, rule.id, pg.numero);
        ajuste.precios.push({ numero: pg.numero, antes: pt.price, despues: pg.monto_pagado });
        val.push({ nivel: 'difiere', campo: 'pieza ' + pg.numero, texto: `La planta pagó $${pg.monto_pagado} y la regla tenía $${pt.price}; se actualizó el precio.` });
      }
    });
    logEvent('info', rule.id, `Pago de planta aprendido para la regla ${rule.id}: ${d.horas_pagadas != null ? d.horas_pagadas + ' h, ' : ''}$${(d.total_pagado || 0).toLocaleString('en-US')} pagados`);
    bumpRev();
  }
  // Mal cobro de planta: la planta pagó menos de lo solicitado -> lección que se comparte con toda la red
  if (rule && rel) {
    const K = { sys: rule.sys, qCode: rule.q_code }, lecs = [], p = rel.p, op = d.operacion.codigo || rule.op || 'esta operación';
    if (ajuste.horas < 0) lecs.push({ problema: `La planta pagó ${d.horas_pagadas} h en ${op} aunque se solicitaron ${p.horas} h.`, correccion: `Captura ${d.horas_pagadas} h para evitar el ajuste de cobro.`, temas: ['tiempo de mano de obra'], tipo: 'cobro' });
    ajuste.precios.forEach(x => { if (x.despues < x.antes) lecs.push({ problema: `La planta pagó $${x.despues} por la pieza ${x.numero} y se solicitaron $${x.antes}.`, correccion: `Cotiza ${x.numero} a $${x.despues}.`, temas: ['piezas'], tipo: 'cobro' }); });
    const dm = p.total_bruto != null && d.total_pagado != null ? r1(d.total_pagado - p.total_bruto) : 0;
    if (dm < 0 && !lecs.length) lecs.push({ problema: `La planta pagó $${Math.abs(dm).toLocaleString('en-US')} menos de lo solicitado en ${op}.`, correccion: 'Revisa tiempo y precios de pieza contra lo que paga la planta.', temas: [], tipo: 'cobro' });
    if (lecs.length) { const r = guardarLecciones(doc, K, lecs, 'cobro'); avisarRed(doc, K, rule, r, 'mal_cobro', 'Mal cobro de planta detectado', ' Revisa tu cobro y reclama si aplica.'); }
  }
  return { rule, prea: rel ? rel.x : null, ajuste, validacion: val };
}

// Deshace lo aprendido de un documento (al eliminarlo)
function olvidar(doc) {
  const d = JSON.parse(doc.data || '{}'), ad = d._ajuste || {}, now = Date.now();
  const vh = db.prepare('SELECT hours FROM rule_variants WHERE doc_id = ?').get(doc.id);
  if (Array.isArray(d._defs)) d._defs.forEach(([k, v]) => db.prepare('UPDATE agency_defaults SET n = MAX(0, n - 1) WHERE agency_id = ? AND campo = ? AND valor = ?').run(doc.agency_id || 0, k, String(v)));
  db.prepare('DELETE FROM rule_variants WHERE doc_id = ?').run(doc.id);
  db.prepare('DELETE FROM train_lessons WHERE doc_id = ?').run(doc.id);
  if (d._modo === 'error') {
    if (d._rej && doc.rule_id) db.prepare('UPDATE rules SET rej = MAX(rej - 1, 0), updated_at = ? WHERE id = ?').run(now, doc.rule_id);
    bumpRev(); return;
  }
  if (!doc.rule_id) { bumpRev(); return; }
  const r = db.prepare('SELECT * FROM rules WHERE id = ?').get(doc.rule_id);
  if (!r) return;
  if (doc.kind === 'prea') {
    const h = Number(d.horas) > 0 ? Number(d.horas) : (vh ? Number(vh.hours) || 0 : 0);
    if (r.n <= 1 && !r.src_base && !r.src_asesor) { db.prepare('DELETE FROM rules WHERE id = ?').run(r.id); logEvent('info', '', `Se eliminó la regla ${r.id}: su única PREA se quitó del entrenamiento`); }
    else {
      db.prepare('UPDATE rules SET n = MAX(n - 1, 0), hours_sum = MAX(hours_sum - ?, 0), src_historico = MAX(src_historico - 1, 0), updated_at = ? WHERE id = ?').run(h, now, r.id);
      db.prepare('UPDATE rules SET hours = hours_sum / MAX(n, 1) WHERE id = ?').run(r.id);
      (d.piezas || []).forEach(p => { if (p.numero) db.prepare('UPDATE rule_parts SET n = n - 1 WHERE rule_id = ? AND part_no = ?').run(r.id, p.numero); });
      db.prepare('DELETE FROM rule_parts WHERE rule_id = ? AND n <= 0').run(r.id);
      logEvent('info', r.id, `Se quitó la PREA «${doc.name}» del entrenamiento de la regla ${r.id}`);
    }
  } else {
    db.prepare('UPDATE rules SET paid_n = MAX(paid_n - 1, 0), paid_hours_sum = MAX(paid_hours_sum - ?, 0), paid_amount_sum = MAX(paid_amount_sum - ?, 0), updated_at = ? WHERE id = ?').run(d.horas_pagadas || 0, d.total_pagado || 0, now, r.id);
    if (ad.horas) db.prepare('UPDATE rules SET hours_sum = MAX(0, hours_sum - ?), hours = MAX(0, hours_sum - ?) / MAX(n, 1) WHERE id = ?').run(ad.horas, ad.horas, r.id);
  }
  bumpRev();
}

module.exports = { aprenderPrea, aprenderError, aprenderPago, olvidar, preaDelPago, guardarLecciones, avisarRed, claveRegla };
