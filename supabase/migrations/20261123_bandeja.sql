-- ══ Bandeja del asesor ══════════════════════════════════════════════════════════════
-- El asesor no lee conversaciones: decide. Cada decisión (enviar, corregir, pedir al técnico) queda registrada
-- con el riesgo que mostró Ax AI y sus motivos; con los débitos que lleguen después, la red aprende qué tan
-- bien predice el riesgo. "Enviar" marca el caso como enviado y el flujo pasa a esperar a GM.
alter table public.expedientes add column if not exists enviado_at timestamptz;

create table if not exists public.decisiones (
  id uuid primary key default gen_random_uuid(),
  expediente_id uuid not null references public.expedientes(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  decision text not null check (decision in ('enviar','corregir','tecnico')),
  riesgo int check (riesgo between 0 and 100),
  motivos jsonb not null default '[]'::jsonb,
  nota text,
  created_at timestamptz not null default now()
);
create index if not exists decisiones_exp_idx on public.decisiones (expediente_id, created_at desc);
alter table public.decisiones enable row level security;
drop policy if exists "decisiones read" on public.decisiones;
create policy "decisiones read" on public.decisiones for select to authenticated
  using (user_id = (select auth.uid()) or (select public.can_ver(decisiones.user_id)));
drop policy if exists "decisiones insert" on public.decisiones;
create policy "decisiones insert" on public.decisiones for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.expedientes e where e.id = expediente_id
    and (e.user_id = (select auth.uid()) or public.can_ver(e.user_id))));

-- el flujo conoce el envío: enviado y sin respuesta de GWM = esperando a planta
create or replace function public.flujo_calc(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare e public.expedientes; c public.cartera; secs int; faltan text[]; et text; sig text; resp text; vence date; tam jsonb := '[]'::jsonb; n int;
  req text[] := array['contrato','recepcion','diagnostico','evidencia','piezas'];
  nom jsonb := '{"contrato":"orden de garantía firmada","recepcion":"recepción","diagnostico":"diagnóstico","evidencia":"evidencia","piezas":"refacciones"}';
  est text; cierre date;
begin
  select * into e from public.expedientes where id = p_id; if not found then return null; end if;
  select * into c from public.cartera where expediente_id = p_id;
  select array_agg(x) into faltan from unnest(req) x where not exists (
    select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = p_id::text and split_part(o.name, '/', 2) = x);
  secs := coalesce(array_length(req, 1), 0) - coalesce(array_length(faltan, 1), 0);
  cierre := e.orden_cierre;
  if e.gwm_cobrada_at is not null or c.pagada_at is not null or c.estado = 'pagada' then
    et := 'cerrado'; n := 7; sig := 'Garantía cobrada. No hay nada pendiente.'; resp := 'Nadie';
  elsif c.facturada_at is not null or c.estado = 'facturada' then
    et := 'cobro'; n := 6; sig := 'Esperar el pago de planta y conciliarlo en Cartera'; resp := 'Planta'; vence := (coalesce(c.facturada_at, now()))::date + 30;
  elsif e.transaccion_aceptada_at is not null then
    et := 'factura'; n := 5; sig := 'Facturar la transacción a planta y subir la factura'; resp := 'Asesor'; vence := cierre + 30;
  elsif e.status = 'rechazada' and e.pra_corregida_at is null then
    et := 'prea'; n := 2; sig := 'Corregir la PREA con lo que pidió planta y reenviarla'; resp := 'Asesor';
    vence := public.dias_habiles(coalesce(e.pra_rechazada_at, e.updated_at, now()), 3);
  elsif e.status in ('borrador') or (e.status = 'rechazada' and e.pra_corregida_at is not null) then
    et := 'prea'; n := 2; sig := 'Esperar la respuesta de planta a la PREA'; resp := 'Planta';
  elsif e.enviado_at is not null then
    et := 'transaccion'; n := 4; sig := 'Esperar que GM acepte la transacción en GWM'; resp := 'Planta'; vence := cierre + 30;
  elsif secs < array_length(req, 1) then
    et := 'expediente'; n := 3;
    sig := 'Completar el expediente: falta ' || (select string_agg(nom->>x, ', ') from unnest(faltan) x); resp := 'Asesor'; vence := cierre + 15;
  else
    et := 'transaccion'; n := 4; sig := 'Procesar la transacción en GWM'; resp := 'Asesor'; vence := cierre + 30;
  end if;
  if e.debito_at is not null and e.debito_resuelto_at is null then
    tam := tam || jsonb_build_object('t', 'Atender el débito de GM: pedir la devolución de la parte', 'vence', e.debito_at + 5, 'urgente', true);
  end if;
  if n >= 4 and secs < array_length(req, 1) then
    tam := tam || jsonb_build_object('t', 'Completar el expediente: falta ' || (select string_agg(nom->>x, ', ') from unnest(faltan) x), 'vence', cierre + 15);
  end if;
  if e.wpc_etiqueta_at is not null and e.wpc_enviada_at is null then
    tam := tam || jsonb_build_object('t', 'Enviar la pieza al WPC', 'vence', e.wpc_etiqueta_at + 15);
  end if;
  if n >= 5 and e.partes_destruidas_at is null and jsonb_typeof(e.parts) = 'array' and jsonb_array_length(e.parts) > 0 then
    tam := tam || jsonb_build_object('t', 'Destruir las partes después del resguardo de 15 días y subir las fotos', 'vence', e.transaccion_aceptada_at + 30);
  end if;
  est := case when vence is null then 'ok' when vence < current_date then 'bad' when vence <= current_date + 3 then 'warn' else 'ok' end;
  if exists (select 1 from jsonb_array_elements(tam) t where (t->>'vence')::date < current_date) then est := 'bad'; end if;
  return jsonb_build_object('etapa', et, 'n', n, 'siguiente', sig, 'responsable', resp, 'vence', vence, 'estado', est,
    'tambien', tam, 'secciones', secs, 'calculado_at', now());
end $$;
revoke all on function public.flujo_calc(uuid) from public, anon, authenticated;

drop trigger if exists trg_flujo_exp on public.expedientes;
create trigger trg_flujo_exp after insert or update of status, orden_apertura, orden_cierre, transaccion_aceptada_at, gwm_cobrada_at,
  pra_rechazada_at, pra_corregida_at, debito_at, debito_resuelto_at, partes_destruidas_at, wpc_etiqueta_at, wpc_enviada_at, armado, prea_form, enviado_at
  on public.expedientes for each row execute function public.flujo_trg();
