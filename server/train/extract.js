'use strict';
// Lee un PDF o una imagen y devuelve los datos de la PREA o de la transacción de pago.
//  1) Con ANTHROPIC_API_KEY: un modelo con visión lee el archivo (cualquier formato, también escaneados).
//  2) Sin clave: texto del PDF + lector local; las imágenes pasan por OCR (tesseract, español, sin internet).
const path = require('path');
const os = require('os');
const P = require('./parse');
const { pdfTexto } = require('./pdftext');

const MODEL = process.env.TRAIN_MODEL || process.env.CHAT_MODEL || 'claude-sonnet-5-5';
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

/* ---------- OCR local (una tarea a la vez) ---------- */
let worker = null, cola = Promise.resolve();
async function ocr(buf) {
  const run = async () => {
    const { createWorker } = require('tesseract.js');
    if (!worker) {
      const dir = path.join(path.dirname(require.resolve('@tesseract.js-data/spa/package.json')), '4.0.0_best_int');
      worker = await createWorker('spa', 1, { langPath: dir, gzip: true, cachePath: path.join(os.tmpdir(), 'ax-tess'), logger: () => {} });
    }
    const { data } = await worker.recognize(buf);
    return data.text || '';
  };
  const r = cola.then(run, run); cola = r.catch(() => {}); return r;
}

