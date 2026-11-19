-- Plazos del manual de GM por expediente (semáforo), checklist de PRA y control de destrucción de partes
alter table public.expedientes
  add column if not exists orden_apertura date,
  add column if not exists orden_cierre date,
  add column if not exists gwm_cobrada_at date,
  add column if not exists transaccion_aceptada_at date,
  add column if not exists pra_rechazada_at timestamptz,
  add column if not exists pra_corregida_at timestamptz,
  add column if not exists wpc_etiqueta_at date,
  add column if not exists wpc_enviada_at date,
  add column if not exists debito_at date,
  add column if not exists debito_resuelto_at date,
  add column if not exists partes_destruidas_at date,
  add column if not exists pra_check jsonb not null default '{}'::jsonb;

comment on column public.expedientes.orden_cierre is 'Fecha de cierre de la orden de garantía: arranca los plazos de 15 días (digitalizar) y 60 días (cobrar en GWM)';
comment on column public.expedientes.pra_check is 'Respuestas del checklist ¿lleva PRA? (manual GM): pintura, TOT, tiempo adicional, canal, NAR tren motriz, No GM, alto voltaje, etc.';

-- BAC de la agencia: los tickets de batería deben traer el BAC de la agencia que reclama
alter table public.agencies add column if not exists bac text;
