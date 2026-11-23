-- ══ 5. Alertas de reglas ══════════════════════════════════════════════════════════════
-- Los agentes escuchan lo que pasa (débitos, rechazos de planta, boletines y cambios de política de GM)
-- y avisan al instante: a las agencias del grupo (con el nombre de la agencia y el monto) y a toda la red
-- (solo el aprendizaje: la regla, sin datos de la agencia). También avisan a cada asesor de su flujo.
create table if not exists public.alertas (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tipo text not null check (tipo in ('debito','rechazo','boletin','politica','regla','plazo','etapa')),
  alcance text not null check (alcance in ('red','marca','grupo','agencia','usuario')),
  brand text,
  grupo_id int references public.grupos(id) on delete cascade,
  agency_id int references public.agencies(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  origen_agency_id int references public.agencies(id) on delete set null,
  titulo text not null,
  cuerpo text,
  accion text,
  regla_id text,
  seccion text,
  sys text,
  expediente_id uuid references public.expedientes(id) on delete cascade,
  urgente boolean not null default false,
  clave text unique,
  datos jsonb not null default '{}'::jsonb
);
create index if not exists alertas_created_idx on public.alertas (created_at desc);
create index if not exists alertas_user_idx on public.alertas (user_id) where user_id is not null;
create index if not exists alertas_grupo_idx on public.alertas (grupo_id) where grupo_id is not null;
alter table public.alertas enable row level security;
drop policy if exists "alertas read" on public.alertas;
create policy "alertas read" on public.alertas for select to authenticated using (
  alcance in ('red','marca')
  or (alcance = 'grupo' and grupo_id = (select public.my_grupo()))
  or (alcance = 'agencia' and agency_id = (select public.my_agency()))
  or (alcance = 'usuario' and user_id = (select auth.uid()))
);
-- sin políticas de escritura: solo las escriben los agentes (disparadores y funciones del servidor)

create table if not exists public.alertas_leidas (
  alerta_id uuid not null references public.alertas(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  leida_at timestamptz not null default now(),
  primary key (alerta_id, user_id)
);
alter table public.alertas_leidas enable row level security;
drop policy if exists "leidas own" on public.alertas_leidas;
create policy "leidas own" on public.alertas_leidas for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- un débito nuevo: aviso al grupo (o a la agencia si no tiene grupo) y, si nació una regla, a toda la red
create or replace function public.alerta_debito() returns trigger
language plpgsql security definer set search_path to '' as $$
declare a record; r record; s text;
begin
  select id, name, grupo_id, brand into a from public.agencies where id = new.agency_id;
  select id, tema, regla, como_verificar, consecuencia into r from public.manual_reglas where id = new.regla_id;
  if new.expediente_id is not null then select sys into s from public.expedientes where id = new.expediente_id; end if;
  insert into public.alertas (tipo, alcance, grupo_id, agency_id, origen_agency_id, brand, titulo, cuerpo, accion, regla_id, seccion, sys, urgente, clave, datos)
  values ('debito', case when a.grupo_id is not null then 'grupo' else 'agencia' end, a.grupo_id,
    case when a.grupo_id is null then a.id end, a.id, a.brand,
    'Débito de GM en ' || coalesce(a.name, 'una agencia') || ': ' || coalesce(r.tema, 'causa nueva'),
    'GM debitó $' || to_char(coalesce(new.monto, 0), 'FM999,999,990') || coalesce(' por: ' || left(new.motivo, 300), '') ||
      '. Desde este momento la regla ' || coalesce(r.id, new.regla_id) || ' revisa los expedientes de todas las agencias.',
    coalesce(r.como_verificar, r.regla), new.regla_id, new.seccion, s, true, 'debito:' || new.id,
    jsonb_build_object('monto', new.monto, 'regla', r.regla, 'consecuencia', r.consecuencia));
  if new.regla_nueva then
    insert into public.alertas (tipo, alcance, brand, titulo, cuerpo, accion, regla_id, seccion, sys, clave)
    values ('regla', 'red', a.brand, 'Regla nueva aprendida de un débito real: ' || coalesce(r.tema, new.regla_id),
      r.regla, r.como_verificar, new.regla_id, new.seccion, s, 'regla:' || new.regla_id)
    on conflict (clave) do nothing;
  end if;
  return new;
exception when others then
  raise warning 'alerta_debito: %', sqlerrm; return new;
end $$;
drop trigger if exists trg_alerta_debito on public.debitos;
create trigger trg_alerta_debito after insert on public.debitos for each row execute function public.alerta_debito();

-- planta rechazó una PREA: aviso al grupo para que nadie mande lo mismo
create or replace function public.alerta_rechazo() returns trigger
language plpgsql security definer set search_path to '' as $$
declare a record;
begin
  if new.status = 'rechazada' and old.status is distinct from 'rechazada' then
    select ag.id, ag.name, ag.grupo_id, ag.brand into a from public.profiles p join public.agencies ag on ag.id = p.agency_id where p.id = new.user_id;
    insert into public.alertas (tipo, alcance, grupo_id, agency_id, origen_agency_id, brand, titulo, cuerpo, accion, sys, expediente_id, clave, datos)
    values ('rechazo', case when a.grupo_id is not null then 'grupo' else 'agencia' end, a.grupo_id,
      case when a.grupo_id is null then a.id end, a.id, coalesce(a.brand, new.brand),
      'Planta rechazó una PREA de ' || lower(coalesce(new.sys, 'garantía')) || coalesce(' en ' || a.name, ''),
      coalesce('Lo que dijo planta: ' || left(nullif(new.comentario_fabricante, ''), 400), 'Planta la rechazó sin comentario.') ||
        coalesce(' Operación ' || new.op || coalesce(' (' || new.opd || ')', '') || '.', ''),
      'Antes de mandar una PREA de ' || lower(coalesce(new.sys, 'este sistema')) || ', revisa que no tenga lo mismo.',
      new.sys, new.id, 'rechazo:' || new.id || ':' || to_char(now(), 'YYYYMMDDHH24MI'),
      jsonb_build_object('op', new.op, 'opd', new.opd));
  end if;
  return new;
exception when others then
  raise warning 'alerta_rechazo: %', sqlerrm; return new;
end $$;
drop trigger if exists trg_alerta_rechazo on public.expedientes;
create trigger trg_alerta_rechazo after update of status on public.expedientes for each row execute function public.alerta_rechazo();

-- ══ 6. El ciclo de la garantía como flujo ═══════════════════════════════════════════════
-- Etapas: orden → prea → expediente → transaccion → factura → cobro → cerrado (y débito encima si llega uno).
-- El agente calcula la etapa con lo que ya pasó (fechas, estado de planta, secciones subidas, cartera),
-- la guarda en expedientes.flujo con su historia, dice cuál es el siguiente paso, de quién es y cuándo vence,
-- y avisa al asesor cuando el caso avanza o un plazo del manual está por vencer.
alter table public.expedientes add column if not exists flujo jsonb;
comment on column public.expedientes.flujo is 'Ciclo de la garantía: {etapa, n, siguiente, responsable, vence, estado, tambien[], historia[]}';

create or replace function public.dias_habiles(p_desde timestamptz, p_n int) returns date
language plpgsql immutable set search_path to '' as $$
declare d date := p_desde::date; k int := 0;
begin
  while k < p_n loop d := d + 1; if extract(isodow from d) < 6 then k := k + 1; end if; end loop;
  return d;
end $$;

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
  elsif secs < array_length(req, 1) then
    et := 'expediente'; n := 3;
    sig := 'Completar el expediente: falta ' || (select string_agg(nom->>x, ', ') from unnest(faltan) x); resp := 'Asesor'; vence := cierre + 15;
  else
    et := 'transaccion'; n := 4; sig := 'Procesar la transacción en GWM'; resp := 'Asesor'; vence := cierre + 30;
  end if;
  -- lo que corre en paralelo
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

-- aplica el cálculo: guarda la etapa, su historia y avisa al asesor si avanzó o si un plazo está por vencer
create or replace function public.flujo_aplicar(p_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare e record; f jsonb; old jsonb; hist jsonb; et text; v_ord text;
  nombres jsonb := '{"orden":"Orden abierta","prea":"Preautorización","expediente":"Expediente","transaccion":"Transacción en GWM","factura":"Factura a planta","cobro":"Cobro","cerrado":"Cerrada"}';
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
  -- la primera vez solo se calcula (sin avisos viejos); los plazos de hace más de 30 días ya no se anuncian
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

create or replace function public.flujo_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if tg_table_name = 'cartera' then perform public.flujo_aplicar(new.expediente_id); else perform public.flujo_aplicar(new.id); end if;
  return new;
exception when others then raise warning 'flujo_trg: %', sqlerrm; return new;
end $$;
drop trigger if exists trg_flujo_exp on public.expedientes;
create trigger trg_flujo_exp after insert or update of status, orden_apertura, orden_cierre, transaccion_aceptada_at, gwm_cobrada_at,
  pra_rechazada_at, pra_corregida_at, debito_at, debito_resuelto_at, partes_destruidas_at, wpc_etiqueta_at, wpc_enviada_at, armado, prea_form
  on public.expedientes for each row execute function public.flujo_trg();
drop trigger if exists trg_flujo_cartera on public.cartera;
create trigger trg_flujo_cartera after insert or update on public.cartera for each row execute function public.flujo_trg();

-- la app lo pide después de subir documentos (las secciones viven en Storage)
create or replace function public.flujo_refrescar(p_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  if not exists (select 1 from public.expedientes e where e.id = p_id and (e.user_id = (select auth.uid()) or public.can_ver(e.user_id))) then
    raise exception 'expediente_no_disponible';
  end if;
  return public.flujo_aplicar(p_id);
end $$;
revoke all on function public.flujo_refrescar(uuid) from public, anon;
grant execute on function public.flujo_refrescar(uuid) to authenticated;
revoke all on function public.flujo_aplicar(uuid) from public, anon, authenticated;
revoke all on function public.flujo_calc(uuid) from public, anon, authenticated;

-- el agente revisa todos los casos abiertos cada hora: avanza etapas y avisa plazos
create or replace function public.flujo_barrido() returns int
language plpgsql security definer set search_path to '' as $$
declare r record; k int := 0;
begin
  for r in select id from public.expedientes where coalesce(flujo->>'etapa', '') <> 'cerrado' order by updated_at desc nulls last limit 3000 loop
    begin perform public.flujo_aplicar(r.id); k := k + 1; exception when others then raise warning 'flujo %: %', r.id, sqlerrm; end;
  end loop;
  return k;
end $$;
revoke all on function public.flujo_barrido() from public, anon, authenticated;
select cron.schedule('flujo-garantias', '17 * * * *', 'select public.flujo_barrido()');

-- en vivo para la campana
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'alertas') then
    alter publication supabase_realtime add table public.alertas;
  end if;
end $$;
