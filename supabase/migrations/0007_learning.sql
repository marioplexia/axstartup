-- 0007_learning: evidencia por versión y clasificación de rechazos
alter table evidence_files add column version_no integer not null default 1;
create unique index evidence_unique on evidence_files (order_id, kind, filename, version_no);

create table rejection_classifications (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  order_id uuid not null references orders(id),
  comment_id uuid not null references prea_comments(id),
  taxonomy_version integer not null,
  cause_code text not null,
  field text,
  confidence numeric(4,3) not null,
  created_at timestamptz not null default now(),
  unique (comment_id, taxonomy_version)
);
alter table rejection_classifications enable row level security;
alter table rejection_classifications force row level security;
create policy tenant_isolation on rejection_classifications using (group_id = current_group()) with check (group_id = current_group());
grant select, insert, update on rejection_classifications to axai_app;
