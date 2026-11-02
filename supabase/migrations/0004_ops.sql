-- 0004_ops: verificación, estimación, resultados, corte nocturno, métricas, eventos
create table verifications (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  agency_id uuid not null references agencies(id),
  order_id uuid references orders(id),
  created_by uuid references users(id),
  draft jsonb not null,
  findings jsonb not null default '[]',
  rule_versions jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table finding_overrides (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  verification_id uuid not null references verifications(id),
  rule_id uuid references rules(id),
  finding_key text not null,
  reason text not null check (length(trim(reason)) > 0),
  user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table estimates (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  agency_id uuid not null references agencies(id),
  order_id uuid references orders(id),
  claim_date date not null,
  total numeric(12,2) not null,
  breakdown jsonb not null,
  tabulator_versions jsonb not null default '[]',
  rule_versions jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table outcomes (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  agency_id uuid not null references agencies(id),
  order_id uuid not null references orders(id) unique,
  estimate_id uuid references estimates(id),
  result text not null check (result in ('accepted','rejected')),
  rounds integer not null default 1,
  first_submitted_at timestamptz,
  accepted_at timestamptz,
  days_to_acceptance numeric(8,2),
  paid_by_concept jsonb not null default '{}',
  total_paid numeric(12,2),
  estimate_error jsonb,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table nightly_runs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','done','failed')),
  params jsonb not null default '{}',
  summary jsonb not null default '{}'
);

create table metrics (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  agency_id uuid references agencies(id),      -- null = marca
  name text not null,
  period_start date not null,
  period_end date not null,
  value numeric(14,4),
  dims jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  order_id uuid references orders(id),
  agent text not null,
  model text not null,
  prompt_hash text not null,                    -- hash del prompt; nunca el texto
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10,6) not null default 0,
  created_at timestamptz not null default now()
);

create table events (
  id bigserial primary key,
  group_id uuid not null references groups(id),
  agency_id uuid,
  type text not null,                           -- prea | comment | payment | rule
  action text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on events (group_id, id);

create function notify_event() returns trigger language plpgsql as $$
begin
  perform pg_notify('axai_events', json_build_object('id', new.id, 'group_id', new.group_id)::text);
  return new;
end $$;
create trigger events_notify after insert on events for each row execute function notify_event();
