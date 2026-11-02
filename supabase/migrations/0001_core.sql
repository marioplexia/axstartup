-- 0001_core: organización (grupo > marca/agencia) y usuarios
create table groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table brands (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  name text not null,
  code text not null,
  created_at timestamptz not null default now(),
  unique (group_id, code)
);

create table agencies (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  brand_id uuid not null references brands(id),
  name text not null,
  city text not null,
  created_at timestamptz not null default now(),
  unique (group_id, brand_id, name)
);

create table users (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  agency_id uuid references agencies(id),
  email text not null,
  display_name text not null,
  role text not null check (role in ('advisor','reviewer','owner')),
  created_at timestamptz not null default now(),
  unique (group_id, email)
);
