-- 0005_audit: bitácora con hash encadenado por grupo, solo-agregar
create table audit_log (
  id bigserial primary key,
  group_id uuid not null references groups(id),
  actor_id uuid,
  actor_role text,
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb not null default '{}',
  prev_hash text not null,
  hash text not null,
  created_at timestamptz not null
);
create index on audit_log (group_id, id);

create function audit_chain() returns trigger language plpgsql as $$
declare last_hash text;
begin
  perform pg_advisory_xact_lock(hashtext(new.group_id::text));
  select hash into last_hash from audit_log where group_id = new.group_id order by id desc limit 1;
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.created_at := clock_timestamp();
  new.hash := encode(sha256(convert_to(
    new.prev_hash || '|' || new.group_id || '|' || coalesce(new.actor_id::text,'') || '|' ||
    new.action || '|' || new.entity || '|' || coalesce(new.entity_id,'') || '|' ||
    new.data::text || '|' || extract(epoch from new.created_at)::text, 'UTF8')), 'hex');
  return new;
end $$;
create trigger audit_chain_bi before insert on audit_log for each row execute function audit_chain();

create function audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log es solo-agregar'; end $$;
create trigger audit_no_update before update or delete on audit_log for each row execute function audit_immutable();
create trigger audit_no_truncate before truncate on audit_log for each statement execute function audit_immutable();

-- Verifica la cadena de un grupo: devuelve el id de la primera fila rota o null
create function verify_audit_chain(p_group uuid) returns bigint language plpgsql as $$
declare r record; expected_prev text := repeat('0', 64); h text;
begin
  for r in select * from audit_log where group_id = p_group order by id loop
    h := encode(sha256(convert_to(
      r.prev_hash || '|' || r.group_id || '|' || coalesce(r.actor_id::text,'') || '|' ||
      r.action || '|' || r.entity || '|' || coalesce(r.entity_id,'') || '|' ||
      r.data::text || '|' || extract(epoch from r.created_at)::text, 'UTF8')), 'hex');
    if r.prev_hash <> expected_prev or r.hash <> h then return r.id; end if;
    expected_prev := r.hash;
  end loop;
  return null;
end $$;

-- Auditoría automática de reglas y tabuladores + solo reviewer cambia el estado
create function guard_and_audit_knowledge() returns trigger language plpgsql as $$
declare act text; role_now text := nullif(current_setting('app.role', true), '');
        uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if tg_op = 'UPDATE' and old.status is distinct from new.status
     and new.status in ('approved','active','discarded','retired')
     and current_user = 'axai_app' and coalesce(role_now,'') <> 'reviewer' then
    raise exception 'solo el rol reviewer puede cambiar el estado a %', new.status using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.status <> 'candidate' and current_user = 'axai_app'
     and coalesce(role_now,'') <> 'reviewer' then
    raise exception 'solo el rol reviewer puede crear versiones no candidatas' using errcode = '42501';
  end if;
  act := lower(tg_table_name) || '.' || case when tg_op = 'INSERT' then 'create' else 'status:' || old.status || '->' || new.status end;
  insert into audit_log (group_id, actor_id, actor_role, action, entity, entity_id, data)
  values (new.group_id, uid, role_now, act, tg_table_name, new.id::text,
          jsonb_build_object('version', new.version, 'status', new.status));
  return new;
end $$;
create trigger rules_guard after insert or update on rules for each row execute function guard_and_audit_knowledge();
create trigger tabulators_guard after insert or update on tabulators for each row execute function guard_and_audit_knowledge();
