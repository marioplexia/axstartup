-- El cerebro de los servicios: cuánto se cobra cada tipo de servicio (p. ej. «Servicio 6,000 km», el primero del auto)
-- en las agencias de la misma marca. Del grupo se ve el detalle por agencia; de la red solo totales sin nombres
-- (los datos de cada grupo no se comparten, solo el aprendizaje).
-- En un servicio: sys = tipo de servicio, vehicle = modelo, km = kilometraje, labor = monto cobrado antes de IVA.

-- la misma llave para «Servicio 6,000 km», «servicio de 6000 km» o «6 mil km»
create or replace function public.servicio_clave(t text) returns text
language sql immutable set search_path to '' as $$
  select case when t is null or btrim(t) = '' then null
    when t ~ '\d' then 'km:' || (case when t ~* '\d\s*mil\y' then (regexp_replace(substring(t from '(\d+)\s*mil'), '[^0-9]', '', 'g')::int * 1000)::text
                                    else regexp_replace(substring(t from '\d[\d,\.]*'), '[^0-9]', '', 'g') end)
    else lower(btrim(regexp_replace(t, '\s+', ' ', 'g'))) end
$$;

create or replace function public.servicios_referencia(p_tipo text, p_marca text default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare k text := public.servicio_clave(p_tipo); g int := public.my_grupo(); m text; r jsonb;
begin
  if (select auth.uid()) is null then raise exception 'sin_sesion'; end if;
  if k is null then return null; end if;
  m := coalesce(nullif(btrim(p_marca), ''), (select coalesce(a.marca_grupo, a.brand) from public.profiles p join public.agencies a on a.id = p.agency_id where p.id = (select auth.uid())));
  with base as (
    select coalesce(e.labor, 0) + coalesce(e.parts_total, 0) monto, a.id ag, a.name agname, a.grupo_id, e.created_at
    from public.expedientes e join public.profiles p on p.id = e.user_id join public.agencies a on a.id = p.agency_id
    where e.tipo = 'Servicio' and public.servicio_clave(e.sys) = k and coalesce(e.labor, 0) + coalesce(e.parts_total, 0) > 0
      and (m is null or lower(coalesce(a.marca_grupo, a.brand, '')) = lower(m))
  )
  select jsonb_build_object('clave', k, 'tipo', p_tipo, 'marca', m,
    'grupo', (select jsonb_build_object('n', count(*), 'mediana', round((percentile_cont(0.5) within group (order by monto))::numeric, 2), 'min', min(monto), 'max', max(monto),
                'por_agencia', coalesce((select jsonb_agg(x order by x->>'agencia') from (
                  select jsonb_build_object('agencia', agname, 'n', count(*), 'mediana', round((percentile_cont(0.5) within group (order by monto))::numeric, 2), 'ultimo', max(created_at)::date) x
                  from base where grupo_id = g group by agname) s), '[]'::jsonb))
              from base where grupo_id = g),
    'red', (select jsonb_build_object('n', count(*), 'agencias', count(distinct ag), 'mediana', round((percentile_cont(0.5) within group (order by monto))::numeric, 2), 'min', min(monto), 'max', max(monto))
            from base where grupo_id is distinct from g))
  into r;
  return r;
end $$;
revoke all on function public.servicios_referencia(text, text) from public, anon;
grant execute on function public.servicios_referencia(text, text) to authenticated;
