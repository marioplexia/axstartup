-- 0002_orders: órdenes, PREA (versiones y comentarios), evidencia y transacciones
create table orders (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  agency_id uuid not null references agencies(id),
  brand_id uuid not null references brands(id),
  order_number text not null,
  vin text,
  odometer integer,
  claim_date date,
  eval_split text check (eval_split in ('build','blind')),
  ingest_status text not null default 'ok' check (ingest_status in ('ok','needs_review')),
  created_at timestamptz not null default now(),
  unique (agency_id, order_number)
);
create index on orders (group_id, agency_id);

create table prea_versions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  order_id uuid not null references orders(id),
  version_no integer not null,
  submitted_at timestamptz,
  fields jsonb not null default '{}',          -- campos del formulario GM
  text_redacted text not null default '',       -- único texto que puede ir al modelo
  source text not null check (source in ('submitted','reconstructed')),
  created_at timestamptz not null default now(),
  unique (order_id, version_no)
);

create table prea_comments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  order_id uuid not null references orders(id),
  author_role text not null check (author_role in ('plant','advisor')),
  author_ref text,                              -- hash, nunca nombre
  authored_at timestamptz not null,
  body_redacted text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (order_id, content_hash)
);

create table evidence_files (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  order_id uuid not null references orders(id),
  prea_version_id uuid references prea_versions(id),
  kind text not null,
  filename text not null,
  storage_path text,
  sha256 text,
  extracted jsonb,
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  order_id uuid not null references orders(id),
  tx_number text not null,
  claim_date date,
  paid_at date,
  total_paid numeric(12,2),
  is_adjustment boolean not null default false,
  created_at timestamptz not null default now(),
  unique (order_id, tx_number)
);

create table transaction_lines (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  transaction_id uuid not null references transactions(id),
  line_no integer not null,
  concept text not null check (concept in ('labor','part','other')),
  part_no text,
  op_code text,
  description text,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(12,2),
  hours numeric(6,2),
  rate numeric(12,2),
  amount_paid numeric(12,2) not null,
  unique (transaction_id, line_no)
);

create table ingest_anomalies (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  agency_id uuid references agencies(id),
  order_number text not null,
  kind text not null,       -- duplicate_prea | duplicate_transaction | later_adjustment | missing_first_version | missing_prea | missing_transaction
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
