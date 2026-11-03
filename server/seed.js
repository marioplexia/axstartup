'use strict';
// Carga el catálogo base y los asesores (equivale a RS.seed() de index.html).
// Uso: npm run db:init  |  npm run db:reset (borra y vuelve a cargar)
const fs = require('fs');
const { db, DB_PATH } = require('./db');

if (process.argv.includes('--reset')) {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + s, { force: true });
  console.log('Base eliminada, recreando…');
  delete require.cache[require.resolve('./db')];
  return require('child_process').spawnSync(process.execPath, [__filename], { stdio: 'inherit' });
}

const REGION = 'Región Morelia (Sede Principal)';
const AGENCIES = [
  ['Chevrolet FAME Morelia', 'Morelia'],
  ['Chevrolet Uruapan FAME', 'Uruapan'],
  ['Chevrolet Apatzingán FAME', 'Apatzingán'],
  ['Chevrolet FAME Zamora', 'Zamora'],
  ['Chevrolet FAME Lázaro Cárdenas', 'Lázaro Cárdenas']
];

const ADVISORS = [
  { id: 'a1', name: 'mariogarantias', role: 'admin' },
  { id: 'a2', name: 'Heriberto Castañeda' },
  { id: 'a3', name: 'Lucía Ortega' },
  { id: 'a4', name: 'Jorge Salinas' }
];

const GMCODES = {
  'Transmisión': { q: ['TR-101', 'CAMBIOS BRUSCOS O RETARDO EN LA TRANSMISIÓN'], c: ['TR-310', 'SOLENOIDE DE CAMBIOS DEFECTUOSO'], r: ['TR-410', 'REEMPLAZAR SOLENOIDE Y RELLENAR FLUIDO'] },
  'Emisiones': { q: ['EM-120', 'LUZ DE MOTOR ENCENDIDA'], c: ['EM-340', 'SENSOR DE OXÍGENO FUERA DE RANGO'], r: ['EM-440', 'REEMPLAZAR SENSOR DE OXÍGENO Y ARNÉS'] },
  'Motor': { q: ['MT-205', 'RUIDO METÁLICO EN ARRANQUE EN FRÍO'], c: ['MT-518', 'TENSOR DE CADENA DE DISTRIBUCIÓN SIN PRESIÓN'], r: ['MT-632', 'REEMPLAZAR TENSOR Y GUÍA DE CADENA'] },
  'Electrónica': { q: ['EL-088', 'PANTALLA SE REINICIA'], c: ['EL-271', 'MÓDULO DE INFOENTRETENIMIENTO DEFECTUOSO'], r: ['EL-366', 'REEMPLAZAR MÓDULO Y REPROGRAMAR'] },
  'Frenos': { q: ['FR-140', 'VIBRACIÓN AL FRENAR'], c: ['FR-352', 'DISCOS DEFORMADOS'], r: ['FR-455', 'REEMPLAZAR DISCOS Y BALATAS DELANTEROS'] }
};

// [sys, op, opd, h, partes[[no, desc, qty, precio]], palabras clave, casos base, código GM]
const CASES = [
  ['Motor', 'OP-MT-031', 'Reemplazar tensor y guía de cadena de distribución', 3.4,
    [['PZ-MT-6120', 'Tensor de cadena de distribución', 1, 2140], ['PZ-MT-6121', 'Guía de cadena de distribución', 1, 860], ['PZ-MT-9001', 'Aceite de motor (litro)', 5, 150]],
    ['ruido', 'metalic', 'arranque', 'frio', 'cadena'], 8],
  ['Transmisión', 'OP-TR-014', 'Reemplazar solenoide de cambios', 3.2,
    [['PZ-TR-2201', 'Solenoide de cambios', 1, 1840], ['PZ-TR-9005', 'Fluido de transmisión (litro)', 6, 170]],
    ['transmisi', 'cambios bruscos', 'caja de'], 6],
  ['Emisiones', 'OP-EM-007', 'Reemplazar sensor de oxígeno banco 1', 0.8,
    [['PZ-EM-1180', 'Sensor de oxígeno B1S1', 1, 2350], ['PZ-EM-1190', 'Arnés del sensor', 1, 610]],
    ['oxigeno', 'luz de motor', 'check engine'], 5],
  ['Motor', 'OP-MT-022', 'Reemplazar junta de tapa de punterías', 2.1,
    [['PZ-MT-3310', 'Junta de tapa de punterías', 1, 780], ['PZ-MT-3311', 'Sellador de silicón', 1, 190], ['PZ-MT-9001', 'Aceite de motor (litro)', 5, 150]],
    ['aceite', 'fuga', 'junta'], 7],
  ['Electrónica', 'OP-EL-003', 'Reemplazar módulo de infoentretenimiento', 1.5,
    [['PZ-EL-4402', 'Módulo de infoentretenimiento', 1, 6900]],
    ['pantalla', 'infoent', 'reinici'], 4],
  ['Frenos', 'OP-FR-011', 'Reemplazar discos y balatas delanteros', 1.9,
    [['PZ-FR-5501', 'Disco de freno delantero', 2, 1120], ['PZ-FR-5502', 'Juego de balatas delanteras', 1, 980]],
    ['fren', 'vibra'], 6]
];
// Nota: la regla de junta usa el código de 'Motor' igual que en index.html (GMCODES por sistema).

const DAY = 864e5;
const now = Date.now();

