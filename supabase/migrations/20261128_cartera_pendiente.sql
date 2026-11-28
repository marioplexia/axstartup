-- La cartera: lo FACTURADO que planta todavía no paga, con el comentario (actualización) de cada orden para el grupo.
-- Aplicada en el proyecto con este contenido.
alter table public.expedientes
  add column if not exists cartera_nota text,
  add column if not exists cartera_nota_at timestamptz,
  add column if not exists cartera_nota_por text;
-- cartera_pendiente(): facturado (factura_monto) sin cobro de planta (cartera pagada, transacción no rechazada o pago del servicio).
-- comentar_cartera(p_id, p_texto): el asesor de la orden o alguien de su agencia escribe el comentario; dueño y director solo lo ven.
-- Ver definiciones vigentes con pg_get_functiondef.
