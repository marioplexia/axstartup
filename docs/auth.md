# Autenticación

`src/auth.ts` define `AuthProvider { name; verify(token): Promise<Principal> }`. El servidor (`buildServer`) solo depende de esa interfaz y recibe el proveedor por `deps.auth`; si no se le pasa, `makeAuthProvider()` elige uno.

| Proveedor | Estado | Cuándo |
|---|---|---|
| `DevAuthProvider` | listo | **solo `NODE_ENV=development`**: tokens HS256 con `JWT_SECRET` y emisor `axai-dev` |
| `SupabaseAuthProvider` | **pendiente** (falla cerrado) | cualquier otro entorno |

## Regla: sin tokens de desarrollo fuera de `NODE_ENV=development`

- `signDevToken` lanza `AuthConfigError` fuera de development (no se pueden emitir).
- `new DevAuthProvider()` lanza fuera de development, y `verify` lo vuelve a comprobar en cada llamada (no basta con construirlo antes).
- `AUTH_PROVIDER=dev` **no** salta la regla.
- Sin proveedor válido para el entorno el servidor **no arranca** (no queda un servidor abierto ni uno que responda 401 a todo sin explicar por qué).
- Para que las pruebas puedan firmar tokens, `vitest.config.ts` fija `NODE_ENV=development`; `tests/auth.test.ts` comprueba el rechazo en `production`, `test`, `staging`, vacío y sin definir. `pnpm dev` y `pnpm demo` fijan `NODE_ENV=development` explícitamente.

## Para conectar Supabase Auth (pendiente)

Implementar `SupabaseAuthProvider.verify`: validar el JWT de Supabase (JWKS de `SUPABASE_URL` o `SUPABASE_JWT_SECRET`) y construir el `Principal` desde `sub` y **`app_metadata`** (`group_id`, `role`, `agency_id`; nunca `user_metadata`, que edita el propio usuario). Las rutas y RLS no cambian: ya consumen `Principal`. Hay que decidir cómo se asigna `group_id`/`role` a cada usuario (hook de alta o tabla de membresías).
