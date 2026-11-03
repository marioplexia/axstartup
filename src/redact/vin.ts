import { createHmac } from 'node:crypto';

/**
 * DECISIÓN SOBRE EL VIN
 * - Almacenamiento privado (Postgres con RLS: orders.vin, prea_versions.fields, verifications.draft): se conserva completo.
 *   Lo necesitan el checklist de duplicados y el backtest, y no sale de la base.
 * - Hacia el modelo (cualquier payload sellado con sealForModel) y en textos libres guardados (comentarios, texto de PREA,
 *   evidencia extraída): solo van los ÚLTIMOS 6 caracteres y un hash HMAC corto. 6 caracteres no identifican un vehículo
 *   por sí solos, y el hash permite correlacionar casos sin revelar el VIN.
 */
export const VIN_RE = /(?<![A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])/gi;

export const looksLikeVin = (s: string) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s);
export const vinLast6 = (vin: string) => vin.trim().toUpperCase().slice(-6);
export function vinHash(vin: string, salt = process.env.PII_SALT ?? 'dev-salt'): string {
  return createHmac('sha256', salt).update(vin.trim().toUpperCase()).digest('hex').slice(0, 12);
}
/** Token que reemplaza al VIN en texto libre. */
export const vinToken = (vin: string) => `[VIN …${vinLast6(vin)}]`;
/** Vista del VIN para el modelo en campos estructurados. */
export const vinForModel = (vin: string) => ({ vin: `…${vinLast6(vin)}`, vin_hash: vinHash(vin) });
