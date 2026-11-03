'use strict';
// Lector local de campos para PREAs (autorización previa a la reparación de GM) y transacciones de pago de planta.
// Funciona sobre el texto del PDF o el obtenido por OCR. Si hay clave de IA, la extracción con visión lo reemplaza.

const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function money(s) {
  if (s == null) return null;
  const m = String(s).replace(/[$\s]/g, '').match(/-?[\d.,]+/);
  if (!m) return null;
  let t = m[0];
  if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');      // 1.184,00
  else t = t.replace(/,(?=\d{3}(\D|$))/g, '').replace(/,(\d{1,2})$/, '.$1');                     // 1,184.00 · 1,2
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}
const toIso = d => { const m = String(d || '').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); if (!m) return null; let y = +m[3]; if (y < 100) y += 2000; return `${y}-${('0' + m[2]).slice(-2)}-${('0' + m[1]).slice(-2)}`; };

const DIC_PREA = {
  'id de autorizacion de pre-reparacion': 'folio', 'id de autorizacion de prereparacion': 'folio', 'id de autorizacion': 'folio', 'folio': 'folio', 'numero de prea': 'folio', 'prea': 'folio',
  'orden de trabajo': 'orden', 'numero de referencia': 'referencia', 'fecha de la orden de trabajo': 'fecha', 'fecha': 'fecha', 'bac': 'bac', 'reparador': 'reparador',
  'vehiculo': 'vehiculo', 'vin': 'vin', 'cuentakilometros': 'km', 'kilometraje': 'km', 'odometro': 'km', 'marcador de transaccion': 'marcador',
  'queja': 'queja', 'causa': 'causa', 'correccion': 'correccion', 'operacion de trabajo': 'operacion', 'operacion': 'operacion',
  'tiempo de trabajo': 'horas', 'horas': 'horas', 'total tiempo': 'total_tiempo', 'total de piezas': 'total_piezas', 'numeros de pieza': 'piezas', 'piezas': 'piezas',
  'tarifa mano de obra': 'tarifa', 'total bruto': 'total', 'deducible': 'deducible', 'codigo de autorizacion': 'auth', 'estado': 'estado', 'estatus': 'estado',
  'unidad de negocio': 'unidad', 'tipo de transaccion': 'tipo'
};
const DIC_PAGO = {
  'referencia de pago': 'ref', 'fecha de pago': 'fecha', 'orden de trabajo': 'orden', 'codigo de autorizacion': 'auth', 'autorizacion': 'auth',
  'id de autorizacion de pre-reparacion': 'folio', 'folio prea': 'folio', 'prea': 'folio', 'vin': 'vin', 'operacion': 'op', 'operacion de trabajo': 'op',
  'tiempo pagado': 'horas', 'horas pagadas': 'horas', 'tarifa mano de obra': 'tarifa', 'tarifa': 'tarifa', 'mano de obra pagada': 'mo', 'piezas pagadas': 'piezas',
  'total piezas pagado': 'total_piezas', 'total de piezas pagado': 'total_piezas', 'ajustes': 'ajustes', 'total pagado': 'total', 'monto pagado': 'total', 'importe pagado': 'total',
  'estatus de pago': 'estado', 'estado de pago': 'estado', 'estado': 'estado', 'estatus': 'estado', 'reparador': 'reparador'
};
const HEAD_COM = /^(historial de comentarios|comentarios|historial)\s*:?\s*$/;
const FECHA_COM = /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})(?:[ T,]+(\d{1,2}:\d{2}))?\s*[-–—:|]?\s*(.*)$/;

// Separa texto en campos (etiqueta: valor, con valores en varias líneas) y en comentarios con fecha.
function leer(texto, dic) {
  const lines = String(texto || '').replace(/\r/g, '').split('\n').map(clean);
  const f = {}, com = []; let cur = null, modo = 'campos';
  for (const line of lines) {
    if (!line) continue;
    const n = norm(line);
    if (HEAD_COM.test(n)) { modo = 'com'; cur = null; continue; }
    if (modo === 'com') {
      const m = line.match(FECHA_COM);
      if (m) com.push({ fecha: m[1], hora: m[2] || '', texto: m[3] });
      else if (com.length) com[com.length - 1].texto += ' ' + line;
      continue;
    }
    const m = n.match(/^([a-z0-9 \/\-\.()]+?)\s*[:：]\s*(.*)$/);
    if (m && dic[m[1].trim()]) { cur = dic[m[1].trim()]; const v = line.slice(line.indexOf(':') + 1).trim(); f[cur] = v ? [v] : []; continue; }
    if (dic[n] && !['estado', 'estatus', 'fecha', 'folio', 'prea'].includes(n)) { cur = dic[n]; f[cur] = []; continue; }   // encabezado sin dos puntos
    if (cur) f[cur].push(line);
  }
  return { f, com };
}

