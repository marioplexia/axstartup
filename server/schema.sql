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
