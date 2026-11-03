# Servidor de Ax AI Garantías

```bash
cd server
npm ci
npm run db:init                      # crea server/data/ax.db con el catálogo base
AX_MODO_PRUEBA=1 npm start           # http://localhost:3000
```

Abre `http://localhost:3000`: te manda a `/login`. Con `AX_MODO_PRUEBA=1` aparece el botón
**Entrar en modo prueba** (asesor `prueba@ax.test`, sin contraseña). Sin esa variable el botón
no existe y el endpoint `/api/auth/prueba` responde 404 — no lo actives en producción.

`npm run db:reset` borra la base y la vuelve a cargar. Define `JWT_SECRET` para que las sesiones
sobrevivan a un reinicio.

## Como sitio web (Docker / Render)

`Dockerfile` y `render.yaml` están en la raíz. La base SQLite vive en `/data` (disco persistente).

```bash
docker build -t ax-garantias .
docker run -p 3000:3000 -v ax-data:/data -e JWT_SECRET=cambia-esto -e AX_MODO_PRUEBA=1 ax-garantias
```

En Render: *New → Blueprint* y elige este repo/rama; crea el servicio con disco y `JWT_SECRET` automático.
Cualquier host con Docker y un volumen en `/data` sirve (Fly.io, Railway, un VPS).

## Bitácora de órdenes

Pantalla **Bitácora** de la app (pestañas *Órdenes*, *Bitácora* y *Desempeño*), conectada a la tabla `orders`.
Los datos de ejemplo (17 PREAs de la última semana y 1 servicio) se cargan con `npm run db:init` si la tabla está vacía.
Cada PREA que prepara el agente se registra sola; al pulsar «Fue aceptada» o «Fue rechazada» cambia su estado.

| Endpoint | Qué hace |
|---|---|
| `GET /api/garantias/ordenes?tipo=&estado=&q=&desde=&hasta=&asesor=&incompletos=1` | Lista con filtros, TPU (8 días) y conteos |
| `POST /api/garantias/ordenes` | Crea una orden (`tipo`: prea, servicio, campana) |
| `PATCH /api/garantias/ordenes/:id` | Cambia `status` o `ev_have` (evidencias del expediente) |
| `GET /api/garantias/desempeno?periodo=dia\|semana\|mes` | Totales, cobros del día, ciclo promedio y precisión |

Un asesor solo ve las órdenes de su agencia; el administrador ve todas.

## Inicio (tablero)

Pantalla **Inicio**: saludo con el nombre del asesor, tarjetas de PREAs aprobadas, piezas en pedido, campañas y servicios realizados,
y una pantalla de detalle por tarjeta (con búsqueda, filtros y «Descargar lista» en CSV). Las órdenes salen de la tabla `orders`.

| Endpoint (`/api/garantias/inicio/…`) | Qué devuelve |
|---|---|
| `preas?meses=3\|6\|12&anio=` · `preas/lista?q=` | Aprobadas, negadas, comparación con el periodo anterior y tasa de aprobación |
| `piezas?meses=` · `piezas/lista?estado=&q=` | Piezas por pedir / pedidas / en planta y serie acumulada |
| `campanas?periodo=mes\|mes_pasado\|3m` · `campanas/lista?estado=&q=` | Campañas cerradas, realizadas (por cobrar) y pendientes |
| `servicios?periodo=` · `servicios/lista?tipo=&q=` | Servicios pagados por tipo |
| `acciones` · `asesores` | Acciones recomendadas y asesores para el filtro |

Todos aceptan `asesor=<id>`. Un asesor solo ve su agencia. Los datos de ejemplo (12 meses de PREAs, piezas, campañas y servicios) se cargan una sola vez.
En la Bitácora, al abrir una orden con pieza puedes marcarla como pedida o en planta; al aprobar una PREA su pieza pasa a «por pedir».

## Mi Agente (chat)

Pantalla **Mi Agente**: el mismo chat del Agente de Garantías, para preguntar sobre PREAs, servicios, campañas, piezas y expedientes
(«¿qué piezas me faltan por pedir?», «estado de la PREA GA3957», «campañas pendientes de cobro»…). Las conversaciones se guardan por asesor.

