-- Tablero del dueño del grupo: rol dueño, contrato del grupo (para saber cuánto le cuesta Ax AI)
-- y débitos de antes de Ax AI (la línea base contra la que se compara).

-- 1) Rol dueño: ve todo su grupo, igual que el director
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role = any (array['admin','asesor','marca','gerente','director','dueno']));
alter table public.grupo_codigos add column if not exists codigo_dueno text;

-- el dueño hereda la visibilidad de grupo del director (can_ver, profiles, débitos)
create or replace function public.is_director()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select role in ('director','dueno') from public.profiles where id = (select auth.uid())), false)
$$;
create or replace function public.check_dueno_code(p_agency integer, p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agencies a join public.grupo_codigos g on g.grupo_id = a.grupo_id
     where a.id = p_agency and g.codigo_dueno is not null and upper(g.codigo_dueno) = upper(btrim(coalesce(p_code, ''))))
$$;
grant execute on function public.check_dueno_code(integer, text) to anon, authenticated;

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
  elsif p_meta->>'role_req' = 'director' and ag is not null and public.check_director_code(ag, p_meta->>'code') then
    o_role := 'director';
  elsif p_meta->>'role_req' = 'dueno' and ag is not null and public.check_dueno_code(ag, p_meta->>'code') then
    o_role := 'dueno';
  elsif exists (select 1 from public.admin_emails a where lower(a.email) = lower(coalesce(p_email,''))) then
    o_role := 'admin';
  end if;
end $function$;

-- 2) Contrato del grupo: tarifa mensual por agencia (MXN) + % del dinero recuperado, y desde cuándo usa Ax AI.
--    Va aparte de `grupos` (que es de lectura pública para el registro): el precio solo lo ve el grupo.
create table if not exists public.grupo_contrato (
  grupo_id integer primary key references public.grupos(id) on delete cascade,
  tarifa_agencia numeric,          -- MXN por agencia al mes
  pct_recuperado numeric,          -- % del dinero recuperado
  inicio date,                     -- desde cuándo el grupo usa Ax AI (lo de antes es la línea base)
  updated_at timestamptz not null default now()
);
alter table public.grupo_contrato enable row level security;
drop policy if exists "contrato read grupo" on public.grupo_contrato;
create policy "contrato read grupo" on public.grupo_contrato for select
  using ((select public.is_admin()) or ((select public.is_director()) and grupo_id = (select public.my_grupo())));
-- sin política de escritura: el precio lo fija Ax AI directamente en la base, nadie lo cambia desde la app

-- 3) Débitos de antes de Ax AI, por agencia y mes (línea base)
create table if not exists public.debitos_historicos (
  id uuid primary key default gen_random_uuid(),
  agency_id integer not null references public.agencies(id) on delete cascade,
  mes date not null,                         -- primer día del mes
  monto numeric not null default 0 check (monto >= 0),
  cantidad integer not null default 0 check (cantidad >= 0),
  nota text,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (agency_id, mes)
);
alter table public.debitos_historicos enable row level security;
create or replace function public.puede_agencia(p_agency integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or (public.is_gerente() and p_agency = public.my_agency())
      or (public.is_director() and exists (select 1 from public.agencies a where a.id = p_agency and a.grupo_id = public.my_grupo()))
$$;
revoke execute on function public.puede_agencia(integer) from anon, public;
grant execute on function public.puede_agencia(integer) to authenticated;
drop policy if exists "historicos rw" on public.debitos_historicos;
create policy "historicos rw" on public.debitos_historicos for all
  using ((select public.puede_agencia(debitos_historicos.agency_id)))
  with check ((select public.puede_agencia(debitos_historicos.agency_id)));

-- cada grupo existente arranca con su contrato vacío (Ax AI llena tarifa, % e inicio)
insert into public.grupo_contrato (grupo_id) select id from public.grupos on conflict do nothing;
