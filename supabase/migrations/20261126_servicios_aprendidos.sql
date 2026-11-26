-- Lo que el cerebro aprende de cada servicio que lee (aplicada en el proyecto con este contenido).
-- Tabla public.servicios_aprendidos: una fila por expediente de servicio con tipo_servicio, clave, modelo, anio, km,
-- operacion, operacion_desc, horas_mo, tarifa_hora, mano_obra, piezas, subtotal, total_facturado, pagado_planta,
-- pago_estado, pago_fecha, recorte y archivos. RLS: se ve lo del propio grupo; la red solo en agregados.
-- La escriben las funciones servicio y pago (service role).
-- servicios_referencia(p_tipo, p_marca) agrega la llave «aprendido» con horas de mano de obra, pagado por planta,
-- operaciones y unidades del grupo, y horas/pagado de la red (sin nombres de agencias de otros grupos).
create table if not exists public.servicios_aprendidos(
  expediente_id uuid primary key references public.expedientes(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  agency_id integer references public.agencies(id) on delete set null,
  grupo_id integer references public.grupos(id) on delete set null,
  marca text, wo text, tipo_servicio text, clave text, modelo text, anio integer, km integer,
  operacion text, operacion_desc text, horas_mo numeric, tarifa_hora numeric, mano_obra numeric, piezas numeric,
  subtotal numeric, total_facturado numeric, pagado_planta numeric, pago_estado text, pago_fecha date, recorte numeric,
  archivos text[] default '{}', updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index if not exists servicios_aprendidos_clave on public.servicios_aprendidos(clave, marca);
create index if not exists servicios_aprendidos_grupo on public.servicios_aprendidos(grupo_id);
alter table public.servicios_aprendidos enable row level security;
create policy servicios_aprendidos_ver on public.servicios_aprendidos for select to authenticated
  using (grupo_id = public.my_grupo() or public.is_admin());
-- (servicios_referencia: ver la versión aplicada en el proyecto)