- **Con IA:** define `ANTHROPIC_API_KEY` (y opcionalmente `CHAT_MODEL`, por defecto `claude-sonnet-5-5`). El modelo consulta los datos con herramientas de solo lectura y no inventa cifras.
- **Sin clave:** responde un motor local por reglas que lee las mismas tablas (conteos, listas, folios, clientes, periodos, piezas, expedientes, cobros, TPU y reglas).

| Endpoint | Qué hace |
|---|---|
| `POST /api/garantias/chat` `{mensaje, hilo?, alcance?}` | Responde y guarda el mensaje (`alcance`: `agencia` o `mias`) |
| `GET /api/garantias/chat/hilos` · `GET …/hilos/:id` · `DELETE …/hilos/:id` | Historial de conversaciones del asesor |

## Agente de Cartera

Pantalla **Agente de Cartera**: piezas instaladas y cobradas a la planta, saldos por recuperar, antigüedad de saldos (0–15, 16–30, 31–60, +60 días) y detalle por PREA,
con panel de comentarios, registro de pago y exportación a Excel (.xlsx) y PDF. La pestaña **Agente** resume la cartera y sugiere a quién dar seguimiento.
Los cobros se crean solos cuando una campaña pasa a «realizada» o a una PREA aprobada le llega la pieza a planta, y se cierran al marcar la campaña como «cerrada».

| Endpoint (`/api/garantias/…`) | Qué hace |
|---|---|
| `GET cartera?estado=abierto\|pagado\|vencido&q=` | KPIs, antigüedad de saldos y cobros |
| `POST cartera/:id/pago` `{pagado}` | Registra el pago o reabre el cobro |
| `GET/POST cartera/:id/comentarios` | Comentarios del cobro |
| `GET cartera/agente` | Lectura del agente y acciones sugeridas |

## Expedientes

Pantalla **Expedientes**: cada PREA, servicio y campaña es una tarjeta con su avance; al abrirla se ve el checklist y se suben los archivos y evidencias.
Secciones por tipo: PREA (evidencias, factura, documentos firmados, cobro a planta, destrucción de la pieza), servicio (evidencias, factura, documentos firmados) y campaña (evidencias, documentos firmados, cobro a planta).
Una sección queda completa cuando tiene al menos un archivo; el avance se refleja en Bitácora, Inicio y Mi Agente. Hay auditoría de cada carga o borrado y un resumen en PDF.

- Los archivos se guardan en disco, en la carpeta `files/` junto a la base (en Render, el volumen `/data`). Cambia la ruta con `FILES_DIR`.
- Máximo 25 MB por archivo; se rechazan ejecutables y archivos HTML/SVG/JS. Las imágenes se pueden ver en pantalla y el resto se descarga.
- Lo que se adjunta en el Agente de Garantías se guarda en «Evidencias» de la PREA que se registra.

| Endpoint (`/api/garantias/…`) | Qué hace |
|---|---|
| `GET expedientes?tipo=&estado=completo\|incompleto&q=` | Lista con avance y estado de cobro |
| `GET expedientes/:orden` | Checklist, archivos, avance y auditoría |
| `POST expedientes/:orden/:seccion/archivos?nombre=&nota=` | Sube un archivo (cuerpo binario, cabecera `X-Mime`) |
| `GET/PATCH/DELETE expedientes/archivos/:id` | Descarga, edita la nota o elimina |

## Órdenes activas y cerradas

En **Bitácora → Órdenes** las órdenes se ven como historial, de la más reciente a la más antigua y agrupadas por fecha. Por defecto se muestran las **activas**.
Una orden pasa a **cerrada** solo cuando se marca como **cobrada**: con «Marcar como cobrada» en su expediente (Expedientes) o al registrar el pago del cobro en Cartera. «Reabrir orden» la regresa a activa.
Solo se puede cobrar una PREA aprobada, un servicio pagado o una campaña realizada. Las rechazadas tienen su propio filtro.

