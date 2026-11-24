-- Aprende Ax AI: avance de cada usuario en los cursos de la plataforma
create table if not exists public.aprendizaje_progreso (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  leccion text not null check (length(leccion) between 1 and 60),
  curso text not null check (length(curso) between 1 and 40),
  quiz_ok boolean not null default true,
  completada_at timestamptz not null default now(),
  primary key (user_id, leccion)
);
alter table public.aprendizaje_progreso enable row level security;
drop policy if exists ap_sel on public.aprendizaje_progreso;
drop policy if exists ap_ins on public.aprendizaje_progreso;
drop policy if exists ap_upd on public.aprendizaje_progreso;
drop policy if exists ap_del on public.aprendizaje_progreso;
create policy ap_sel on public.aprendizaje_progreso for select to authenticated using (user_id = auth.uid());
create policy ap_ins on public.aprendizaje_progreso for insert to authenticated with check (user_id = auth.uid());
create policy ap_upd on public.aprendizaje_progreso for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy ap_del on public.aprendizaje_progreso for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.aprendizaje_progreso to authenticated;
