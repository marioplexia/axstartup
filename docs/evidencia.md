# Evidencia por metadatos (sin OCR)

`src/evidence/metadata.ts` + catálogo editable `taxonomy/evidence-kinds.yaml`.

El asesor **etiqueta cada archivo** con un tipo del catálogo (`foto_tablero`, `diagnostico_escaner`, `orden_firmada`, `factura`, `video_falla`…). El lector valida, sin leer el contenido:

- la etiqueta existe en el catálogo;
- la extensión corresponde al tipo (una `foto_tablero` no puede ser `.pdf`), y el `mime` declarado coincide con la extensión;
- el archivo no está vacío ni excede `max_size_mb`;
- el mismo archivo (`sha256`) no se cuenta como dos evidencias distintas.

Un archivo inválido **no cuenta como presente**: la regla `required_evidence` queda pendiente y el hallazgo dice por qué. Las etiquetas específicas cubren a los tipos genéricos que ya exigen las reglas (`foto_tablero` → `foto`, `diagnostico_escaner` → `diagnostico`, `orden_firmada` → `orden_reparacion`) mediante `satisfies`.

`POST /prea/verify` ya no llama al modelo por defecto (`reading.source = "metadata"`, sin filas en `llm_calls`). Campos de evidencia aceptados: `kind`, `filename`, `mime`, `size_bytes`, `sha256`. `read_text: true` conserva el agente anterior que lee texto ya extraído, solo mientras llega la fase de lectura de imagen/PDF con el modelo (pendiente, aparte).