- `GET /api/garantias/ordenes?cierre=activa|cerrada|rechazada` (y `cierre` con los conteos en la respuesta)
- `POST /api/garantias/expedientes/:orden/cobro` `{cobrado}`

## Entrenamiento del agente (Tablero de agencia → Entrenamiento)

Tres apartados:

1. **PREAs aceptadas** (y, si quieres, rechazadas): PDFs o imágenes de PREAs que la planta ya resolvió. El agente lee el formulario y el **historial de comentarios**, aprende cómo se llenó cada campo, por qué se rechazó antes y cómo se corrigió, y crea o refuerza una regla del catálogo (queja + sistema). Valida cada PREA contra la regla que ya existe (operación, causa, corrección, tiempo y piezas) y avisa de las diferencias.
2. **Transacciones pagadas de planta**: PDFs o imágenes de pagos. Se ligan a su PREA (orden de trabajo, autorización, folio o VIN) y corrigen las horas y los precios de pieza de la regla con lo que la planta realmente pagó.
3. **Probar al agente**: el mismo chat de siempre. Preguntas libres («cambio de polea de un Aveo 2024 de 40 mil km», «¿por qué rechazaron esa PREA?», «¿cuánto paga la planta?») o sube una PREA para validarla: responde con la PREA aceptada más parecida como ejemplo, los errores que tuvo y cómo se corrigieron, lo que pagó la planta y qué corregir en la PREA subida.

**Con una sola PREA aceptada basta**: la regla se crea, se activa y se reparte a los asesores al instante (el umbral del Tablero ahora es de 1 PREA por defecto y se puede subir). Además:

- **Variantes de contexto**: cada PREA aceptada queda guardada como variante de su regla (modelo, año, operación, causa, corrección, tiempo y piezas). Un caso parecido pero de otro modelo no se pierde ni se mezcla: el Agente de Garantías usa la variante del modelo que menciona la PREA.
- **Errores**: del historial de comentarios (rechazos y solicitudes de la planta, con su corrección) y de las **PREAs rechazadas** que subas (se comparan contra lo aceptado del mismo modelo). Se ligan a la queja de la regla y el Agente de Garantías los avisa al preparar una PREA igual; si una PREA rechazada tiene los mismos códigos que la regla, baja su confianza.
- Al eliminar un documento se deshace lo que aportó: contadores, variantes y errores.

**Cómo lee los archivos**
- Con `ANTHROPIC_API_KEY`: un modelo con visión lee cualquier formato, también PDFs escaneados y fotos (`TRAIN_MODEL` opcional; el chat de pruebas también redacta con el modelo).
- Sin clave: texto del PDF + lector local que entiende la autorización previa de GM; las imágenes pasan por OCR en español (tesseract, sin internet). Un PDF escaneado sin texto necesita IA o subirse como imagen.
- Los archivos se guardan en `train/` junto a la base (en Render, el volumen `/data`; cambia la ruta con `TRAIN_DIR`). Máximo 20 MB; solo PDF, PNG, JPG, WEBP o GIF (se valida por los bytes del archivo).

Documentos de ejemplo (datos ficticios) en `samples/`, también descargables desde la pantalla: un Aveo 2024 con cambio de polea y un Equinox 2023, sus pagos de planta, una PREA con errores para validar y dos PREAs más de la polea para activar la regla. Se regeneran con `python3 samples/generar.py`.

| Endpoint (`/api/garantias/entrenamiento/…`) | Qué hace |
|---|---|
| `POST docs?tipo=prea\|pago&nombre=` (cuerpo binario) · `GET docs?tipo=` | Sube un documento (se lee en segundo plano) y lista el estado |
| `GET docs/:id` · `GET docs/:id/archivo` · `POST docs/:id/reintentar` · `DELETE docs/:id` | Datos leídos, original, reintentar y eliminar (deshace lo aprendido) |
| `GET resumen` · `GET ejemplos` | Contadores y documentos de ejemplo |
| `POST prueba/archivos?nombre=` · `POST chat` `{mensaje, hilo?, archivos?}` · `GET chat/hilos` | Chat de pruebas con archivos adjuntos (lo subido no se aprende) |
