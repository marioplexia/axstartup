# Función `manual` (Agente de Garantías / Cobros / Prueba)

Desplegada en Supabase (versión 4). El fuente vive allá; este archivo documenta el comportamiento:

- El agente consulta el manual del cerebro **en vivo** en cada pregunta (reglas, lecciones, casos de planta,
  pagos y documentos enseñados desde el tablero de agencia).
- `buscar_todo` revisa todas esas fuentes a la vez; el prompt obliga a usarla antes de decir "no sé".
- `buscar_ejemplos` busca en nombre de archivo, resumen, lecciones y datos leídos (no solo en `busqueda`).

# Función `evidencia` (Agente de Garantías)

Desplegada en Supabase (versión 1). Recibe el caso y TODOS los archivos adjuntos (PDF/imagen), los inspecciona
uno por uno y devuelve `{suficiente, documentos, datos, faltantes, inconsistencias, resumen}`.
Sin archivos válidos responde `sin_evidencia` y la PREA no procede. El chat la llama antes de armar la PREA.

# Función `documento` (documentos del expediente → cerebro)

Desplegada en Supabase (versión 1). Al subir un archivo en la pantalla del expediente (Contrato firmado, Piezas,
Evidencia, Factura, Transacción de planta) el chat lo lee con IA (PDF, imagen, texto o XML) y:
- comprueba que es del tipo esperado (si no, no aprende y avisa);
- Factura → registra número y fecha en `cartera`; Transacción de planta → registra mano de obra y piezas pagadas
  (su disparador `cartera_evento` crea el evento de aprendizaje de pagos);
- guarda lecciones en `reglas_lecciones` (origen `pdf`) y lo leído en `entrenamiento_docs` (kind `expediente`),
  que el agente encuentra con `buscar_todo`.

Bucket de Storage `expedientes-docs` (privado, 20 MB): `<expediente_id>/<tipo>/<archivo>`; las políticas dejan ver,
subir y borrar solo a quien puede ver ese expediente.

# Harness de agentes · paso 1 (ejecuciones, reintentos y reanudación)

- Tabla `agent_runs`: cada corrida de `documento` y `evidencia` guarda sus pasos, intentos, duración y resultado.
  RLS: cada quien ve y reanuda lo suyo; el administrador de la agencia ve lo de su gente.
- Código en `supabase/functions/documento/` y `supabase/functions/evidencia/` (cada función lleva su copia de `harness.ts`;
  deben mantenerse idénticas). Desplegado en Supabase: `documento` v2, `evidencia` v4.
- Reintentos solo ante fallas transitorias (red, tiempo agotado, 429, 5xx) con espera creciente. Reanudar con el mismo
  `run_id` repite solo lo pendiente: la lectura de la IA, si ya salió bien, no se vuelve a pagar.
- Pendiente (pasos siguientes): módulo común para `manual`/`ai`/`aprender`, panel de salud de agentes, habilidades propuestas.

# Harness de agentes · paso 2 (módulo común en manual y aprender)

- `supabase/functions/_shared/harness.ts` es la copia canónica (v2: `detalle` en errores, `anotar()`, `NIL_USER`).
  Cada función lleva su copia idéntica al desplegar.
- Migradas al módulo: `manual` (v5) y `aprender` (v7). Ahora todas sus llamadas a la IA se reintentan ante fallas
  transitorias, y quedan en `agent_runs`:
  - `manual:<garantias|cobros|prueba>`: una corrida por pregunta, con cada llamada a la IA y cada herramienta usada.
  - `aprender`: una corrida por evento de aprendizaje (el cron `aprender-barrido` corre cada 2 min con usuario "sistema"
    `00000000-0000-0000-0000-000000000000`).
- El código fuente de `manual` y `aprender` vive en Supabase (no está copiado en este repositorio todavía).

# Harness de agentes · paso 2b (`ai`)

- `ai` (v13) migrada al módulo común: sus llamadas a la IA se reintentan ante fallas transitorias y cada petición queda en
  `agent_runs` como `ai:<modo>` (`garantia`, `chat`, `agente`, `garantias_chat`, `extraer`, `probar`). Usa `AsyncLocalStorage`
  para que cada llamada sume sus intentos a la corrida de SU petición. Código en `supabase/functions/ai/`.
- Prueba de arranque (llamada con la llave pública, sin sesión): `ai`, `manual`, `documento`, `evidencia` y `aprender`
  responden `401 unauthorized` desde su propio código, es decir, cargan bien.
- `documento` (v2) y `evidencia` (v4) siguen con `harness.ts` v1: el comportamiento es el mismo (solo les falta `detalle` en
  errores, que no usan). Se igualan a v2 en su próximo despliegue.
- Código fuente de `manual` (v5) y `aprender` (v7): viven solo en Supabase, no están copiados en este repositorio.

# Panel de salud de agentes

- Tarjeta "Salud de agentes" en el Tablero de agencia (administradores) y en la pestaña Cerebro del tablero de marca.
  Muestra corridas, % de éxito, reintentos, tiempo medio y p95, corridas sin cerrar (más de 10 min en curso) y las últimas
  fallas, por agente. Periodos: 24 h, 7 días, 30 días. Se refresca solo cada 30 s con el tablero abierto.
- Datos: función SQL `salud_agentes(p_horas)` (SECURITY INVOKER: respeta las políticas de `agent_runs`).
  Políticas: cada quien ve lo suyo; el administrador de agencia ve a su gente (`can_admin`); la marca ve todo, incluido el
  aprendizaje automático (usuario "sistema"), con la política `runs read marca`.
