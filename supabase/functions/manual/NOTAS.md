# Función `manual` (Agente de Garantías / Cobros / Prueba)

Desplegada en Supabase (versión 4). El fuente vive allá; este archivo documenta el comportamiento:

- El agente consulta el manual del cerebro **en vivo** en cada pregunta (reglas, lecciones, casos de planta,
  pagos y documentos enseñados desde el tablero de agencia).
- `buscar_todo` revisa todas esas fuentes a la vez; el prompt obliga a usarla antes de decir "no sé".
- `buscar_ejemplos` busca en nombre de archivo, resumen, lecciones y datos leídos (no solo en `busqueda`).