const RE_COD = /^([A-Z]{1,4}(?:-[A-Z]{1,4})?-?\d{2,5})\s*[-–—:]\s*(.+)$/i;
function codigo(lines) {
  const arr = (lines || []).filter(Boolean); if (!arr.length) return { codigo: '', texto: '', detalle: '' };
  const m = arr[0].match(RE_COD);
  return m ? { codigo: m[1].toUpperCase().replace(/^([A-Z]+)(\d)/, '$1-$2'), texto: clean(m[2]), detalle: clean(arr.slice(1).join(' ')) } : { codigo: '', texto: clean(arr[0]), detalle: clean(arr.slice(1).join(' ')) };
}
const RE_PZ = /^\s*(PZ-[A-Z]{2}-\d{3,6}|[A-Z]{0,3}\d{5,10})\s*[|\-]?\s+(.+?)\s+(?:cant\.?\s*)?(\d{1,3})\s*(?:[x×]|pza[s]?|pzas?)\s*\$?\s*([\d.,]+)\s*$/i;
const RE_PZ2 = /^\s*(PZ-[A-Z]{2}-\d{3,6}|[A-Z]{0,3}\d{5,10})\s*[|\-]?\s+(.+?)\s+\$?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*$/i;
function piezas(lines) {
  const out = [];
  for (const l of lines || []) {
    let m = l.match(RE_PZ);
    if (m) { out.push({ numero: m[1].toUpperCase(), descripcion: clean(m[2]), cantidad: +m[3], precio: money(m[4]) }); continue; }
    m = l.match(RE_PZ2);
    if (m) out.push({ numero: m[1].toUpperCase(), descripcion: clean(m[2]), cantidad: 1, precio: money(m[3]) });
  }
  return out;
}
const MODELOS = 'Aveo|Sonic|Onix|Spark|Beat|Tracker|Equinox|Silverado|Cheyenne|Captiva|Trax|Cavalier|Malibu|Suburban|Tahoe|Colorado|S10|Groove|Blazer|Bolt|Traverse|Orlando|Cruze|Montana|Chevy|Tornado|Sail|Joy';
function vehiculo(t, texto) {
  const src = t || '', all = (src + ' ' + (texto || '').slice(0, 4000));
  const m = (src.match(new RegExp(`\\b(${MODELOS})\\b[^\\n]{0,24}?\\b(20\\d{2}|19\\d{2})\\b`, 'i')) || all.match(new RegExp(`\\b(${MODELOS})\\b[^\\n]{0,24}?\\b(20\\d{2})\\b`, 'i')));
  const marca = (all.match(/\b(Chevrolet|GMC|Buick|Cadillac)\b/i) || [])[1] || (m ? 'Chevrolet' : '');
  return { marca: marca ? marca[0].toUpperCase() + marca.slice(1).toLowerCase() : '', modelo: m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : '', anio: m ? +m[2] : null };
}
const SISTEMAS = [
  ['Transmisión', /transmisi|solenoide de cambios|cambios bruscos|caja de velocidades|embrague|clutch/],
  ['Frenos', /fren|balata|disco de freno|caliper|abs\b/],
  ['Emisiones', /ox[ií]geno|emisi|catalizador|lambda|evap\b|egr\b/],
  ['Electrónica', /pantalla|infoentretenimiento|m[oó]dulo|bater[ií]a|alternador|arranque el[eé]ctrico|sensor de|fusible|cableado|computadora|ecu\b/],
  ['Suspensión', /amortiguador|suspensi|r[oó]tula|terminal de direcci|buje|resorte|barra estabilizadora/],
  ['Dirección', /direcci[oó]n|cremallera|bomba de direcci/],
  ['Aire acondicionado', /aire acondicionado|compresor de a\/c|a\/c\b|evaporador|condensador/],
  ['Motor', /motor|polea|banda|cadena|punter[ií]a|aceite|junta|bomba de agua|termostato|tensor|chirrido|ruido|distribuci|culata|v[aá]lvula/]
];
function inferirSistema(txt) {
  const n = norm(txt);
  for (const [s, re] of SISTEMAS) if (re.test(n)) return s;
  return 'Por clasificar';
}
const MAP_EDO = [[/rechaz|negad|improcedent|denegad/, 'rechazada'], [/acept|autoriz|aprob|pagad|procede/, 'aceptada'], [/captur|borrador|pendient|revision|enviad/, 'pendiente']];
const estadoDe = s => { const n = norm(s); for (const [re, v] of MAP_EDO) if (re.test(n)) return v; return null; };

