alter table public.expedientes add column if not exists estatus_nota text, add column if not exists estatus_at timestamptz;
comment on column public.expedientes.estatus_nota is 'Estatus que escribe el asesor a mano (p. ej. «Esperando motor»), sin armar formulario';