/* ---------- Extracción con IA (visión) ---------- */
const COD = { type: 'object', properties: { codigo: { type: 'string' }, texto: { type: 'string' }, detalle: { type: 'string' } } };
const PIEZA = { type: 'object', properties: { numero: { type: 'string' }, descripcion: { type: 'string' }, cantidad: { type: 'number' }, precio: { type: 'number' } } };
const SCHEMA = {
  prea: {
    type: 'object', properties: {
      folio: { type: 'string', description: 'ID de autorización de pre-reparación' }, orden: { type: 'string', description: 'Orden de trabajo' }, fecha: { type: 'string', description: 'yyyy-mm-dd' },
      vin: { type: 'string' }, marca: { type: 'string' }, modelo: { type: 'string' }, anio: { type: 'integer' }, km: { type: 'number' },
      sistema: { type: 'string', enum: ['Motor', 'Transmisión', 'Frenos', 'Emisiones', 'Electrónica', 'Suspensión', 'Dirección', 'Aire acondicionado', 'Por clasificar'] },
      queja: COD, causa: COD, correccion: COD, operacion: { type: 'object', properties: { codigo: { type: 'string' }, descripcion: { type: 'string' } } },
      horas: { type: 'number', description: 'Tiempo de trabajo en horas' }, tarifa_mo: { type: 'number' }, piezas: { type: 'array', items: PIEZA },
      total_piezas: { type: 'number' }, total_bruto: { type: 'number' }, codigo_autorizacion: { type: 'string' }, estado: { type: 'string', enum: ['aceptada', 'rechazada', 'pendiente'] },
      campos_extra: { type: 'object', description: 'Otros campos del formulario', properties: { unidad: { type: 'string', description: 'Unidad de negocio' }, tipo_transaccion: { type: 'string' }, bac: { type: 'string' }, reparador: { type: 'string' }, marcador: { type: 'string', description: 'Marcador de transacción' },
        contacto: { type: 'string' }, telefono: { type: 'string' }, email: { type: 'string' }, deducible: { type: 'number' }, tiempo_adicional: { type: 'number' }, olh: { type: 'number' }, elementos_adicionales: { type: 'number' } } },
      comentarios: { type: 'array', description: 'Historial de comentarios completo, en orden cronológico', items: { type: 'object', properties: {
        fecha: { type: 'string', description: 'yyyy-mm-dd' }, hora: { type: 'string' }, autor: { type: 'string' }, origen: { type: 'string', enum: ['agencia', 'planta', 'otro'] },
        tipo: { type: 'string', enum: ['rechazo', 'solicitud', 'correccion', 'aceptacion', 'info'] }, texto: { type: 'string' } } } },
      lecciones: { type: 'array', description: 'Errores que tuvo la PREA en el pasado (rechazos o solicitudes de la planta) y cómo se corrigieron', items: { type: 'object', properties: {
        problema: { type: 'string' }, correccion: { type: 'string' }, temas: { type: 'array', items: { type: 'string' } } } } }
    }, required: ['queja', 'operacion', 'horas']
  },
  pago: {
    type: 'object', properties: {
      referencia_pago: { type: 'string' }, fecha_pago: { type: 'string' }, orden: { type: 'string' }, folio_prea: { type: 'string' }, codigo_autorizacion: { type: 'string' }, vin: { type: 'string' },
      operacion: { type: 'object', properties: { codigo: { type: 'string' }, descripcion: { type: 'string' } } }, horas_pagadas: { type: 'number' }, tarifa_mo: { type: 'number' },
      mano_obra_pagada: { type: 'number' }, piezas: { type: 'array', items: { type: 'object', properties: { numero: { type: 'string' }, descripcion: { type: 'string' }, cantidad: { type: 'number' }, monto_pagado: { type: 'number', description: 'precio unitario pagado' } } } },
      total_piezas_pagado: { type: 'number' }, ajustes: { type: 'array', items: { type: 'object', properties: { concepto: { type: 'string' }, monto: { type: 'number' } } } },
      total_pagado: { type: 'number' }, estado_pago: { type: 'string' }
    }, required: ['total_pagado']
  }
};
const PROMPT = {
  prea: 'Lee esta PREA (autorización previa a la reparación de General Motors) y registra todos sus datos con la herramienta. Copia los códigos tal cual (por ejemplo EM-215). Incluye TODO el historial de comentarios en orden y explica en «lecciones» por qué fue rechazada o qué pidió corregir la planta y cómo se corrigió. No inventes datos: omite lo que no aparezca.',
  pago: 'Lee esta transacción de pago de la planta (garantías) y registra todos sus datos con la herramienta: referencia, fechas, orden, autorización, operación, horas pagadas, tarifa, mano de obra, piezas pagadas con precio unitario, ajustes y total pagado. No inventes datos.'
};
async function conIA(tipo, buf, mime) {
  const esPdf = /pdf/i.test(mime), bloque = { type: esPdf ? 'document' : 'image', source: { type: 'base64', media_type: esPdf ? 'application/pdf' : mime, data: buf.toString('base64') } };
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, tools: [{ name: 'registrar_datos', description: 'Registra los datos leídos del documento.', input_schema: SCHEMA[tipo] }], tool_choice: { type: 'tool', name: 'registrar_datos' },
      messages: [{ role: 'user', content: [bloque, { type: 'text', text: PROMPT[tipo] }] }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Error del modelo');
  const uso = (j.content || []).find(b => b.type === 'tool_use');
  if (!uso) throw new Error('El modelo no devolvió datos');
  return uso.input;
}
// Completa lo que el modelo no entrega y deja el mismo formato que el lector local
function normalizar(tipo, d, texto) {
  d = d || {}; d.tipo = tipo;
  if (tipo === 'prea') {
    ['queja', 'causa', 'correccion'].forEach(k => { d[k] = Object.assign({ codigo: '', texto: '', detalle: '' }, d[k] || {}); });
    d.operacion = Object.assign({ codigo: '', descripcion: '' }, d.operacion || {});
    d.campos_extra = d.campos_extra || {}; d.piezas = d.piezas || []; d.comentarios = (d.comentarios || []).map(c => Object.assign({ origen: 'otro', tipo: 'info' }, c));
    d.sistema = d.sistema && d.sistema !== 'Por clasificar' ? d.sistema : P.inferirSistema([d.queja.texto, d.causa.texto, d.correccion.texto, d.operacion.descripcion].join(' '));
    if (!d.lecciones || !d.lecciones.length) d.lecciones = P.lecciones(d.comentarios);
    d.lecciones = d.lecciones.map(l => Object.assign({ temas: [], correccion: '' }, l));
    d.resumen = P.resumenPrea(d);
  } else {
    d.operacion = Object.assign({ codigo: '', descripcion: '' }, d.operacion || {}); d.piezas = d.piezas || []; d.ajustes = d.ajustes || [];
    d.resumen = [d.referencia_pago, d.orden, d.total_pagado != null ? '$' + Number(d.total_pagado).toLocaleString('en-US') : ''].filter(Boolean).join(' · ');
  }
  return d;
}
function faltantes(tipo, d) {
  const f = [];
  if (tipo === 'prea') { if (!(d.queja && (d.queja.codigo || d.queja.texto))) f.push('queja'); if (!(d.operacion && (d.operacion.codigo || d.operacion.descripcion))) f.push('operación'); if (!(d.horas > 0)) f.push('tiempo de trabajo'); }
  else if (!(d.total_pagado > 0) && !(d.horas_pagadas > 0)) f.push('total pagado');
  return f;
}

/* ---------- Punto de entrada ---------- */
async function extraer(tipo, buf, mime) {
  const esPdf = /pdf/i.test(mime), esImg = /^image\/(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(mime);
  if (!esPdf && !esImg) throw new Error('Solo se pueden leer archivos PDF o imágenes (PNG, JPG, WEBP).');
  let texto = '', ia = null, errIA = null;
  if (process.env.ANTHROPIC_API_KEY && (esPdf || /^image\/(png|jpe?g|webp|gif)$/i.test(mime))) {
    try { ia = await conIA(tipo, buf, mime); } catch (e) { errIA = e.message; console.error('Entrenamiento: falló la lectura con IA, uso el lector local:', e.message); }
  }
  try { texto = esPdf ? await pdfTexto(buf) : await ocr(buf); } catch (e) { if (!ia) throw new Error(esPdf ? 'No pude abrir el PDF: ' + e.message : 'No pude leer la imagen: ' + e.message); }
  if (ia) return { data: normalizar(tipo, ia, texto), texto, engine: 'ia' };
  if (esPdf && texto.replace(/\s/g, '').length < 60) throw new Error('El PDF parece un escaneo sin texto. Súbelo como imagen (PNG o JPG) o configura ANTHROPIC_API_KEY para leer escaneados.' + (errIA ? ' (' + errIA + ')' : ''));
  const d = tipo === 'prea' ? P.parsePrea(texto) : P.parsePago(texto);
  return { data: normalizar(tipo, d, texto), texto, engine: esPdf ? 'pdf' : 'ocr' };
}

module.exports = { extraer, faltantes, ocr };
