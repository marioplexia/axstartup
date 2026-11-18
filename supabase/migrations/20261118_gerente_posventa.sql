-- Gerente de posventa: grupos de agencias, rol 'gerente' (con código del grupo),
-- acceso de lectura y gestión a todos los expedientes de SU agencia, y conteo de
-- documentos por sección del expediente (para el tablero y su agente).

-- 1) Grupos (ej. Grupo FAME) y a qué grupo pertenece cada agencia
create table if not exists public.grupos (
  id serial primary key,
  nombre text not null unique,
  created_at timestamptz not null default now()
);
alter table public.grupos enable row level security;
drop policy if exists "grupos public read" on public.grupos;
create policy "grupos public read" on public.grupos for select to anon, authenticated using (true);
grant select on public.grupos to anon, authenticated;

alter table public.agencies add column if not exists grupo_id integer references public.grupos(id);

insert into public.grupos(nombre) values ('Grupo FAME') on conflict (nombre) do nothing;
update public.agencies set grupo_id = (select id from public.grupos where nombre = 'Grupo FAME')
 where grupo_id is null and name ilike '%FAME%';

-- 2) Código de gerente por grupo (nadie lo puede leer desde la app; solo se comprueba)
create table if not exists public.grupo_codigos (
  grupo_id integer primary key references public.grupos(id) on delete cascade,
  codigo text not null
);
alter table public.grupo_codigos enable row level security;
revoke all on public.grupo_codigos from anon, authenticated;

create or replace function public.check_gerente_code(p_agency integer, p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agencies a join public.grupo_codigos g on g.grupo_id = a.grupo_id
     where a.id = p_agency and upper(g.codigo) = upper(btrim(coalesce(p_code, ''))))
$$;
grant execute on function public.check_gerente_code(integer, text) to anon, authenticated;

-- 3) Rol 'gerente'
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role = any (array['admin','asesor','marca','gerente']));

create or replace function public.resolve_profile(p_email text, p_meta jsonb, out o_role text, out o_brand text, out o_agency integer)
returns record language plpgsql stable security definer set search_path = '' as $function$
declare ag int; b text;
begin
  begin ag := nullif(p_meta->>'agency_id','')::int; exception when others then ag := null; end;
  if ag is not null and not exists (select 1 from public.agencies where id = ag) then ag := null; end if;
  o_role := 'asesor'; o_brand := null; o_agency := ag;
  b := nullif(p_meta->>'brand','');
  if p_meta->>'role_req' = 'marca' and b is not null and exists (select 1 from public.brand_codes where brand = b and upper(code) = upper(btrim(coalesce(p_meta->>'code','')))) then
    o_role := 'marca'; o_brand := b; o_agency := null;
  elsif p_meta->>'role_req' = 'gerente' and ag is not null and public.check_gerente_code(ag, p_meta->>'code') then
    o_role := 'gerente';
  elsif exists (select 1 from public.admin_emails a where lower(a.email) = lower(coalesce(p_email,''))) then
    o_role := 'admin';
  end if;
end $function$;

create or replace function public.is_gerente()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select role = 'gerente' from public.profiles where id = (select auth.uid())), false)
$$;

-- ve (y gestiona) lo de otro usuario: el administrador de su agencia, o el gerente de posventa de su agencia
create or replace function public.can_ver(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_admin(target) or (public.is_gerente() and exists (
    select 1 from public.profiles t where t.id = target and t.agency_id = public.my_agency()))
$$;

-- 4) Políticas: lectura y actualización con can_ver (borrar sigue siendo solo del dueño o del administrador)
drop policy if exists "exp read own or agency admin" on public.expedientes;
create policy "exp read own or agency admin" on public.expedientes for select
  using ((user_id = (select auth.uid())) or (select public.can_ver(expedientes.user_id)));
drop policy if exists "exp update own or agency admin" on public.expedientes;
create policy "exp update own or agency admin" on public.expedientes for update
  using ((user_id = (select auth.uid())) or (select public.can_ver(expedientes.user_id)))
  with check ((user_id = (select auth.uid())) or (select public.can_ver(expedientes.user_id)));

drop policy if exists "cartera read own or agency admin" on public.cartera;
create policy "cartera read own or agency admin" on public.cartera for select
  using ((user_id = (select auth.uid())) or (select public.can_ver(cartera.user_id)));
drop policy if exists "cartera update own or agency admin" on public.cartera;
create policy "cartera update own or agency admin" on public.cartera for update
  using ((user_id = (select auth.uid())) or (select public.can_ver(cartera.user_id)))
  with check ((user_id = (select auth.uid())) or (select public.can_ver(cartera.user_id)));

drop policy if exists "piezas read own or agency admin" on public.piezas_pedido;
create policy "piezas read own or agency admin" on public.piezas_pedido for select
  using ((user_id = (select auth.uid())) or (select public.can_ver(piezas_pedido.user_id)));
drop policy if exists "piezas update own or agency admin" on public.piezas_pedido;
create policy "piezas update own or agency admin" on public.piezas_pedido for update
  using ((user_id = (select auth.uid())) or (select public.can_ver(piezas_pedido.user_id)))
  with check ((user_id = (select auth.uid())) or (select public.can_ver(piezas_pedido.user_id)));

drop policy if exists "campanas read own or agency admin" on public.campanas;
create policy "campanas read own or agency admin" on public.campanas for select
  using ((user_id = (select auth.uid())) or (select public.can_ver(campanas.user_id)));

drop policy if exists "activity read own or agency admin" on public.activity;
create policy "activity read own or agency admin" on public.activity for select
  using ((user_id = (select auth.uid())) or (select public.can_ver(activity.user_id)));

-- 5) Conversaciones del Agente de Posventa
alter table public.conversations drop constraint if exists conversations_agent_check;
alter table public.conversations add constraint conversations_agent_check check (agent = any (array['garantias','cobros','mi','posventa']));

-- 6) Documentos por sección del expediente (respeta los permisos de storage de quien llama)
create or replace function public.expediente_secciones(p_ids uuid[])
returns table (expediente_id text, seccion text, archivos integer)
language sql stable security invoker set search_path = '' as $$
  select f[1], f[2], count(*)::int
    from (select storage.foldername(o.name) as f from storage.objects o
           where o.bucket_id = 'expedientes-docs'
             and split_part(o.name, '/', 1) = any (select x::text from unnest(p_ids) x)) s
   where array_length(f, 1) >= 2
   group by 1, 2
$$;
grant execute on function public.expediente_secciones(uuid[]) to authenticated;
