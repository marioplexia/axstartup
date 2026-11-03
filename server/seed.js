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

// Datos de ejemplo del tablero de inicio (una sola vez): PREAs aprobadas/negadas de los últimos 12 meses,
// piezas en pedido, campañas y servicios realizados. Todo ficticio.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'home_seed'").get()) db.transaction(() => {
  const ag = db.prepare('SELECT id FROM agencies WHERE name = ?').get('Chevrolet FAME Morelia').id;
  const ins = db.prepare(`INSERT OR IGNORE INTO orders (id,kind,status,title,detail,vin,km,amount,advisor_id,agency_id,ev_have,ev_need,created_at,resolved_at,updated_at,customer,part,part_status,part_ordered_at,due_at,unit,svc_type)
                          VALUES (@id,@kind,@status,@title,@detail,@vin,@km,@amount,@advisor_id,@agency_id,@ev_have,@ev_need,@created_at,@resolved_at,@updated_at,@customer,@part,@part_status,@part_ordered_at,@due_at,@unit,@svc_type)`);
  let sd = 11; const rnd = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a, i) => a[(i == null ? Math.floor(rnd() * a.length) : i) % a.length];
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const CLIENTES = ['Industrias del Norte', 'Grupo Andamio', 'Talleres Riviera', 'Comercial Salcedo', 'Logística Brava', 'Herrajes Unión', 'Metalúrgica Faro', 'Distribuidora Cela', 'Transportes del Bajío', 'Constructora Altavista'];
  const PIEZAS = ['Solenoide de transmisión', 'Sensor de oxígeno banco 1', 'Bomba de aceite', 'Tensor de cadena de distribución', 'Módulo de infoentretenimiento', 'Disco de freno delantero', 'Junta de tapa de punterías', 'Sensor de presión de aceite', 'Válvula EGR', 'Compresor de aire acondicionado', 'Amortiguador delantero', 'Alternador'];
  const QUEJAS = ['ruido metálico en arranque en frío', 'luz de motor encendida', 'cambios bruscos en transmisión', 'fuga de aceite', 'pantalla que se reinicia', 'vibración al frenar'];
  const UNIDADES = ['Silverado 2025', 'Aveo 2026', 'Equinox 2025', 'Tracker 2026', 'Onix 2026', 'Captiva 2025'];
  const ADV = ['a1', 'a2', 'a3', 'a4'], CH = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  const vin = () => 'LZW' + Array.from({ length: 14 }, () => CH[Math.floor(rnd() * CH.length)]).join('');
  let folio = 3957;
  const base = (o, i) => ({ vin: null, km: null, amount: 0, advisor_id: ADV[i % 4], agency_id: ag, ev_have: 5, ev_need: 5, resolved_at: null,
    customer: null, part: null, part_status: null, part_ordered_at: null, due_at: null, unit: null, svc_type: null, detail: '', title: 'PREA', ...o });
  const nextId = () => { const id = 'GA' + folio; folio += 13; return id; };

  // PREAs: ventana actual (42 aprobadas, 7 negadas) y ventana previa (39 y 8)
  const prea = (status, createdDays, i, extra) => {
    const t = now - createdDays * DAY, cyc = (1 + Math.floor(rnd() * 5) + rnd()) * DAY, v = vin(), km = 3000 + Math.floor(rnd() * 80000);
    ins.run(base({ id: nextId(), kind: 'prea', status, created_at: t, resolved_at: t + cyc, updated_at: t + cyc, vin: v, km,
      amount: i === 0 ? 12000 : Math.round(9000 + rnd() * 90000), customer: pick(CLIENTES, i),
      detail: `Chevrolet en garantía, VIN ${v}, ${km.toLocaleString('es-MX')} km. Cliente reporta ${pick(QUEJAS)}.`, ...extra }, i));
  };
  const est = shuffle([...Array(11).fill('en_planta'), ...Array(22).fill('pedida'), ...Array(9).fill('por_pedir')]);
  for (let i = 0; i < 42; i++) {
    const t = now - (175 - i * 3.8) * DAY, e = est[i], part = pick(PIEZAS, i + 3);
    const ord = e === 'pedida' ? Math.min(now - DAY, Math.max(t + 3 * DAY, now - (1 + rnd() * 60) * DAY)) : e === 'en_planta' ? t + 2.5 * DAY : null;
    const due = e === 'pedida' ? now + (3 + Math.floor(rnd() * 26)) * DAY : e === 'en_planta' ? (ord + (5 + Math.floor(rnd() * 8)) * DAY) : null;
    prea('aprobada', 175 - i * 3.8, i, { part, part_status: e, part_ordered_at: ord, due_at: due });
  }
  for (let j = 0; j < 7; j++) prea('rechazada', 170 - j * 22, j + 1, {});
  for (let i = 0; i < 39; i++) prea('aprobada', 355 - i * 4.1, i + 5, { part: pick(PIEZAS, i), part_status: 'recibida', part_ordered_at: now - (352 - i * 4.1) * DAY, due_at: now - (345 - i * 4.1) * DAY });
  for (let j = 0; j < 8; j++) prea('rechazada', 350 - j * 18, j + 2, {});
  // dos PREAs que requieren atención
  for (let j = 0; j < 2; j++) { const t = now - (3.5 + j * 0.4) * DAY, v = vin(); ins.run(base({ id: nextId(), kind: 'prea', status: 'atencion', created_at: t, updated_at: t, vin: v, km: 22000 + j * 9000, amount: 14500 + j * 3200, customer: pick(CLIENTES, j + 6), ev_have: 2, detail: `Chevrolet en garantía, VIN ${v}. Falta evidencia del diagnóstico para enviar la PREA.` }, j)); }

  // Campañas: 12 este mes (4 cerradas, 4 realizadas, 4 pendientes) y 10 el mes anterior
  const mes0 = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(), pmes0 = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime();
  const camp = (status, from, to, i) => {
    const t = from + rnd() * Math.max(1, to - from);
    ins.run(base({ id: nextId(), kind: 'campana', status, title: 'Campaña ' + pick(['23N45', '24V12', '24S07', '23N78'], i), created_at: t, updated_at: t, amount: 0,
      customer: pick(CLIENTES, i + 2), unit: pick(UNIDADES, i) + ' · Unidad ' + String(1 + (i * 5) % 14).padStart(2, '0'),
      resolved_at: status === 'pendiente' ? null : t + 0.5 * DAY, due_at: status === 'pendiente' ? now + (4 + i * 3) * DAY : null, ev_need: 3, ev_have: status === 'pendiente' ? 0 : 3,
      detail: 'Campaña de seguridad del fabricante' }, i));
  };
  shuffle([...Array(4).fill('cerrada'), ...Array(4).fill('realizada'), ...Array(4).fill('pendiente')]).forEach((s, i) => camp(s, mes0, now, i));
  shuffle([...Array(9).fill('cerrada'), ...Array(1).fill('pendiente')]).forEach((s, i) => camp(s, pmes0, mes0 - 1, i + 20));

  // Servicios realizados: este mes y el anterior, por tipo
  const SERV = { 'Mantenimiento': [7, 6], 'Reparación': [6, 5], 'Instalación': [4, 3], 'Diagnóstico': [3, 2], 'Inspección': [2, 2] };
  let k = 0;
  Object.entries(SERV).forEach(([tipo, [a, b]]) => [[a, mes0, now], [b, pmes0, mes0 - 1]].forEach(([n, f, t]) => {
    for (let i = 0; i < n; i++, k++) {
      const c = f + rnd() * Math.max(1, t - f);
      ins.run(base({ id: nextId(), kind: 'servicio', status: 'pagada', title: tipo, svc_type: tipo, created_at: c, resolved_at: c + 0.2 * DAY, updated_at: c, amount: Math.round(1500 + rnd() * 5000),
        customer: pick(CLIENTES, k), detail: tipo + ' de ' + pick(UNIDADES, k), ev_need: 3, ev_have: 3 }, k));
    }
  }));
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('home_seed', '1')").run();
})();

