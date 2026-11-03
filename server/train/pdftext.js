'use strict';
// Texto de un PDF con las líneas reconstruidas por posición (así «Etiqueta: valor» queda en la misma línea).
let pdfjs = null;
global.DOMMatrix = global.DOMMatrix || class DOMMatrix {};   // pdf.js intenta cargar «canvas» solo para dibujar; aquí solo leemos texto
global.Path2D = global.Path2D || class Path2D {};
global.ImageData = global.ImageData || class ImageData {};
async function pdfTexto(buf, maxPaginas = 12) {
  if (!pdfjs) pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const out = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPaginas); p++) {
      const page = await doc.getPage(p), tc = await page.getTextContent(), filas = new Map();
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = Math.round(it.transform[5] / 2.5);               // tolerancia vertical
        const k = [...filas.keys()].find(a => Math.abs(a - y) <= 1) ?? y;
        (filas.get(k) || filas.set(k, []).get(k)).push({ x: it.transform[4], w: it.width || 0, s: it.str });
      }
      [...filas.entries()].sort((a, b) => b[0] - a[0]).forEach(([, its]) => {
        its.sort((a, b) => a.x - b.x);
        let line = '', end = null;
        for (const t of its) { line += (end != null && t.x - end > 1.5 ? ' ' : '') + t.s; end = t.x + t.w; }
        out.push(line.replace(/\s+/g, ' ').trim());
      });
      out.push('');
    }
  } finally { await doc.destroy().catch(() => {}); }
  return out.join('\n');
}
module.exports = { pdfTexto };
