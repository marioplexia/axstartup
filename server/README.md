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
