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
