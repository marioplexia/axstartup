-- Una campaña no es una PREA: su ciclo es orden firmada con la campaña + boletín/IVH, factura y cobro
create or replace function public.flujo_campana(e public.expedientes) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare c public.cartera; ord boolean; bol boolean; fa boolean; pa boolean; et text; n int; sig text;
begin
  select * into c from public.cartera where expediente_id = e.id;
  select exists (select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = e.id::text and split_part(o.name, '/', 2) = 'contrato') into ord;
  select exists (select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = e.id::text and split_part(o.name, '/', 2) in ('campana', 'actualizacion')) into bol;
  select exists (select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = e.id::text and split_part(o.name, '/', 2) = 'factura')
      or c.facturada_at is not null or c.estado in ('facturada', 'pagada') into fa;
  select exists (select 1 from storage.objects o where o.bucket_id = 'expedientes-docs' and split_part(o.name, '/', 1) = e.id::text and split_part(o.name, '/', 2) = 'planta')
      or c.pagada_at is not null or c.estado = 'pagada' or e.gwm_cobrada_at is not null into pa;
  if pa and ord and bol then et := 'cerrado'; n := 4; sig := 'Campaña cobrada. No hay nada pendiente.';
  elsif fa or pa then et := 'cobro'; n := 3;
    sig := case when not ord then 'Subir la orden de reparación firmada con la campaña'
                when not bol then 'Subir el boletín de la campaña o la consulta del VIN (IVH)'
                else 'Cobrar la campaña y subir la transacción de planta' end;
  elsif ord and bol then et := 'factura'; n := 2; sig := 'Facturar la campaña a planta y subir la factura';
  else et := 'campana'; n := 1;
    sig := case when not ord and not bol then 'Aplicar la campaña y subir la orden firmada con el boletín o IVH'
                when not ord then 'Subir la orden de reparación firmada con la campaña'
                else 'Subir el boletín de la campaña o la consulta del VIN (IVH)' end;
  end if;
  return jsonb_build_object('etapa', et, 'n', n, 'siguiente', sig, 'responsable', case when et = 'cerrado' then 'Nadie' else 'Asesor' end,
    'vence', null, 'estado', 'ok', 'tambien', '[]'::jsonb, 'secciones', null, 'tipo', 'Campaña', 'calculado_at', now());
end $$;
revoke all on function public.flujo_campana(public.expedientes) from public, anon, authenticated;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.flujo_calc'::regproc);
  if position('flujo_campana' in d) = 0 then
    d := replace(d, 'if e.tipo = ''Servicio'' then return public.flujo_servicio(e); end if;',
                    'if e.tipo = ''Servicio'' then return public.flujo_servicio(e); end if;' || chr(10) || '  if e.tipo = ''Campaña'' then return public.flujo_campana(e); end if;');
    execute d;
  end if;
end $$;
select public.flujo_aplicar(id) from public.expedientes where tipo = 'Campaña';