function clasificar(c) {
  const n = norm(c.texto);
  const planta = /planta|fabricante|garantias gm|\bgm\b|garantias|gmm|global/.test(norm(c.autor || '')) || (/^\s*(rechazada|aceptada)/.test(n) && !/agencia|reparador|asesor/.test(norm(c.autor || '')));
  c.origen = planta ? 'planta' : (/agencia|reparador|asesor|taller|servicio/.test(norm(c.autor || '')) ? 'agencia' : 'otro');
  if (/rechaz|no procede|negad|improcedent|no se autoriza|denegad/.test(n)) c.tipo = 'rechazo';
  else if (c.origen !== 'agencia' && /aceptad|autorizad|aprobad|se autoriza|procede/.test(n)) c.tipo = 'aceptacion';
  else if (c.origen === 'planta' && /falta|favor de|solicit|justific|corrij|incorrect|no corresponde|aclar|adjunt|anex|requiere|verific/.test(n)) c.tipo = 'solicitud';
  else if (c.origen === 'agencia' && /correg|ajust|se adjunta|se agrega|se anex|se actualiz|se aclara|se cambia/.test(n)) c.tipo = 'correccion';
  else c.tipo = 'info';
  return c;
}
function comentarios(raw) {
  return raw.map((r, i) => {
    const m = r.texto.match(/^([^:]{3,60}?(?:\([^)]*\))?)\s*:\s+(.+)$/);
    const c = { fecha: toIso(r.fecha) || r.fecha, hora: r.hora, autor: m ? clean(m[1]) : '', texto: clean(m ? m[2] : r.texto) };
    clasificar(c);
    if (i === 0 && c.origen === 'agencia' && c.tipo === 'correccion') c.tipo = 'info';   // la primera nota de la agencia solo plantea la solicitud
    return c;
  });
}
const TEMAS = [['código de causa', /codigo de causa|causa no corresponde|codigo.*(incorrect|no corresponde)/], ['kilometraje', /kilometraje|odometro|\bkm\b/], ['fotografías', /fotograf|\bfotos?\b|imagen/], ['evidencia', /evidencia|ticket|captura|gds2|diagnostic/],
  ['tiempo de mano de obra', /tiempo|horas|mano de obra|tabulador|estandar/], ['VIN', /\bvin\b/], ['piezas', /pieza|numero de parte|refaccion/], ['factura', /factura/], ['firma del cliente', /firma|conformidad|hoja de entrega/]];
function lecciones(coms) {
  const out = [];
  coms.forEach((c, i) => {
    if (c.origen !== 'planta' || !['rechazo', 'solicitud'].includes(c.tipo)) return;
    const resp = coms.slice(i + 1).find(x => x.origen === 'agencia');
    const temas = TEMAS.filter(([, re]) => re.test(norm(c.texto))).map(([t]) => t);
    out.push({ fecha: c.fecha, tipo: c.tipo, problema: c.texto.replace(/^(rechazada|aceptada)\.?\s*/i, ''), correccion: resp ? resp.texto : '', temas });
  });
  return out;
}

