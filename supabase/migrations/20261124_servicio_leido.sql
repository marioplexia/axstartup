-- Lo que el cerebro leyó de la evidencia de un servicio (archivo, qué era y qué llenó)
alter table public.expedientes add column if not exists servicio_leido jsonb;
