-- 0006_rls: aislamiento por group_id. La app corre como axai_app y fija app.group_id por transacción.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'axai_app') then
    create role axai_app nologin;
  end if;
end $$;

create function current_group() returns uuid language sql stable as
$$ select nullif(current_setting('app.group_id', true), '')::uuid $$;

do $$
declare t text;
begin
  for t in select unnest(array[
    'brands','agencies','users','orders','prea_versions','prea_comments','evidence_files',
    'transactions','transaction_lines','ingest_anomalies','rules','tabulators','rule_backtests',
    'verifications','finding_overrides','estimates','outcomes','nightly_runs','metrics',
    'llm_calls','events','audit_log'])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (group_id = current_group()) with check (group_id = current_group())', t);
  end loop;
end $$;

alter table groups enable row level security;
alter table groups force row level security;
create policy tenant_isolation on groups using (id = current_group()) with check (id = current_group());

grant usage on schema public to axai_app;
grant select, insert, update on all tables in schema public to axai_app;
revoke update on audit_log from axai_app;
grant usage, select on all sequences in schema public to axai_app;
grant execute on all functions in schema public to axai_app;