function parsePrea(texto) {
  const { f, com } = leer(texto, DIC_PREA), v = k => clean((f[k] || []).join(' '));
  const q = codigo(f.queja), c = codigo(f.causa), r = codigo(f.correccion), o = codigo(f.operacion);
  const coms = comentarios(com);
  let km = money(v('km')); if (km == null || km < 50) { const m = String(texto).match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,6})\s*km\b/i); km = m ? money(m[1]) : null; }
  const veh = vehiculo(v('vehiculo'), texto), vin = (v('vin').match(/[A-HJ-NPR-Z0-9]{17}/i) || String(texto).match(/\b[A-HJ-NPR-Z0-9]{17}\b/i) || [''])[0].toUpperCase();
  const pz = piezas(f.piezas); const horas = money(v('horas')) ?? money(v('total_tiempo'));
  const ultPlanta = [...coms].reverse().find(x => x.origen === 'planta' && ['aceptacion', 'rechazo'].includes(x.tipo));
  const estado = estadoDe(v('estado')) || (ultPlanta ? (ultPlanta.tipo === 'aceptacion' ? 'aceptada' : 'rechazada') : null);
  const aceptada = [...coms].reverse().find(x => x.tipo === 'aceptacion');
  const sistema = inferirSistema([q.texto, c.texto, r.texto, o.texto].join(' '));
  const d = {
    tipo: 'prea', folio: v('folio'), orden: v('orden'), fecha: toIso(v('fecha')), vin, marca: veh.marca, modelo: veh.modelo, anio: veh.anio, km, sistema,
    queja: q, causa: c, correccion: r, operacion: { codigo: o.codigo, descripcion: o.texto }, horas, tarifa_mo: money(v('tarifa')), piezas: pz,
    total_piezas: money(v('total_piezas')), total_bruto: money(v('total')), codigo_autorizacion: v('auth'), estado,
    fecha_aceptacion: aceptada ? aceptada.fecha : null, comentarios: coms, lecciones: lecciones(coms)
  };
  d.resumen = resumenPrea(d);
  return d;
}
function resumenPrea(d) {
  const veh = [d.marca, d.modelo, d.anio].filter(Boolean).join(' ');
  return [veh || 'Vehículo sin identificar', d.km ? d.km.toLocaleString('en-US') + ' km' : '', d.queja && d.queja.texto ? d.queja.texto.toLowerCase() : '', d.operacion && d.operacion.codigo ? d.operacion.codigo : ''].filter(Boolean).join(' · ');
}

function parsePago(texto) {
  const { f } = leer(texto, DIC_PAGO), v = k => clean((f[k] || []).join(' '));
  const o = codigo(f.op);
  const aj = []; (f.ajustes || []).forEach(l => { const m = l.match(/^(.*?)[:\s]\s*(-?\$?\s?[\d.,]+)\s*$/); if (m) aj.push({ concepto: clean(m[1]).replace(/[:\-]+$/, ''), monto: money(m[2].replace(/\s/g, '')) }); });
  const pz = piezas(f.piezas).map(p => ({ numero: p.numero, descripcion: p.descripcion, cantidad: p.cantidad, monto_pagado: p.precio }));
  const d = {
    tipo: 'pago', referencia_pago: v('ref'), fecha_pago: toIso(v('fecha')), orden: v('orden'), folio_prea: v('folio'), codigo_autorizacion: v('auth'),
    vin: (v('vin').match(/[A-HJ-NPR-Z0-9]{17}/i) || String(texto).match(/\b[A-HJ-NPR-Z0-9]{17}\b/i) || [''])[0].toUpperCase(),
    operacion: { codigo: o.codigo, descripcion: o.texto }, horas_pagadas: money(v('horas')), tarifa_mo: money(v('tarifa')), mano_obra_pagada: money(v('mo')),
    piezas: pz, total_piezas_pagado: money(v('total_piezas')), ajustes: aj, total_pagado: money(v('total')), estado_pago: estadoDe(v('estado')) === 'aceptada' ? 'pagado' : (v('estado') || '').toLowerCase()
  };
  d.resumen = [d.referencia_pago, d.orden, d.total_pagado != null ? '$' + d.total_pagado.toLocaleString('en-US') : ''].filter(Boolean).join(' · ');
  return d;
}

// Datos mínimos de un caso descrito con palabras (para el chat de pruebas)
function parseTexto(txt) {
  const veh = vehiculo('', txt), km = (() => { const m = String(txt).match(/(\d{1,3}(?:[.,]\d{3})+|\d{2,3})\s*(mil\b|k\b)?\s*km\b|(\d{2,3})\s*mil\s*(?:km|kil[oó]metros)?/i); if (!m) return null; if (m[3]) return +m[3] * 1000; const n = money(m[1]); return m[2] && n < 1000 ? n * 1000 : n; })();
  return { tipo: 'prea', marca: veh.marca, modelo: veh.modelo, anio: veh.anio, km, queja: { codigo: '', texto: clean(txt), detalle: '' }, sistema: inferirSistema(txt), piezas: [], comentarios: [], lecciones: [] };
}

const STOP = new Set('para con una uno unos unas del los las que por sus cliente reporta presenta tiene como esta este esos esas pero desde hasta sobre entre mas muy sin cuando donde cual porque asi'.split(' '));
const palabras = txt => [...new Set(norm(txt).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)))];

module.exports = { norm, clean, money, toIso, parsePrea, parsePago, parseTexto, inferirSistema, palabras, lecciones, comentarios, resumenPrea, estadoDe, TEMAS };
