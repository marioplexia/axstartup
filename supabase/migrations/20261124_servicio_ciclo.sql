-- El ciclo de un SERVICIO es corto y no lleva PREA: se abre la orden, se hace el servicio (se sube la evidencia),
-- se factura y se cobra. Dura un día. Las etapas salen de lo que hay subido en el expediente:
-- evidencia (cualquier documento que no sea factura ni pago) → factura → comprobante de pago (o cartera pagada).
create or replace function public.flujo_servicio(e public.expedientes) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare c public.cartera; ev boolean; fa boolean; pa boolean; et text; n int; sig text; vence date; est text;
begin
  select * into c from public.cartera where expediente_id = e.id;
  select exists (select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = e.id::text
                   and split_part(o.name, '/', 2) not in ('', 'factura', 'planta') and o.name like '%/%/%') into ev;
  select exists (select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = e.id::text and split_part(o.name, '/', 2) = 'factura')
      or c.facturada_at is not null or c.estado in ('facturada', 'pagada') into fa;
  select exists (select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = e.id::text and split_part(o.name, '/', 2) = 'planta')
      or c.pagada_at is not null or c.estado = 'pagada' or e.gwm_cobrada_at is not null into pa;
  vence := e.created_at::date + 1;
  if pa then et := 'cerrado'; n := 4; sig := 'Servicio cobrado. No hay nada pendiente.'; vence := null;
  elsif fa then et := 'cobro'; n := 3; sig := 'Cobrar el servicio y subir el comprobante de pago';
  elsif ev then et := 'factura'; n := 2; sig := 'Facturar el servicio y subir la factura';
  else et := 'servicio'; n := 1; sig := 'Hacer el servicio y subir la evidencia';
  end if;
  est := case when vence is null then 'ok' when vence < current_date then 'bad' when vence <= current_date then 'warn' else 'ok' end;
  return jsonb_build_object('etapa', et, 'n', n, 'siguiente', sig, 'responsable', case when pa then 'Nadie' else 'Asesor' end, 'vence', vence,
    'estado', est, 'tambien', '[]'::jsonb, 'secciones', null, 'tipo', 'Servicio', 'calculado_at', now());
end $$;
revoke all on function public.flujo_servicio(public.expedientes) from public, anon, authenticated;

create or replace function public.flujo_calc(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare e public.expedientes; c public.cartera; secs int; faltan text[]; et text; sig text; resp text; vence date; tam jsonb := '[]'::jsonb; n int;
  req text[] := array['contrato','recepcion','diagnostico','evidencia','piezas'];
  nom jsonb := '{"contrato":"orden de garantía firmada","recepcion":"recepción","diagnostico":"diagnóstico","evidencia":"evidencia","piezas":"refacciones"}';
  est text; cierre date; prea boolean;
begin
  select * into e from public.expedientes where id = p_id; if not found then return null; end if;
  if e.tipo = 'Servicio' then return public.flujo_servicio(e); end if;
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

-- nombres de etapa en los avisos del flujo (incluye la del servicio)
create or replace function public.flujo_aplicar(p_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare e record; f jsonb; old jsonb; hist jsonb; et text; v_ord text;
  nombres jsonb := '{"orden":"Orden abierta","prea":"Preautorización","expediente":"Expediente","transaccion":"Transacción en GWM","factura":"Factura","cobro":"Cobro","cerrado":"Cerrada","servicio":"Servicio y evidencia"}';
begin
  select x.id, x.user_id, x.folio, x.wo, x.flujo into e from public.expedientes x where x.id = p_id; if not found then return null; end if;
  f := public.flujo_calc(p_id); old := e.flujo; et := f->>'etapa'; v_ord := coalesce(e.wo, e.folio, 'la orden');
  hist := coalesce(old->'historia', '[]'::jsonb);
  if old is null or old->>'etapa' is distinct from et then
    hist := hist || jsonb_build_object('etapa', et, 'at', now(), 'por', 'agente');
    if old is not null then
      insert into public.alertas (tipo, alcance, user_id, titulo, cuerpo, accion, expediente_id, clave)
      values ('etapa', 'usuario', e.user_id, v_ord || ' avanzó a ' || (nombres->>et),
        'El agente movió el caso de «' || coalesce(nombres->>(old->>'etapa'), 'inicio') || '» a «' || (nombres->>et) || '».',
        f->>'siguiente', p_id, 'etapa:' || p_id || ':' || et || ':' || to_char(now(), 'YYYYMMDD'))
      on conflict (clave) do nothing;
    end if;
  end if;
  if jsonb_array_length(hist) > 30 then hist := (select jsonb_agg(x) from (select x from jsonb_array_elements(hist) x offset jsonb_array_length(hist) - 30) s); end if;
  f := f || jsonb_build_object('historia', hist);
  if old is not null and f->>'estado' in ('warn', 'bad') and et <> 'cerrado' and (f->>'vence' is null or (f->>'vence')::date >= current_date - 30) then
    insert into public.alertas (tipo, alcance, user_id, titulo, cuerpo, accion, expediente_id, urgente, clave)
    values ('plazo', 'usuario', e.user_id,
      v_ord || case when f->>'estado' = 'bad' then ': plazo vencido' else ': el plazo vence pronto' end,
      coalesce('Vence el ' || to_char((f->>'vence')::date, 'DD/MM/YYYY') || '. ', '') || 'Etapa: ' || (nombres->>et) || '.',
      f->>'siguiente', p_id, f->>'estado' = 'bad', 'plazo:' || p_id || ':' || et || ':' || (f->>'estado'))
    on conflict (clave) do nothing;
  end if;
  update public.expedientes set flujo = f where id = p_id;
  return f;
end $$;
revoke all on function public.flujo_aplicar(uuid) from public, anon, authenticated;
