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
