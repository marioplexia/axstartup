-- Reglas del cerebro destiladas de los manuales de GM (Manual de Políticas y Procedimientos 2026 y curso
-- Administración de Garantías 2026). Los datos se cargan solo en la base (el manual es confidencial).
create table if not exists public.manual_reglas (
  id text primary key,
  seccion_expediente text not null,
  tema text not null,
  regla text not null,
  como_verificar text,
  consecuencia text,
  fuente text not null,
  pagina integer,
  orden integer not null default 0
);
alter table public.manual_reglas enable row level security;
drop policy if exists "manual_reglas read" on public.manual_reglas;
create policy "manual_reglas read" on public.manual_reglas for select to authenticated using (true);
grant select on public.manual_reglas to authenticated;
