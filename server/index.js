'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
const { db } = require('./db');
const { router: auth } = require('./routes/auth');
const garantias = require('./routes/garantias');
const ordenes = require('./routes/ordenes');
const inicio = require('./routes/inicio');
const chat = require('./routes/chat');
const cartera = require('./routes/cartera');
const expedientes = require('./routes/expedientes');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

app.use('/api/auth', auth);
app.get('/api/agencias', (req, res, next) => { req.url = '/agencias'; auth(req, res, next); });
app.use('/api/garantias', garantias);
app.use('/api/garantias', ordenes);
app.use('/api/garantias', inicio);
app.use('/api/garantias', chat);
app.use('/api/garantias', cartera);
app.use('/api/garantias', expedientes);

// Pantallas de acceso y la app
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// La app se sirve con una bandera para que sepa que hay backend (y exija sesión).
const fs = require('fs');
app.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .replace('<script>', '<script>window.AX_SERVER=true;</script>\n<script>');
  res.type('html').send(html);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ax AI Garantías en http://localhost:${PORT}  (login: /login)`));
