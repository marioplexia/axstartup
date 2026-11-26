alter table public.expedientes add column if not exists pago jsonb;
comment on column public.expedientes.pago is 'Cuadre de cobranza: lo leído de la factura y de la transacción de planta y si cuadran (función pago)';
