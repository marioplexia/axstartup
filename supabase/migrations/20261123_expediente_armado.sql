-- El agente arma el expediente: el resultado del último armado (qué se clasificó, qué falta y qué no cuadra)
-- se guarda en el expediente para mostrarlo en Inicio, en el chat de la orden y en la carátula del PDF de auditoría.
alter table public.expedientes add column if not exists armado jsonb;
comment on column public.expedientes.armado is 'Último armado automático: {at, archivos, documentos[{seccion,paginas,archivo,descripcion}], faltantes[], discrepancias[], revision{cumple,no_cumple}}';
