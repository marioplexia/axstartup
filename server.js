'use strict';
// Servidor mínimo para Render: sirve la landing, las páginas públicas y la app (toda la lógica y los datos viven en Supabase).
// Sin dependencias: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
// Dirección pública del sitio (para la imagen al compartir y el sitemap). Al tener dominio propio se cambia en Render.
const SITE = (process.env.SITE_URL || 'https://axstartup.onrender.com').replace(/\/+$/, '');
const P = (f) => path.join(__dirname, f);
const APP = P('index.html');
const LANDING = P('landing.html');
const NOT_FOUND = P('404.html');

// páginas públicas: ruta → archivo (la primera ruta de cada una es la que va al sitemap)
const PAGES = [
  [['/', '/index.html', '/landing'], 'landing.html', 1.0],
  [['/seguridad', '/security'], 'seguridad.html', 0.8],
  [['/precios', '/pricing'], 'precios.html', 0.8],
  [['/auditoria', '/audit'], 'auditoria.html', 0.7],
  [['/tpu', '/tup'], 'tpu.html', 0.7],
  [['/armadoras', '/automakers'], 'armadoras.html', 0.8],
  [['/equipo', '/team'], 'equipo.html', 0.6],
  [['/inversion', '/investors'], 'inversion.html', 0.6],
  [['/datos', '/subprocesadores', '/subprocessors'], 'datos.html', 0.5],
  [['/privacidad'], 'privacidad.html', 0.3],
  [['/terminos'], 'terminos.html', 0.3],
  [['/registro', '/registro.html'], 'registro.html', 0]
];
const ROUTES = {};
for (const [urls, file] of PAGES) for (const u of urls) ROUTES[u] = P(file);

// La landing recibe su configuración desde variables de entorno (sin claves en el código)
const VARS = {
  __FORM_ENDPOINT__: process.env.FORM_ENDPOINT || '',
  __LINKEDIN_URL__: process.env.LINKEDIN_URL || '',
  __SITE__: SITE,
  // correo para inversionistas (página /inversion); sin él, el botón lleva al formulario de la landing
  __CONTACT__: (process.env.CONTACT_EMAIL || '').replace(/[^a-z0-9@._+-]/gi, '')
};

// Analítica sin cookies (Plausible): solo se carga si PLAUSIBLE_DOMAIN está configurado en Render.
// Siempre se muestra un aviso breve de privacidad; si la analítica está activa, el aviso lo menciona.
const PL_DOMAIN = (process.env.PLAUSIBLE_DOMAIN || '').replace(/[^a-z0-9.-]/gi, '');
const PL_SRC = (process.env.PLAUSIBLE_SRC || 'https://plausible.io/js/script.js').replace(/["<>\s]/g, '');
const ANALYTICS = (PL_DOMAIN
  ? '<script defer data-domain="' + PL_DOMAIN + '" src="' + PL_SRC + '"></script>' +
    '<script>window.plausible=window.plausible||function(){(window.plausible.q=window.plausible.q||[]).push(arguments)}</script>'
  : '') + fs.readFileSync(P('aviso.html'), 'utf8').replace('__ANALITICA__', PL_DOMAIN ? '1' : '');

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Vary': 'Accept-Encoding'
};

const ROBOTS = 'User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /registro\n\nSitemap: ' + SITE + '/sitemap.xml\n';
const SITEMAP = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  PAGES.filter((p) => p[2] > 0).map((p) => '  <url><loc>' + SITE + (p[0][0] === '/' ? '/' : p[0][0]) + '</loc><priority>' + p[2].toFixed(1) + '</priority></url>').join('\n') +
  '\n</urlset>\n';

function send(req, res, status, type, body, cache) {
  const h = { ...HEADERS, 'Content-Type': type, 'Cache-Control': cache || HEADERS['Cache-Control'] };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && !/^image\//.test(type)) {
    res.writeHead(status, { ...h, 'Content-Encoding': 'gzip' });
    return res.end(req.method === 'HEAD' ? undefined : zlib.gzipSync(body));
  }
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}

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
  if (url === '/robots.txt') return send(req, res, 200, 'text/plain; charset=utf-8', Buffer.from(ROBOTS), 'public, max-age=3600');
  if (url === '/sitemap.xml') return send(req, res, 200, 'application/xml; charset=utf-8', Buffer.from(SITEMAP), 'public, max-age=3600');
  if (url === '/og.png') {
    return fs.readFile(P('assets/og.png'), (err, png) => err ? send(req, res, 404, 'text/plain; charset=utf-8', Buffer.from('')) : send(req, res, 200, 'image/png', png, 'public, max-age=86400'));
  }
  // la app vive en /app (el login y los enlaces de acceso de Supabase los resuelve index.html)
  let file = ROUTES[url] || ((url === '/app' || url.startsWith('/app/')) ? APP : null);
  const status = file ? 200 : 404;
  if (!file) file = NOT_FOUND;
  fs.readFile(file, (err, html) => {
    if (err) return send(req, res, 500, 'text/plain; charset=utf-8', Buffer.from('No se encontró la página'));
    if (file !== APP) {
      let txt = html.toString('utf8');
      for (const k in VARS) txt = txt.split(k).join(VARS[k].replace(/['"<>\\]/g, ''));
      txt = txt.replace('</head>', ANALYTICS + '</head>');
      html = Buffer.from(txt, 'utf8');
    }
    send(req, res, status, HEADERS['Content-Type'], html);
  });
}).listen(PORT, '0.0.0.0', () => console.log('Ax AI Garantías escuchando en el puerto ' + PORT));
