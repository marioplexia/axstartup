-- Lo FACTURADO según la hoja de facturación que sube el asesor (no es lo que pagó planta)
alter table public.expedientes
  add column if not exists factura_numero text,
  add column if not exists factura_monto numeric,
  add column if not exists factura_fecha date,
  add column if not exists factura_concepto text,
  add column if not exists factura_src text;
comment on column public.expedientes.factura_monto is 'Lo que se FACTURÓ según la hoja de facturación (no lo que pagó planta)';

-- La cartera tal como viene en el Excel del asesor: se reemplaza con cada archivo nuevo
create table if not exists public.cartera_excel(
  id uuid primary key default gen_random_uuid(),
  agency_id integer references public.agencies(id) on delete cascade default public.my_agency(),
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  archivo text,
  hojas jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cartera_excel_agencia on public.cartera_excel(agency_id, created_at desc);
alter table public.cartera_excel enable row level security;
create policy cartera_excel_ver on public.cartera_excel for select to authenticated
  using (agency_id = public.my_agency() or public.puede_agencia(agency_id));
create policy cartera_excel_subir on public.cartera_excel for insert to authenticated
  with check (agency_id = public.my_agency() and user_id = (select auth.uid()));
create policy cartera_excel_borrar on public.cartera_excel for delete to authenticated
  using (agency_id = public.my_agency());
