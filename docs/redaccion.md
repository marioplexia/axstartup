# Redacción de datos personales

Código en `src/redact/`. Regla: **nada de texto libre llega al modelo ni se guarda como texto sin pasar por `redact`**.
Mejor esfuerzo: ante la duda sobre-redacta. No sustituye la revisión humana con `pnpm redact:report` antes de usar datos reales.

## Qué se quita

| Etiqueta | Cubre |
|---|---|
| `[TEL]` | 10 dígitos con lada (espacios, guiones, puntos, paréntesis), `+52`, `+52 1`, `044/045/01`; 7-8 dígitos **sin lada** solo si hay palabra de contexto (`tel`, `cel`, `whatsapp`, `llamar al`…) |
| `[EMAIL]` | correos, y ofuscados (`x (at) y.com`, `x arroba y punto com`) |
| `[RFC]` `[CURP]` | persona física y moral; con o sin guiones/espacios, en mayúsculas o minúsculas |
| `[CLAVE_ELECTOR]` | clave de elector (18) y CIC/OCR si va precedido de `INE`, `credencial`, `CIC`, `OCR`… |
| `[PLACA]` | formatos `ABC-123-D`, `ABC-12-34`, `123-ABC`, `A12-BCD`, `ABC 123 D`, y cualquier valor tras la palabra `placa(s)` |
| `[DOMICILIO]` `[CP]` | calle/avenida/blvd/calzada/privada… + nombre + número + interior; colonia/fracc./barrio; código postal con `CP`/`C.P.`/`código postal` |
| `[NOMBRE]` | nombre tras un disparador (`cliente`, `Sr.`, `Lic.`, `a nombre de`, `Atte.`, `Saludos,`, `asesor`, `técnico`…), nombres conocidos (`customer_names`, autor del comentario) y **campos de cliente completos** (`customer_*`, `cliente_*`, `nombre`, `propietario`, `titular`…) |
| `[VIN …ABC123]` | VIN completo en texto libre (ver abajo) |

Se conserva: códigos de operación/pieza (`OP-MT-031`, `PZ-MT-6120`), DTC, importes, kilometraje, folios, ciudades y municipios.

## Decisión sobre el VIN

- **Almacenamiento privado** (Postgres con RLS: `orders.vin`, `prea_versions.fields`, `verifications.draft`): se **conserva completo**. Lo necesita el checklist de duplicados y el backtest, y no sale de la base.
- **Hacia el modelo** y **en texto libre guardado** (comentarios, texto de PREA, evidencia extraída): solo los **últimos 6 caracteres** y un **hash HMAC** corto (`vin_hash`, con `PII_SALT`). En campos: `{ vin: "…123456", vin_hash: "a1b2c3d4e5f6" }`; en texto: `[VIN …123456]`.
- Seis caracteres no identifican un vehículo por sí solos; el hash permite correlacionar casos entre sí sin revelar el VIN.
- **Pendiente de tu decisión**: cambiar `PII_SALT` en producción (si se cambia, los hashes ya emitidos dejan de coincidir).

## Bloqueo del modo live

`LLM_MODE=live` solo acepta payloads creados con `sealForModel(payload)`:
1. hace una segunda pasada de detección sobre todas las cadenas (también detecta un VIN completo);
2. si queda algo, lanza `RedactionRequiredError` indicando **la ruta** (`$.fields.x`) y la etiqueta, **nunca el texto**;
3. devuelve una copia congelada y registrada; `LiveClient.run` lanza el mismo error si el payload no está sellado.

El agente simulado no lo exige, pero los llamadores (verificación, corte nocturno, eval) sellan siempre, así que las pruebas ejercitan la ruta live.

## Límites conocidos

- Nombres sin disparador ("Hablé con Lucía") solo se detectan si el nombre se pasa en `customer_names`/`--names`.
- Números escritos con palabras ("cuatro cuatro tres…") no se detectan.
- Domicilios sin palabra clave (solo "Hidalgo 123") no se detectan.

## Revisión a mano

```bash
pnpm redact:report comentarios.txt                       # una línea = un comentario
pnpm redact:report orden.json --names "Ana Ruiz,Luis Soto" --out reports/redact.md
```

Muestra, por línea o ruta JSON, cada hallazgo (`TEL: "443 123 4567" → [TEL]`), el texto resultante y una segunda pasada que marca residuos (el comando sale con código 1 si hay). **El reporte contiene los datos originales**: `reports/` está en `.gitignore`; no lo compartas.
