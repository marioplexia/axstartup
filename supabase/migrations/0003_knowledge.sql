-- 0003_knowledge: reglas y tabuladores versionados + backtests
create table rules (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  brand_id uuid not null references brands(id),
  rule_key text not null,                        -- identidad estable entre versiones
  version integer not null,
  loop smallint not null check (loop in (1,2)),
  status text not null check (status in ('candidate','approved','active','discarded','retired')),
  kind text not null,                            -- required_field | required_evidence | deadline | duplicate | code_pair | ...
  title text not null,
  severity text not null default 'warning' check (severity in ('info','warning','blocker')),
  condition jsonb not null,
  evidence jsonb not null default '[]',          -- casos que la respaldan
  origin text not null check (origin in ('form','learned','manual')),
  valid_from date,
  valid_to date,
  supersedes_id uuid references rules(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (group_id, rule_key, version)
);
create unique index rules_one_active on rules (group_id, rule_key) where status = 'active';
create index on rules (group_id, status);

create table tabulators (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  brand_id uuid not null references brands(id),
  tab_key text not null,                         -- p.ej. labor_rate | std_time:OP-MT-001 | part_price:PZ-1 | cap:labor | deductible
  version integer not null,
  kind text not null check (kind in ('labor_rate','standard_time','part_price','cap','deductible')),
  subject text,                                  -- op_code / part_no / concepto
  value numeric(14,4) not null,
  unit text not null,
  status text not null check (status in ('candidate','approved','active','discarded','retired')),
  valid_from date not null,
  valid_to date,
  origin text not null check (origin in ('seed','learned','manual')),
  support jsonb not null default '[]',           -- pagos de respaldo (transaction_line ids)
  supersedes_id uuid references tabulators(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (group_id, tab_key, version)
);
create index on tabulators (group_id, kind, subject, valid_from);

create table rule_backtests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  rule_id uuid references rules(id),
  tabulator_id uuid references tabulators(id),
  nightly_run_id uuid,
  cases_total integer not null,
  true_positives integer not null default 0,
  false_positives integer not null default 0,
  missed integer not null default 0,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
