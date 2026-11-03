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
  const file = (url === '/registro' || url === '/registro.html') ? REGISTRO : FILE;
  fs.readFile(file, (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encontró la página');
    }
    // /registro es la pantalla de alta; cualquier otra ruta devuelve la app (el login lo resuelve index.html)
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { ...HEADERS, 'Content-Encoding': 'gzip' });
      return res.end(req.method === 'HEAD' ? undefined : zlib.gzipSync(html));
    }
    res.writeHead(200, HEADERS);
    res.end(req.method === 'HEAD' ? undefined : html);
  });
}).listen(PORT, '0.0.0.0', () => console.log('Ax AI Garantías escuchando en el puerto ' + PORT));
