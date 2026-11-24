-- La etapa de la PREA en el pipeline de Expedientes la calcula Ax AI con lo que ya pasó, pero el asesor la puede mover a mano.
alter table public.expedientes add column if not exists prea_etapa text;
alter table public.expedientes add column if not exists prea_etapa_at timestamptz;
alter table public.expedientes drop constraint if exists expedientes_prea_etapa_check;
alter table public.expedientes add constraint expedientes_prea_etapa_check check (prea_etapa is null or prea_etapa in ('subir','proceso','aceptada','espera','cambio','facturada','cobrada'));
