'use strict';
// Servidor mínimo para Render: sirve index.html (toda la lógica y los datos viven en Supabase).
// Sin dependencias: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const FILE = path.join(__dirname, 'index.html');
const REGISTRO = path.join(__dirname, 'registro.html');
const LANDING = path.join(__dirname, 'landing.html');
const PRIVACIDAD = path.join(__dirname, 'privacidad.html');
const TERMINOS = path.join(__dirname, 'terminos.html');
// La landing recibe su configuración desde variables de entorno (sin claves en el código)
const LANDING_VARS = {
  __FORM_ENDPOINT__: process.env.FORM_ENDPOINT || '',
  __LINKEDIN_URL__: process.env.LINKEDIN_URL || ''
};

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Vary': 'Accept-Encoding'
};

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let file = FILE;
  if (url === '/registro' || url === '/registro.html') file = REGISTRO;
  else if (url === '/' || url === '/index.html' || url === '/landing') file = LANDING;
  else if (url === '/privacidad') file = PRIVACIDAD;
  else if (url === '/terminos') file = TERMINOS;
  fs.readFile(file, (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encontró la página');
    }
    // "/" es la landing; /registro es la pantalla de alta; /app y cualquier otra ruta devuelven la app (el login lo resuelve index.html)
    if (file === LANDING) {
      let txt = html.toString('utf8');
      for (const k in LANDING_VARS) txt = txt.split(k).join(LANDING_VARS[k].replace(/['"<>\\]/g, ''));
      html = Buffer.from(txt, 'utf8');
    }
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { ...HEADERS, 'Content-Encoding': 'gzip' });
      return res.end(req.method === 'HEAD' ? undefined : zlib.gzipSync(html));
    }
    res.writeHead(200, HEADERS);
    res.end(req.method === 'HEAD' ? undefined : html);
  });
}).listen(PORT, '0.0.0.0', () => console.log('Ax AI Garantías escuchando en el puerto ' + PORT));
