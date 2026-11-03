-- Esquema de Ax AI Garantías (SQLite)
-- Refleja las estructuras de index.html: ADVISORS, CASES/GMCODES y RS (reglas aprendidas).

CREATE TABLE IF NOT EXISTS agencies (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,                  -- 'Chevrolet FAME Morelia'
  brand   TEXT NOT NULL,                         -- 'Chevrolet'
  region  TEXT NOT NULL,                         -- 'Región Morelia (Sede Principal)'
  city    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advisors (
  id            TEXT PRIMARY KEY,                -- 'a1', 'a2'...
  name          TEXT NOT NULL,
  email         TEXT UNIQUE COLLATE NOCASE,      -- login; NULL en asesores de ejemplo
  agency_id     INTEGER REFERENCES agencies(id),
  password_hash TEXT,                            -- bcrypt; NULL = sin acceso aún
  role          TEXT NOT NULL DEFAULT 'asesor' CHECK (role IN ('asesor','admin')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- Regla de garantía aprendida (una por familia de falla)
CREATE TABLE IF NOT EXISTS rules (
  id           TEXT PRIMARY KEY,                 -- 'R-0001'
  sys          TEXT NOT NULL,                    -- Motor, Transmisión...
  q_code       TEXT NOT NULL,  q_text TEXT NOT NULL,   -- queja
  c_code       TEXT NOT NULL,  c_text TEXT NOT NULL,   -- causa
  r_code       TEXT NOT NULL,  r_text TEXT NOT NULL,   -- corrección
  op           TEXT NOT NULL,                    -- OP-MT-031
  op_desc      TEXT NOT NULL,
  hours        REAL NOT NULL,                    -- horas por caso (h)
  hours_sum    REAL NOT NULL DEFAULT 0,          -- acumulado (hSum)
  n            INTEGER NOT NULL DEFAULT 0,       -- casos aceptados
  rej          INTEGER NOT NULL DEFAULT 0,       -- casos rechazados
  status       TEXT NOT NULL DEFAULT 'aprendizaje'
               CHECK (status IN ('activa','aprendizaje','por-aprobar','distribuyendo','pausada')),
  src_base       INTEGER NOT NULL DEFAULT 0,     -- origen: catálogo base
  src_historico  INTEGER NOT NULL DEFAULT 0,     -- origen: histórico importado
  src_asesor     INTEGER NOT NULL DEFAULT 0,     -- origen: casos de asesores
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_rules_sys    ON rules(sys);

CREATE TABLE IF NOT EXISTS rule_parts (
  rule_id  TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  part_no  TEXT NOT NULL,                        -- PZ-MT-6120
  descr    TEXT NOT NULL,
  qty      REAL NOT NULL,
  price    REAL NOT NULL,
  n        INTEGER NOT NULL DEFAULT 0,           -- veces vista
  PRIMARY KEY (rule_id, part_no)
);

CREATE TABLE IF NOT EXISTS rule_keywords (
  rule_id  TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  keyword  TEXT NOT NULL,
  PRIMARY KEY (rule_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_kw ON rule_keywords(keyword);

-- Qué asesor ya recibió cada regla (dist)
CREATE TABLE IF NOT EXISTS rule_distribution (
  rule_id     TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  advisor_id  TEXT NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, advisor_id)
);

-- Bitácora (creada, reforzada, activada, distribuida, importacion, rechazo...)
CREATE TABLE IF NOT EXISTS rule_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  type        TEXT NOT NULL,
  rule_id     TEXT,                              -- puede ser vacío (eventos globales)
  advisor_id  TEXT,
  msg         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON rule_log(ts DESC);

-- Casos enviados por cada asesor (alimentan el aprendizaje)
CREATE TABLE IF NOT EXISTS cases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  advisor_id  TEXT NOT NULL REFERENCES advisors(id),
  rule_id     TEXT REFERENCES rules(id),
  brand       TEXT,
  vin         TEXT,
  odometer    INTEGER,
  complaint   TEXT NOT NULL,
  accepted    INTEGER,                           -- 1 aceptado, 0 rechazado, NULL pendiente
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_rule ON cases(rule_id);

-- Configuración clave/valor (umbral de aprendizaje 'th', 'auto', etc.)
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Evita duplicar eventos cuando varios clientes reenvían la misma bitácora
CREATE UNIQUE INDEX IF NOT EXISTS idx_log_uniq ON rule_log(ts, type, rule_id, msg);

-- Órdenes de la bitácora (PREAs, servicios y campañas)
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,                  -- folio 'G-MVZVD1RQ'
  kind        TEXT NOT NULL CHECK (kind IN ('prea','servicio','campana')),
  status      TEXT NOT NULL,                     -- preaprobada|aprobada|rechazada|atencion|pendiente|pagada|realizada
  insurer     TEXT NOT NULL DEFAULT 'General Motors de México',
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  vin         TEXT,
  km          INTEGER,
  amount      REAL NOT NULL DEFAULT 0,
  rule_id     TEXT,
  advisor_id  TEXT REFERENCES advisors(id),
  agency_id   INTEGER REFERENCES agencies(id),
  ev_have     INTEGER NOT NULL DEFAULT 0,        -- evidencias del expediente cargadas
  ev_need     INTEGER NOT NULL DEFAULT 5,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,                           -- aprobación / pago / realización
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_agency ON orders(agency_id, kind, created_at DESC);

-- Conversaciones de «Mi Agente»
CREATE TABLE IF NOT EXISTS chat_threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  advisor_id  TEXT NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_adv ON chat_threads(advisor_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_thread ON chat_messages(thread_id, id);

-- Cartera: piezas instaladas y cobradas a la planta
CREATE TABLE IF NOT EXISTS cobros (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  folio         TEXT NOT NULL,
  concept       TEXT NOT NULL,
  agency_id     INTEGER REFERENCES agencies(id),
  advisor_id    TEXT REFERENCES advisors(id),
  installed_at  INTEGER,                         -- fecha de instalación de la pieza
  billed_at     INTEGER NOT NULL,                -- fecha del cobro a la planta
  parts_amount  REAL NOT NULL DEFAULT 0,         -- valor de refacciones
  total         REAL NOT NULL DEFAULT 0,         -- piezas + mano de obra
  paid_at       INTEGER,                         -- NULL = saldo abierto
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cobros_agency ON cobros(agency_id, billed_at DESC);
CREATE INDEX IF NOT EXISTS idx_cobros_order ON cobros(order_id);
CREATE TABLE IF NOT EXISTS cobro_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cobro_id    INTEGER NOT NULL REFERENCES cobros(id) ON DELETE CASCADE,
  advisor_id  TEXT REFERENCES advisors(id),
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cc_cobro ON cobro_comments(cobro_id, id);

-- Expedientes: archivos y evidencias de cada orden
CREATE TABLE IF NOT EXISTS expediente_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  section     TEXT NOT NULL,                     -- evidencias | factura | firmados | cobro | destruccion
  name        TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  path        TEXT,                              -- archivo en disco (NULL en los de ejemplo)
  demo        INTEGER NOT NULL DEFAULT 0,
  advisor_id  TEXT REFERENCES advisors(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expf_order ON expediente_files(order_id, section);
CREATE TABLE IF NOT EXISTS expediente_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  advisor_id  TEXT REFERENCES advisors(id),
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expa_order ON expediente_audit(order_id, id DESC);

-- Entrenamiento del agente: PREAs aceptadas y transacciones pagadas de planta (PDF o imagen)
CREATE TABLE IF NOT EXISTS train_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('prea','pago','prueba')),
  name        TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  path        TEXT,
  hash        TEXT,
  status      TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | procesando | aprendida | revisar | duplicada | error
  error       TEXT,
  engine      TEXT,                                -- ia | pdf | ocr
  data        TEXT,                                -- JSON con los campos leídos
  texto       TEXT,
  rule_id     TEXT,
  link_id     INTEGER,                             -- pago -> PREA relacionada
  agency_id   INTEGER REFERENCES agencies(id),
  advisor_id  TEXT REFERENCES advisors(id),
  created_at  INTEGER NOT NULL,
  learned_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_td_kind ON train_docs(agency_id, kind, status);

-- Contextos (variantes) de cada regla: una por PREA aceptada (modelo, año, operación, causa, piezas…)
CREATE TABLE IF NOT EXISTS rule_variants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  doc_id     INTEGER,
  marca      TEXT, modelo TEXT, anio INTEGER, km INTEGER,
  op         TEXT, op_desc TEXT, c_code TEXT, c_text TEXT, r_code TEXT, r_text TEXT,
  hours      REAL,
  parts      TEXT,                                  -- JSON [[numero, descripción, cantidad, precio]]
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rv_rule ON rule_variants(rule_id);
-- Errores aprendidos (rechazos y solicitudes de la planta, y PREAs rechazadas), ligados a la queja de la regla
CREATE TABLE IF NOT EXISTS train_lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     INTEGER,
  sys        TEXT NOT NULL,
  q_code     TEXT NOT NULL,
  problema   TEXT NOT NULL,
  correccion TEXT,
  temas      TEXT,                                  -- JSON
  tipo       TEXT,
  origen     TEXT,                                  -- aceptada | rechazada | comparacion
  fecha      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tl_key ON train_lessons(sys, q_code);