const seed = db.transaction(() => {
  const insAg = db.prepare('INSERT OR IGNORE INTO agencies (name, brand, region, city) VALUES (?,?,?,?)');
  AGENCIES.forEach(([name, city]) => insAg.run(name, 'Chevrolet', REGION, city));
  const morelia = db.prepare('SELECT id FROM agencies WHERE name = ?').get('Chevrolet FAME Morelia').id;

  const insAdv = db.prepare('INSERT OR IGNORE INTO advisors (id, name, agency_id, role, created_at) VALUES (?,?,?,?,?)');
  ADVISORS.forEach(a => insAdv.run(a.id, a.name, morelia, a.role || 'asesor', now));

  const insRule = db.prepare(`INSERT OR IGNORE INTO rules
    (id, sys, q_code, q_text, c_code, c_text, r_code, r_text, op, op_desc, hours, hours_sum, n, rej, status,
     src_base, src_historico, src_asesor, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,'activa',?,0,0,?,?)`);
  const insPart = db.prepare('INSERT OR IGNORE INTO rule_parts (rule_id, part_no, descr, qty, price, n) VALUES (?,?,?,?,?,?)');
  const insKw = db.prepare('INSERT OR IGNORE INTO rule_keywords (rule_id, keyword) VALUES (?,?)');
  const insDist = db.prepare('INSERT OR IGNORE INTO rule_distribution (rule_id, advisor_id, delivered_at) VALUES (?,?,?)');

  CASES.forEach(([sys, op, opd, h, parts, kws, n], i) => {
    const id = 'R-' + ('000' + (i + 1)).slice(-4);
    const k = GMCODES[sys];
    const created = now - DAY * (30 - i), updated = now - DAY * (3 + i);
    insRule.run(id, sys, k.q[0], k.q[1], k.c[0], k.c[1], k.r[0], k.r[1], op, opd, h, +(h * n).toFixed(2), n, n, created, updated);
    parts.forEach(p => insPart.run(id, p[0], p[1], p[2], p[3], n));
    kws.forEach(w => insKw.run(id, w));
    ADVISORS.forEach(a => insDist.run(id, a.id, created));
  });

  const insSet = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  insSet.run('th', '3');
  insSet.run('auto', 'true');
  insSet.run('seq', String(CASES.length));
  insSet.run('rev', '1');

  if (!db.prepare('SELECT 1 FROM rule_log LIMIT 1').get()) {
    db.prepare('INSERT INTO rule_log (ts, type, rule_id, msg) VALUES (?,?,?,?)')
      .run(now, 'info', '', `Catálogo base cargado con ${CASES.length} reglas de la agencia`);
  }
});

seed();

// Órdenes de ejemplo para la bitácora (solo si la tabla está vacía): 17 PREAs de la última semana y 1 servicio.
if (!db.prepare('SELECT 1 FROM orders LIMIT 1').get()) db.transaction(() => {
  const ag = db.prepare('SELECT id FROM agencies WHERE name = ?').get('Chevrolet FAME Morelia').id;
  const ins = db.prepare(`INSERT INTO orders (id,kind,status,title,detail,vin,km,amount,advisor_id,agency_id,ev_have,ev_need,created_at,updated_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const QUEJAS = ['Cliente reporta ruido metálico en arranque en frío', 'Luz de motor encendida, sensor de oxígeno banco 1',
    'Cambios bruscos de segunda a tercera en transmisión', 'Fuga de aceite en tapa de punterías', 'Pantalla de infoentretenimiento se reinicia sola',
    'Vibración al frenar a más de 80 km/h', 'Falla intermitente de aire acondicionado', 'Jaloneo en aceleración a baja velocidad'];
  const CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  let seedN = 7; const rnd = () => (seedN = (seedN * 1103515245 + 12345) % 2147483648) / 2147483648;
  const code = n => Array.from({ length: n }, () => CHARS[Math.floor(rnd() * CHARS.length)]).join('');
  const adv = ['a1', 'a2', 'a3', 'a4'];
  for (let i = 0; i < 17; i++) {
    const t = now - Math.round((i === 0 ? 0.3 : i * 0.33 + rnd() * 0.2) * DAY);
    const km = i === 0 ? 11115 : 4000 + Math.floor(rnd() * 70000), vin = i === 0 ? 'LZWMLMGN9RF130982' : 'LZW' + code(14);
    ins.run('G-' + (i === 0 ? 'MVZVD1RQ' : code(8)), 'prea', 'preaprobada', 'PREA',
      `Chevrolet en garantía, VIN ${vin}, ${km.toLocaleString('es-MX')} km. ${QUEJAS[i % QUEJAS.length]}. Diagnóstico y operación capturados por el asesor.`,
      vin, km, Math.round(2500 + rnd() * 9000), adv[i % 4], ag, i % 5 === 3 ? 2 : 0, 5, t, t);
  }
  const t = now - 1.2 * DAY;
  ins.run('S-' + code(7), 'servicio', 'pendiente', 'Servicio de 20,000 km', 'Cambio de aceite y filtros, rotación de llantas y revisión de frenos.', null, 20000, 2380, 'a2', ag, 0, 3, t, t);
})();
const c = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`Base lista en ${DB_PATH}`);
console.log(`  agencias: ${c('agencies')} · asesores: ${c('advisors')} · reglas: ${c('rules')} · piezas: ${c('rule_parts')} · palabras clave: ${c('rule_keywords')}`);
