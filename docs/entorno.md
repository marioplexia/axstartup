# Entorno desde cero

Requisitos: Node 22+, pnpm, Docker (con Compose v2). Nada más: Postgres corre en el contenedor.

```bash
git clone <repo> && cd axstartup
pnpm install
cp .env.example .env     # JWT_SECRET etc.; los valores por defecto sirven para desarrollo local
pnpm db:up               # levanta Postgres 16 y espera a que esté sano (crea axai, axai_test, axai_demo)
```

Después:

```bash
pnpm test                # reconstruye axai_test en cada corrida (drop schema + migraciones + seed)
pnpm demo                # recorrido completo con datos ficticios en axai_demo (migra solo)
pnpm db:migrate && pnpm db:seed && pnpm dev    # API en :3000 sobre la base axai
```

Apagar y limpiar:

```bash
pnpm db:down             # apaga (conserva los datos)
pnpm db:reset            # borra el volumen y vuelve a crear las tres bases
```

## Detalles

- Puerto ocupado (otro Postgres en 5432): `POSTGRES_PORT=5433 pnpm db:up` y exporta `TEST_DATABASE_URL=postgres://axai:axai@localhost:5433/axai_test`, `DATABASE_URL=postgres://axai:axai@localhost:5433/axai` y `DEMO_DATABASE_URL=postgres://axai:axai@localhost:5433/axai_demo`.
- `docker/initdb/*.sql` solo corre al crear el volumen; si cambias ese script usa `pnpm db:reset`.
- El usuario `axai` es superusuario **del contenedor**; la aplicación opera cada transacción como `axai_app` (RLS por grupo), así que las pruebas ejercitan las mismas políticas que producción.
- Sin Docker: cualquier Postgres 16 sirve si creas el rol `axai` (superusuario, contraseña `axai`) y las bases `axai`, `axai_test` y `axai_demo`.
- `LLM_MODE=mock` por defecto: ni `test` ni `demo` necesitan clave de API ni red. Para la API real ver `docs/live.md`.
- Siguen sin datos reales en ningún comando: seed, demo y fixtures son ficticios.
