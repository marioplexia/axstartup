-- ══ Agentes que hacen el trabajo del dueño · Correo del grupo ══════════════════════════════
-- Seis agentes trabajan para la dirección del grupo (dueño y director) y le escriben a un correo interno del grupo:
-- débitos y controversias, vigilante de agencias, cobranza a planta, adopción, comparador entre agencias e informe semanal.
-- Cada mensaje puede traer una decisión (aprobar una controversia, mandar un recordatorio a las agencias); el dueño
-- solo aprueba o rechaza, y la plataforma ejecuta. Un séptimo agente contesta preguntas del dueño con los datos del grupo.
create table if not exists public.buzon (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  grupo_id int not null references public.grupos(id) on delete cascade,
  agente text not null check (agente in ('debitos','vigilante','cobranza','adopcion','comparador','informe','dueno')),
  asunto text not null,
  cuerpo text,
  prioridad text not null default 'normal' check (prioridad in ('alta','normal','baja')),
  agency_id int references public.agencies(id) on delete set null,
  accion jsonb,
  estado text not null default 'nuevo' check (estado in ('nuevo','leido','aprobado','rechazado','hecho','archivado')),
  decidido_por uuid references public.profiles(id) on delete set null,
  decidido_at timestamptz,
  respuesta text,
  clave text unique,
  datos jsonb not null default '{}'::jsonb
);
create index if not exists buzon_grupo_idx on public.buzon (grupo_id, created_at desc);
alter table public.buzon enable row level security;
drop policy if exists "buzon read" on public.buzon;
create policy "buzon read" on public.buzon for select to authenticated
  using ((select public.is_director()) and grupo_id = (select public.my_grupo()));
drop policy if exists "buzon leer" on public.buzon;
create policy "buzon leer" on public.buzon for update to authenticated
  using ((select public.is_director()) and grupo_id = (select public.my_grupo()))
  with check ((select public.is_director()) and grupo_id = (select public.my_grupo()));
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'buzon') then
    alter publication supabase_realtime add table public.buzon;
  end if;
end $$;

-- lo que el agente de débitos concluyó de cada débito (si se puede pelear, con qué y la carta)
alter table public.debitos add column if not exists controversia jsonb;
alter table public.debitos add column if not exists evaluado_at timestamptz;

-- avisos a una agencia: a sus gerentes de posventa; si no tiene, a todos sus usuarios
create or replace function public.avisar_agencia(p_agency int, p_titulo text, p_cuerpo text, p_accion text, p_exp uuid default null, p_urgente boolean default false) returns int
language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  insert into public.alertas (tipo, alcance, user_id, titulo, cuerpo, accion, expediente_id, urgente)
  select 'avance', 'usuario', u.id, left(p_titulo, 200), left(p_cuerpo, 1500), left(p_accion, 400), p_exp, p_urgente
  from public.profiles u
  where u.agency_id = p_agency and (u.role = 'gerente' or not exists (select 1 from public.profiles g where g.agency_id = p_agency and g.role = 'gerente'));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.avisar_agencia(int, text, text, text, uuid, boolean) from public, anon, authenticated;

-- el dueño decide sobre un mensaje y la plataforma lo ejecuta
create or replace function public.buzon_decidir(p_id uuid, p_dec text, p_resp text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare m public.buzon; a jsonb; yo text; n int := 0; d record; ag int; est text;
begin
  select * into m from public.buzon where id = p_id;
  if m.id is null or not public.is_director() or m.grupo_id is distinct from public.my_grupo() then raise exception 'mensaje_no_disponible'; end if;
  select split_part(coalesce(name, 'La dirección'), ' ', 1) into yo from public.profiles where id = (select auth.uid());
  a := coalesce(m.accion, '{}'::jsonb);
  if p_dec = 'reenviar' then
    if m.agency_id is null then raise exception 'sin_agencia'; end if;
    n := public.avisar_agencia(m.agency_id, yo || ' (dirección): ' || m.asunto, coalesce(nullif(btrim(p_resp), ''), m.asunto), 'Contesta en la bandeja o con tu gerente.', null, false);
    est := 'hecho';
  elsif a->>'tipo' = 'controversia' then
    select x.id, x.user_id, x.monto, x.motivo, x.agency_id, x.expediente_id into d from public.debitos x where x.id = (a->>'debito_id')::uuid;
    if d.id is null then raise exception 'debito_no_existe'; end if;
    if p_dec = 'aprobar' then
      update public.debitos set estado = 'en_controversia' where id = d.id;
      insert into public.alertas (tipo, alcance, user_id, titulo, cuerpo, accion, expediente_id, urgente)
      values ('avance', 'usuario', d.user_id, yo || ' aprobó pelear un débito de $' || to_char(coalesce(d.monto, 0), 'FM999,999,990'),
        'Motivo de GM: ' || coalesce(left(d.motivo, 300), '') || '. La carta de controversia ya está lista en el expediente.',
        'Abre el expediente, revisa la carta y súbela a GWM con la evidencia.', d.expediente_id, true);
      n := 1; est := 'aprobado';
    else
      update public.debitos set estado = 'aceptado' where id = d.id; est := 'rechazado';
    end if;
  elsif a->>'tipo' = 'recordatorio' then
    if p_dec = 'aprobar' then
      for ag in select jsonb_array_elements_text(coalesce(a->'agencias', '[]'::jsonb))::int loop
        n := n + public.avisar_agencia(ag, coalesce(a->>'titulo', 'Mensaje de la dirección'), coalesce(nullif(btrim(p_resp), ''), a->>'mensaje', ''), coalesce(a->>'que_hacer', ''), null, false);
      end loop;
      est := 'aprobado';
    else est := 'rechazado'; end if;
  else
    est := case when p_dec in ('aprobar', 'hecho') then 'hecho' when p_dec = 'rechazar' then 'rechazado' else 'archivado' end;
  end if;
  update public.buzon set estado = est, decidido_por = (select auth.uid()), decidido_at = now(), respuesta = nullif(btrim(coalesce(p_resp, '')), '') where id = p_id;
  return jsonb_build_object('estado', est, 'avisados', n);
end $$;
revoke all on function public.buzon_decidir(uuid, text, text) from public, anon;
grant execute on function public.buzon_decidir(uuid, text, text) to authenticated;

-- los agentes trabajan solos: diario los de vigilancia, cobranza, adopción y débitos; los lunes el comparador y el informe
do $$ begin
  perform cron.unschedule('agentes-dueno-diario') where exists (select 1 from cron.job where jobname = 'agentes-dueno-diario');
  perform cron.unschedule('agentes-dueno-lunes') where exists (select 1 from cron.job where jobname = 'agentes-dueno-lunes');
end $$;
select cron.schedule('agentes-dueno-diario', '7 13 * * *', $c$
  select net.http_post(url := 'https://fjmzzghptxkcoarymmzn.supabase.co/functions/v1/agentes',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-learn-token', (select valor from public.config_interna where clave = 'learn_token')),
    body := '{"agentes":["debitos","vigilante","cobranza","adopcion"]}'::jsonb, timeout_milliseconds := 120000)
$c$);
select cron.schedule('agentes-dueno-lunes', '23 13 * * 1', $c$
  select net.http_post(url := 'https://fjmzzghptxkcoarymmzn.supabase.co/functions/v1/agentes',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-learn-token', (select valor from public.config_interna where clave = 'learn_token')),
    body := '{"agentes":["comparador","informe"]}'::jsonb, timeout_milliseconds := 150000)
$c$);
