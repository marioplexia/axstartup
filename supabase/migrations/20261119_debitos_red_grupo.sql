-- Débitos de GM que se vuelven reglas para toda la red, dinero recuperado y director de grupo.

-- 1) Reglas aprendidas: además de las del manual, las que nacen de un débito real
alter table public.manual_reglas
  add column if not exists origen text not null default 'manual',      -- manual | debito
  add column if not exists veces integer not null default 0,           -- débitos que la confirmaron
  add column if not exists monto_debitado numeric not null default 0,  -- suma de lo debitado por esta causa
  add column if not exists agencias integer not null default 0,        -- agencias distintas a las que les pasó
  add column if not exists ultima_vez timestamptz,
  add column if not exists creada_at timestamptz not null default now();

-- 2) Débitos registrados (la notificación de GWM que sube la agencia)
create table if not exists public.debitos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  agency_id integer references public.agencies(id),
  expediente_id uuid references public.expedientes(id) on delete set null,
  transaccion text,
  fecha date,
  monto numeric not null default 0,
  motivo text,
  seccion text,
  regla_id text references public.manual_reglas(id),
  regla_nueva boolean not null default false,
  archivo text,
  estado text not null default 'debitado' check (estado in ('debitado','en_controversia','revertido','aceptado')),
  monto_revertido numeric not null default 0,
  revertido_at date,
  created_at timestamptz not null default now()
);
create index if not exists debitos_agency_idx on public.debitos(agency_id, created_at desc);
alter table public.debitos enable row level security;

-- 3) Director de grupo: ve todas las agencias de su grupo
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role = any (array['admin','asesor','marca','gerente','director']));
alter table public.grupo_codigos add column if not exists codigo_director text;

create or replace function public.my_grupo()
returns integer language sql stable security definer set search_path = '' as $$
  select a.grupo_id from public.profiles p join public.agencies a on a.id = p.agency_id where p.id = (select auth.uid())
$$;
create or replace function public.is_director()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select role = 'director' from public.profiles where id = (select auth.uid())), false)
$$;
create or replace function public.check_director_code(p_agency integer, p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agencies a join public.grupo_codigos g on g.grupo_id = a.grupo_id
     where a.id = p_agency and g.codigo_director is not null and upper(g.codigo_director) = upper(btrim(coalesce(p_code, ''))))
$$;
grant execute on function public.check_director_code(integer, text) to anon, authenticated;
revoke execute on function public.my_grupo() from anon, public;
revoke execute on function public.is_director() from anon, public;
grant execute on function public.my_grupo(), public.is_director() to authenticated;

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
  elsif exists (select 1 from public.admin_emails a where lower(a.email) = lower(coalesce(p_email,''))) then
    o_role := 'admin';
  end if;
end $function$;

-- el director ve (y gestiona) lo de todas las agencias de su grupo; el gerente, lo de su agencia
create or replace function public.can_ver(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_admin(target)
      or (public.is_gerente() and exists (select 1 from public.profiles t where t.id = target and t.agency_id = public.my_agency()))
      or (public.is_director() and exists (select 1 from public.profiles t join public.agencies a on a.id = t.agency_id
                                            where t.id = target and a.grupo_id = public.my_grupo()))
$$;
drop policy if exists "profiles read grupo director" on public.profiles;
create policy "profiles read grupo director" on public.profiles for select
  using ((select public.is_director()) and exists (select 1 from public.agencies a where a.id = profiles.agency_id and a.grupo_id = (select public.my_grupo())));

-- débitos: los ve quien ve al usuario (dueño, gerente de su agencia, director de su grupo, admin)
drop policy if exists "debitos read" on public.debitos;
create policy "debitos read" on public.debitos for select using ((user_id = (select auth.uid())) or (select public.can_ver(debitos.user_id)));
drop policy if exists "debitos insert own" on public.debitos;
create policy "debitos insert own" on public.debitos for insert with check (user_id = (select auth.uid()));
drop policy if exists "debitos update" on public.debitos;
create policy "debitos update" on public.debitos for update using ((user_id = (select auth.uid())) or (select public.can_ver(debitos.user_id)))
  with check ((user_id = (select auth.uid())) or (select public.can_ver(debitos.user_id)));

-- 4) Dinero recuperado, por agencia (respeta lo que puede ver quien consulta)
--    · protegido: expedientes que el cerebro marcó con algo que no cumple el manual y que, al volver a subir
--      el documento, ya cumplen antes de cobrarse (GM debita el total de la transacción)
--    · revertido: lo que GM devolvió de débitos en controversia
create or replace function public.dinero_recuperado(p_desde date default null)
returns table (agency_id integer, agencia text, expedientes integer, protegidos integer, monto_protegido numeric,
               debitos integer, monto_debitado numeric, revertidos integer, monto_revertido numeric)
language sql stable security invoker set search_path = '' as $$
  with ex as (
    select e.id, e.folio, coalesce(e.labor,0) + coalesce(e.parts_total,0) as monto, p.agency_id
      from public.expedientes e join public.profiles p on p.id = e.user_id
     where p_desde is null or e.created_at >= p_desde
  ), revs as (
    select d.folio, d.resultado, d.created_at, coalesce((d.datos->>'corregido')::boolean, false) as corregido,
           exists (select 1 from jsonb_array_elements(coalesce(d.datos->'cumplimiento','[]'::jsonb)) c where c->>'estado' = 'no_cumple') as malo
      from public.entrenamiento_docs d where d.kind = 'expediente' and d.folio in (select folio from ex)
  ), corregidos as (
    select distinct r.folio from revs r
     where r.corregido
        or (r.malo and exists (select 1 from revs r2 where r2.folio = r.folio and r2.resultado = r.resultado and r2.created_at > r.created_at and not r2.malo))
  ), deb as (
    select d.agency_id, count(*) n, sum(d.monto) m, count(*) filter (where d.estado = 'revertido') nr, sum(d.monto_revertido) mr
      from public.debitos d where p_desde is null or d.created_at >= p_desde group by d.agency_id
  )
  select a.id, a.name,
         (select count(*) from ex where ex.agency_id = a.id)::int,
         (select count(*) from ex join corregidos c on c.folio = ex.folio where ex.agency_id = a.id)::int,
         coalesce((select sum(ex.monto) from ex join corregidos c on c.folio = ex.folio where ex.agency_id = a.id), 0),
         coalesce(deb.n, 0)::int, coalesce(deb.m, 0), coalesce(deb.nr, 0)::int, coalesce(deb.mr, 0)
    from public.agencies a left join deb on deb.agency_id = a.id
   where exists (select 1 from ex where ex.agency_id = a.id) or deb.agency_id is not null
   order by a.id
$$;
grant execute on function public.dinero_recuperado(date) to authenticated;
