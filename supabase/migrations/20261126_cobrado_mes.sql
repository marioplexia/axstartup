-- Lo RECUPERADO es lo que ya se cobró en el periodo: un cobro por orden.
-- Fuentes, en orden: cartera pagada, la revisión de Pago (transacción de planta) y lo aprendido del servicio.
create or replace function public.cobrado_mes(p_desde date default null, p_hasta date default null)
returns table(agency_id integer, cobrado numeric, ordenes integer, prea numeric, campana numeric, servicio numeric)
language sql stable set search_path to '' as $function$
  with c as (
    select p.agency_id, e.tipo,
      coalesce(
        case when ca.estado = 'pagada' and ca.monto_pagado > 0 then ca.monto_pagado end,
        case when coalesce(e.pago->'planta'->>'estado','') !~* 'rechaz' then nullif(e.pago->'planta'->>'total','')::numeric end,
        s.pagado_planta) monto,
      coalesce(
        case when ca.estado = 'pagada' and ca.monto_pagado > 0 then ca.pagada_at::date end,
        nullif(e.pago->'planta'->>'fecha','')::date,
        s.pago_fecha,
        case when e.pago->'planta'->>'total' is not null then nullif(e.pago->>'at','')::timestamptz::date end) fecha
    from public.expedientes e
    join public.profiles p on p.id = e.user_id
    left join public.cartera ca on ca.expediente_id = e.id
    left join public.servicios_aprendidos s on s.expediente_id = e.id
  )
  select agency_id, round(sum(monto), 2), count(*)::int,
    round(coalesce(sum(monto) filter (where tipo not in ('Campaña','Servicio')), 0), 2),
    round(coalesce(sum(monto) filter (where tipo = 'Campaña'), 0), 2),
    round(coalesce(sum(monto) filter (where tipo = 'Servicio'), 0), 2)
  from c
  where monto > 0 and fecha is not null
    and (p_desde is null or fecha >= p_desde) and (p_hasta is null or fecha < p_hasta)
  group by agency_id
$function$;
grant execute on function public.cobrado_mes(date, date) to authenticated;
revoke all on function public.cobrado_mes(date, date) from anon;
