-- El detalle de lo recuperado (ya cobrado), una fila por orden, para el reporte PDF del dueño. Con los permisos de quien llama.
create or replace function public.cobrado_detalle(p_desde date default null, p_hasta date default null)
returns table(agency_id integer, agencia text, marca text, ciudad text, wo text, folio text, tipo text, sistema text, vehiculo text,
              asesor text, fecha date, monto numeric, fuente text, facturado numeric, estado_pago text)
language sql stable set search_path to '' as $function$
  with c as (
    select p.agency_id, a.name agencia, coalesce(a.marca_grupo, a.brand) marca, a.city ciudad, e.wo, e.folio, e.tipo, e.sys sistema, e.vehicle vehiculo, p.name asesor,
      case when ca.estado = 'pagada' and ca.monto_pagado > 0 then ca.monto_pagado
           when coalesce(e.pago->'planta'->>'estado','') !~* 'rechaz' and nullif(e.pago->'planta'->>'total','') is not null then (e.pago->'planta'->>'total')::numeric
           else s.pagado_planta end monto,
      case when ca.estado = 'pagada' and ca.monto_pagado > 0 then 'Cartera pagada'
           when coalesce(e.pago->'planta'->>'estado','') !~* 'rechaz' and nullif(e.pago->'planta'->>'total','') is not null then 'Transacción de planta'
           when s.pagado_planta is not null then 'Pago del servicio' end fuente,
      coalesce(
        case when ca.estado = 'pagada' and ca.monto_pagado > 0 then ca.pagada_at::date end,
        nullif(e.pago->'planta'->>'fecha','')::date,
        s.pago_fecha,
        case when e.pago->'planta'->>'total' is not null then nullif(e.pago->>'at','')::timestamptz::date end) fecha,
      coalesce(nullif(e.pago->'factura'->>'total','')::numeric, s.total_facturado) facturado,
      e.pago->>'estado' estado_pago
    from public.expedientes e
    join public.profiles p on p.id = e.user_id
    left join public.agencies a on a.id = p.agency_id
    left join public.cartera ca on ca.expediente_id = e.id
    left join public.servicios_aprendidos s on s.expediente_id = e.id
  )
  select agency_id, agencia, marca, ciudad, wo, folio, tipo, sistema, vehiculo, asesor, fecha, round(monto, 2), fuente, round(facturado, 2), estado_pago
  from c
  where monto > 0 and fecha is not null
    and (p_desde is null or fecha >= p_desde) and (p_hasta is null or fecha < p_hasta)
  order by marca, agencia, fecha, wo
$function$;
grant execute on function public.cobrado_detalle(date, date) to authenticated;
revoke all on function public.cobrado_detalle(date, date) from anon;
