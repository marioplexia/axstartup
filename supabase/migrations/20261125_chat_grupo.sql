-- Chat de la Bandeja: una sala por grupo y marca (asesores, gerentes, director y dueño).
-- Aplicada en el proyecto con el mismo contenido (ver chat_grupo en Supabase).
create table if not exists public.chat_grupo(
  id bigint generated always as identity primary key,
  grupo_id integer not null references public.grupos(id) on delete cascade,
  marca text not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  autor text, rol text, agencia text,
  texto text not null check (length(texto) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists chat_grupo_sala on public.chat_grupo(grupo_id,marca,created_at desc);
alter table public.chat_grupo enable row level security;

create or replace function public.chat_puede(p_grupo integer,p_marca text) returns boolean
language sql stable security definer set search_path to '' as $$
  select p_grupo = public.my_grupo() and (
    public.is_director()
    or exists(select 1 from public.profiles p join public.agencies a on a.id=p.agency_id
              where p.id=(select auth.uid()) and coalesce(a.marca_grupo,a.brand)=p_marca))
$$;

create or replace function public.chat_salas() returns table(grupo_id integer, marca text, agencias integer)
language sql stable security definer set search_path to '' as $$
  select a.grupo_id, coalesce(a.marca_grupo,a.brand), count(*)::int
  from public.agencies a
  where a.grupo_id = public.my_grupo() and public.chat_puede(a.grupo_id, coalesce(a.marca_grupo,a.brand))
  group by 1,2 order by 2
$$;

create or replace function public.chat_miembros(p_grupo integer,p_marca text) returns table(id uuid,name text,role text,agencia text)
language sql stable security definer set search_path to '' as $$
  select p.id,p.name,p.role,a.name from public.profiles p left join public.agencies a on a.id=p.agency_id
  where public.chat_puede(p_grupo,p_marca)
    and ( (a.grupo_id=p_grupo and coalesce(a.marca_grupo,a.brand)=p_marca)
       or (p.agency_id is null and p.grupo_id=p_grupo and p.role in ('director','dueno')) )
  order by case p.role when 'dueno' then 0 when 'director' then 1 when 'gerente' then 2 else 3 end, p.name
$$;

create or replace function public.chat_grupo_autor() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  new.user_id := (select auth.uid());
  select p.name, p.role, a.name into new.autor, new.rol, new.agencia
    from public.profiles p left join public.agencies a on a.id=p.agency_id where p.id=new.user_id;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists chat_grupo_autor on public.chat_grupo;
create trigger chat_grupo_autor before insert on public.chat_grupo for each row execute function public.chat_grupo_autor();

create policy chat_grupo_ver on public.chat_grupo for select to authenticated using (public.chat_puede(grupo_id,marca));
create policy chat_grupo_escribir on public.chat_grupo for insert to authenticated with check (public.chat_puede(grupo_id,marca));
create policy chat_grupo_borrar on public.chat_grupo for delete to authenticated using (user_id=(select auth.uid()));

revoke all on function public.chat_salas() from anon;
revoke all on function public.chat_miembros(integer,text) from anon;
alter publication supabase_realtime add table public.chat_grupo;
