-- Servicios y campañas también tienen expediente desde que se abren (aunque empiece en blanco).
-- No llevan PREA: el ciclo se salta la preautorización y va directo a armar el expediente.
alter table public.expedientes add column if not exists tipo text not null default 'PREA';
alter table public.expedientes drop constraint if exists expedientes_tipo_check;
alter table public.expedientes add constraint expedientes_tipo_check check (tipo in ('PREA','Servicio','Campaña'));

-- la conversación que se crea sola dice de qué tipo es la orden
create or replace function public.expediente_conversacion() returns trigger
language plpgsql security definer set search_path to '' as $$
declare cid uuid;
begin
  if new.conversation_id is null and nullif(btrim(new.wo), '') is not null then
    select id into cid from public.conversations where user_id = new.user_id and agent = 'garantias' and orden = new.wo limit 1;
    if cid is null then
      insert into public.conversations(user_id, agent, title, text, orden)
      values (new.user_id, 'garantias', new.wo, 'Orden ' || new.wo || ' (' || coalesce(new.tipo, 'PREA') || ')', new.wo)
      returning id into cid;
    end if;
    new.conversation_id := cid;
  end if;
  return new;
end $$;

-- el cerebro aprende de PREAs; un servicio o campaña en blanco no es un caso para aprender
create or replace function public.expediente_creada() returns trigger
language plpgsql security definer set search_path to '' as $$
declare ag int;
begin
  if coalesce(new.tipo, 'PREA') <> 'PREA' then return new; end if;
  select agency_id into ag from public.profiles where id = new.user_id;
  insert into public.aprendizaje_eventos(expediente_id, agency_id, tipo) values (new.id, ag, 'creada')
  on conflict (expediente_id, tipo) where expediente_id is not null do nothing;
  return new;
end $$;

-- el ciclo: sin PREA no hay etapa de preautorización
create or replace function public.flujo_calc(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare e public.expedientes; c public.cartera; secs int; faltan text[]; et text; sig text; resp text; vence date; tam jsonb := '[]'::jsonb; n int;
  req text[] := array['contrato','recepcion','diagnostico','evidencia','piezas'];
  nom jsonb := '{"contrato":"orden de garantía firmada","recepcion":"recepción","diagnostico":"diagnóstico","evidencia":"evidencia","piezas":"refacciones"}';
  est text; cierre date; prea boolean;
begin
  select * into e from public.expedientes where id = p_id; if not found then return null; end if;
  select * into c from public.cartera where expediente_id = p_id;
  prea := coalesce(e.tipo, 'PREA') = 'PREA';
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
  elsif prea and e.status = 'rechazada' and e.pra_corregida_at is null then
    et := 'prea'; n := 2; sig := 'Corregir la PREA con lo que pidió planta y reenviarla'; resp := 'Asesor';
    vence := public.dias_habiles(coalesce(e.pra_rechazada_at, e.updated_at, now()), 3);
  elsif prea and (e.status in ('borrador') or (e.status = 'rechazada' and e.pra_corregida_at is not null)) then
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
    'tambien', tam, 'secciones', secs, 'tipo', coalesce(e.tipo, 'PREA'), 'calculado_at', now());
end $$;
revoke all on function public.flujo_calc(uuid) from public, anon, authenticated;