// Cobros de ejemplo para la cartera (una sola vez): la mayoría pagados y algunos abiertos con distintas antigüedades.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'cartera_seed'").get()) db.transaction(() => {
  const ag = db.prepare('SELECT id, name FROM agencies WHERE name = ?').get('Chevrolet FAME Morelia'), short = String(ag.name).replace(/^chevrolet\s+/i, '').toUpperCase();
  const ins = db.prepare('INSERT INTO cobros (order_id, folio, concept, agency_id, advisor_id, installed_at, billed_at, parts_amount, total, paid_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const cm = db.prepare('INSERT INTO cobro_comments (cobro_id, advisor_id, text, created_at) VALUES (?,?,?,?)');
  let sd = 5; const rnd = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cand = db.prepare("SELECT id, amount, advisor_id, created_at FROM orders WHERE kind='prea' AND status='aprobada' AND part_status IN ('en_planta','recibida') ORDER BY created_at ASC").all();
  const abiertos = [6, 11, 19, 27, 38, 52, 71], NOTAS = ['Se envió la factura a la planta.', 'La planta pidió aclarar la mano de obra.', 'Seguimiento por correo con el área de garantías.', 'Pago programado por la planta.'];
  const usados = new Set();
  const crear = (o, billed, paid) => {
    const total = +(o.amount || 3500).toFixed(2), parts = +(total * (0.3 + rnd() * 0.25)).toFixed(2), inst = billed - (5 + Math.floor(rnd() * 25)) * DAY;
    const id = ins.run(o.id, o.id, `Cobro ${o.id} · ${short}`, ag.id, o.advisor_id, inst, billed, parts, total, paid, billed).lastInsertRowid;
    if (rnd() > 0.45) cm.run(id, o.advisor_id, NOTAS[Math.floor(rnd() * NOTAS.length)], billed + DAY);
    if (paid) cm.run(id, o.advisor_id, 'Pago registrado.', paid);
    return id;
  };
  // abiertos: una orden cuya aprobación sea anterior a la fecha de cobro
  abiertos.forEach((d, i) => { const b = now - d * DAY, o = cand.find(x => !usados.has(x.id) && x.created_at < b - 12 * DAY); if (o) { usados.add(o.id); crear(o, b, null); } });
  // pagados: 22 más, cobrados entre 20 y 160 días atrás
  cand.filter(x => !usados.has(x.id)).slice(0, 22).forEach((o, i) => { const b = Math.max(o.created_at + 6 * DAY, now - (20 + i * 6.2) * DAY); usados.add(o.id); crear(o, Math.min(b, now - 20 * DAY), Math.min(now - DAY, b + (8 + Math.floor(rnd() * 22)) * DAY)); });
  // campañas realizadas pendientes de cobro
  db.prepare("SELECT id, advisor_id, created_at FROM orders WHERE kind='campana' AND status='realizada'").all().forEach((o, i) => crear({ id: o.id, advisor_id: o.advisor_id, amount: 2400 + i * 900 }, now - (2 + i) * DAY, null));
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('cartera_seed', '1')").run();
})();

