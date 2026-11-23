-- El dueño y el director son del GRUPO, no de una agencia: se registran eligiendo su grupo y su código,
-- sin agencia sede. El perfil guarda grupo_id y todo lo que se basa en my_grupo() (expedientes, bandeja,
-- alertas, tableros) les funciona igual. El gerente y el asesor siguen siendo de una agencia.
alter table public.profiles add column if not exists grupo_id int references public.grupos(id) on delete set null;

create or replace function public.my_grupo() returns integer
language sql stable security definer set search_path to '' as $$
  select coalesce(a.grupo_id, p.grupo_id) from public.profiles p left join public.agencies a on a.id = p.agency_id where p.id = (select auth.uid())
$$;

create or replace function public.check_grupo_code(p_grupo integer, p_rol text, p_code text) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.grupo_codigos g where g.grupo_id = p_grupo and upper(btrim(coalesce(p_code, ''))) <> '' and (
    (p_rol = 'director' and g.codigo_director is not null and upper(g.codigo_director) = upper(btrim(p_code))) or
    (p_rol = 'dueno' and g.codigo_dueno is not null and upper(g.codigo_dueno) = upper(btrim(p_code)))))
$$;
grant execute on function public.check_grupo_code(integer, text, text) to anon, authenticated;

create or replace function public.resolve_profile(p_email text, p_meta jsonb, OUT o_role text, OUT o_brand text, OUT o_agency integer)
returns record language plpgsql stable security definer set search_path to '' as $$
declare ag int; b text; gr int;
begin
  begin ag := nullif(p_meta->>'agency_id','')::int; exception when others then ag := null; end;
  begin gr := nullif(p_meta->>'grupo_id','')::int; exception when others then gr := null; end;
  if ag is not null and not exists (select 1 from public.agencies where id = ag) then ag := null; end if;
  o_role := 'asesor'; o_brand := null; o_agency := ag;
  b := nullif(p_meta->>'brand','');
  if p_meta->>'role_req' = 'marca' and b is not null and exists (select 1 from public.brand_codes where brand = b and upper(code) = upper(btrim(coalesce(p_meta->>'code','')))) then
    o_role := 'marca'; o_brand := b; o_agency := null;
  elsif p_meta->>'role_req' = 'gerente' and ag is not null and public.check_gerente_code(ag, p_meta->>'code') then
    o_role := 'gerente';
  elsif p_meta->>'role_req' in ('director','dueno') and gr is not null and public.check_grupo_code(gr, p_meta->>'role_req', p_meta->>'code') then
    o_role := p_meta->>'role_req'; o_agency := null;
  elsif p_meta->>'role_req' = 'director' and ag is not null and public.check_director_code(ag, p_meta->>'code') then
    o_role := 'director';
  elsif p_meta->>'role_req' = 'dueno' and ag is not null and public.check_dueno_code(ag, p_meta->>'code') then
    o_role := 'dueno';
  elsif exists (select 1 from public.admin_emails a where lower(a.email) = lower(coalesce(p_email,''))) then
    o_role := 'admin';
  end if;
end $$;

-- el grupo del perfil: el de su agencia, o el que eligió el director/dueño al registrarse (ya validado con su código)
create or replace function public.grupo_de_alta(p_role text, p_agency int, p_meta jsonb) returns int
language plpgsql stable security definer set search_path to '' as $$
declare gr int;
begin
  if p_role not in ('director','dueno') then return null; end if;
  if p_agency is not null then return (select grupo_id from public.agencies where id = p_agency); end if;
  begin gr := nullif(p_meta->>'grupo_id','')::int; exception when others then gr := null; end;
  return gr;
end $$;
revoke all on function public.grupo_de_alta(text, int, jsonb) from public, anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  begin
    select * into r from public.resolve_profile(new.email, new.raw_user_meta_data);
    insert into public.profiles(id, name, role, agency_id, brand, grupo_id)
    values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name',''), nullif(split_part(coalesce(new.email,''),'@',1),''), 'Asesor'), r.o_role, r.o_agency, r.o_brand,
      public.grupo_de_alta(r.o_role, r.o_agency, new.raw_user_meta_data))
    on conflict (id) do nothing;
  exception when others then
    raise warning 'handle_new_user: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end $$;

create or replace function public.ensure_profile() returns public.profiles
language plpgsql security definer set search_path to '' as $$
declare u record; p public.profiles; r record;
begin
  select id, email, raw_user_meta_data into u from auth.users where id = (select auth.uid());
  if u.id is null then raise exception 'sin sesión'; end if;
  select * into r from public.resolve_profile(u.email, u.raw_user_meta_data);
  insert into public.profiles(id, name, role, agency_id, brand, grupo_id)
  values (u.id, coalesce(nullif(u.raw_user_meta_data->>'name',''), nullif(split_part(coalesce(u.email,''),'@',1),''), 'Asesor'), r.o_role, r.o_agency, r.o_brand,
    public.grupo_de_alta(r.o_role, r.o_agency, u.raw_user_meta_data))
  on conflict (id) do nothing;
  select * into p from public.profiles where id = u.id;
  return p;
end $$;

-- nadie se cambia de grupo ni de rol desde la app
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if (select auth.uid()) is not null then
    new.role := old.role; new.brand := old.brand; new.grupo_id := old.grupo_id;
  end if;
  return new;
end $$;

-- con agencia nula, "misma agencia" ya no empata con todos los demás perfiles sin agencia
drop policy if exists "profiles read own agency" on public.profiles;
create policy "profiles read own agency" on public.profiles for select using (
  id = (select auth.uid())
  or (not (agency_id is distinct from (select public.my_agency())) and ((select public.my_agency()) is not null or (select public.is_marca())))
  or (agency_id is null and grupo_id is not null and grupo_id = (select public.my_grupo()))
);
