-- ══ Vistas a la medida pedidas a la IA ═════════════════════════════════════════════════
-- El dueño o el director escriben lo que quieren ver («quiero ver los débitos de BYD por mes») y la IA lo convierte
-- en una tarjeta de su tablero. La IA no escribe código ni consultas: solo llena una definición cerrada (spec) con
-- fuente, filtros, agrupación, medida y tipo de gráfica, y el servidor calcula los datos dentro del grupo.
-- Las vistas son del grupo: las ve toda la dirección (dueño y directores).
create table if not exists public.vistas (
  id uuid primary key default gen_random_uuid(),
  grupo_id int not null references public.grupos(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  titulo text not null,
  pedido text,
  spec jsonb not null,
  orden int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vistas_grupo_idx on public.vistas (grupo_id, orden, created_at);
alter table public.vistas enable row level security;
drop policy if exists "vistas read" on public.vistas;
create policy "vistas read" on public.vistas for select to authenticated
  using ((select public.is_director()) and grupo_id = (select public.my_grupo()));
drop policy if exists "vistas delete" on public.vistas;
create policy "vistas delete" on public.vistas for delete to authenticated
  using ((select public.is_director()) and grupo_id = (select public.my_grupo()));
drop policy if exists "vistas update" on public.vistas;
create policy "vistas update" on public.vistas for update to authenticated
  using ((select public.is_director()) and grupo_id = (select public.my_grupo()))
  with check ((select public.is_director()) and grupo_id = (select public.my_grupo()));
-- se crean solo desde la función "agentes" (con la definición ya validada)