// Expedientes: las órdenes que ya traían evidencias marcadas reciben archivos de ejemplo (sin contenido) en esas secciones.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'exp_seed'").get()) db.transaction(() => {
  const POR = { prea: ['evidencias', 'factura', 'firmados', 'cobro', 'destruccion'], servicio: ['evidencias', 'factura', 'firmados'], campana: ['evidencias', 'firmados', 'cobro'] };
  const NOM = { evidencias: 'evidencias-ejemplo.pdf', factura: 'factura-ejemplo.pdf', firmados: 'documentos-firmados-ejemplo.pdf', cobro: 'comprobante-de-cobro-ejemplo.pdf', destruccion: 'destruccion-de-pieza-ejemplo.pdf' };
  const ins = db.prepare("INSERT INTO expediente_files (order_id, section, name, mime, size, note, path, demo, advisor_id, created_at) VALUES (?,?,?,?,0,'Archivo de ejemplo',NULL,1,?,?)");
  db.prepare("SELECT id, kind, ev_have, advisor_id, created_at FROM orders WHERE ev_have > 0").all().forEach(o => {
    const sec = POR[o.kind] || POR.prea;
    sec.slice(0, Math.min(o.ev_have, sec.length)).forEach((k, i) => ins.run(o.id, k, NOM[k], 'application/pdf', o.advisor_id, o.created_at + (i + 1) * 3600e3));
  });
  db.prepare("UPDATE orders SET ev_need = CASE kind WHEN 'prea' THEN 5 ELSE 3 END").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('exp_seed', '1')").run();
})();
const c = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`Base lista en ${DB_PATH}`);
console.log(`  agencias: ${c('agencies')} · asesores: ${c('advisors')} · reglas: ${c('rules')} · piezas: ${c('rule_parts')} · palabras clave: ${c('rule_keywords')}`);
