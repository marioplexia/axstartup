# Ax Ai Garantías — backend de los dos bucles de aprendizaje de la PREA

Backend para **una marca (GM) y sus agencias** (las 5 del grupo FAME, una de ellas Apatzingán). Dos bucles que aprenden de lo que responde la planta y **solo cambian con aprobación humana**:

1. **Bucle 1 – evitar rechazos**: verifica la PREA antes de enviarla (checklist determinista + agente lector de evidencia).
2. **Bucle 2 – estimar el pago**: calculadora determinista con tabuladores vigentes a la fecha del reclamo (el agente solo extrae conceptos).

`index.html` es el prototipo de interfaz anterior; no está conectado a este backend todavía.

## Arranque rápido

Requisitos: Node 22+, pnpm, Postgres 16 (Supabase o local).

```bash
pnpm install
cp .env.example .env            # ajusta DATABASE_URL, JWT_SECRET
pnpm db:migrate                 # aplica supabase/migrations/*.sql
pnpm db:seed                    # GM + 5 agencias FAME (datos ficticios)
pnpm test                       # usa TEST_DATABASE_URL (por defecto postgres://axai:axai@localhost:5432/axai_test) y lo reconstruye
pnpm demo                       # recorrido completo con una orden ficticia
pnpm dev                        # API en :3000
```

El rol de conexión debe poder hacer `SET ROLE axai_app` (superusuario, o la migración 0009 lo concede): cada transacción corre como `axai_app` con `app.group_id`, así que **RLS aplica siempre**.

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm test` | Vitest (80 pruebas: esquema/RLS/auditoría, redacción, ingesta, calculadora con casos dorados, verificación, resultado y métricas, corte nocturno, aprobación, SSE, eval, demo) |
| `pnpm demo` | Verificar → estimar → registrar resultado → corte → regla candidata → aprobar → volver a verificar, mostrando el cambio |
| `pnpm nightly --group <uuid> [--min-cases 3] [--min-payments 3] [--deviation-pct 5]` | Corte nocturno. Cron: `30 2 * * * cd /app && pnpm nightly --group <uuid>` |
| `pnpm ingest --group <uuid> --file orden.json` | Importa una orden (formato en `src/ingest/schema.ts`) |
| `pnpm redact:report <archivo> [--names "A,B"] [--out reports/x.md]` | Muestra qué se quitó de un archivo (ver `docs/redaccion.md`) |
| `pnpm live:compare [--dry]` | Agente simulado vs API real en 5 casos ficticios, con diferencias y costo por PREA (ver `docs/live.md`) |
| `pnpm eval:retro --group <uuid> [--build 30] [--blind 20] [--agent] [--flag-at warning\|blocker] [--detail] [--out reports]` | Prueba retroactiva (reporte `.json` + `.md` en `reports/`, ignorado por git) |

## API

Autenticación: `Authorization: Bearer <JWT HS256>` con claims `sub`, `group_id`, `role` (`advisor`/`reviewer`/`owner`) y `agency_id` (asesores). En `/events/stream` también se acepta `?access_token=` (EventSource no manda cabeceras; el logger nunca registra la query).

| Endpoint | Roles | Descripción |
|---|---|---|
| `POST /orders/import` | todos* | Ingesta idempotente de una orden completa |
| `POST /prea/verify` | todos* | Hallazgos con severidad y la regla (`rule_key@version`) que los generó |
| `POST /verifications/:id/ignore` | todos* | Ignorar un hallazgo **registrando la razón** (dato + audit_log) |
| `POST /prea/estimate` | todos* | Total y desglose con las versiones de tabulador usadas |
| `POST /prea/:id/outcome` | todos* | Resultado: rondas, días a aceptación, estimado vs pagado (`:id` = id de la orden) |
| `GET /metrics` | todos* | Por agencia y por marca (el asesor solo ve su agencia) |
| `GET /events/stream` | todos* | SSE: `prea`, `comment`, `payment`, `rule`; reanuda con `Last-Event-ID` |
| `GET /rules`, `GET /tabulators` (`?status=candidate`) | reviewer/owner (asesor: solo activas/retiradas) | Candidatas con casos de respaldo y último backtest |
| `POST /rules/:id/approve\|discard\|revert` y lo mismo en `/tabulators/:id/…` | **solo reviewer** | Ver "Versiones" |
| `POST /nightly/run` | reviewer/owner | Dispara el corte desde el panel |

\* El asesor solo opera sobre su propia agencia.

## Cómo aprende (y cómo no)

- **Reglas** (`rules`): versionadas, bucle 1 o 2, condición JSON, evidencia que las respalda, quién aprobó y cuándo. Tipos que entiende el checklist: `required_field`, `required_evidence` (con `when` por campo), `deadline`, `duplicate`, `code_pair`, y `non_payable` (bucle 2).
- **Origen de las reglas**: lo único sembrado son las **14 reglas de campo obligatorio** derivadas del formulario GM del prototipo. **Todo lo demás se aprende con los expedientes** que se vayan subiendo.
- **Corte nocturno**: clasifica los comentarios de la planta con la taxonomía `taxonomy/rejection-causes.yaml` (**revísala/edítala**; cada causa define la plantilla de regla). Si una causa se repite en ≥ N casos (configurable) propone una regla; si ≥ N pagos recientes son consistentes (±2 %) y se desvían ≥ 5 % del tabulador, propone una nueva versión de tabulador. Antes de proponer hace **backtest** (precisión/omisiones, o error nuevo vs viejo) y lo guarda en `rule_backtests`. **Todo queda en `candidate`**; nada se activa solo.
- **Versiones**: aprobar activa la candidata con vigencia (`valid_from`, nunca futura), retira la versión anterior con `valid_to = valid_from − 1`, registra aprobador y fecha, y escribe en `audit_log`. **Revertir** crea una versión *nueva* con el contenido de la anterior; el historial nunca se reescribe, así que estimaciones y verificaciones pasadas siguen explicables.
- Un trigger en la base impide que un rol distinto de `reviewer` cambie el estado, aunque se salten la API.

## Prueba retroactiva

Reparto **cronológico**: los casos más antiguos son de construcción (30) y los siguientes de prueba ciega (20); ambos números son parámetros. El reparto es idempotente y **nunca mueve** una orden ciega.

- En la ciega, el sistema recibe **solo** `prea_versions.version_no=1` + la evidencia de esa versión. No lee comentarios ni resultado hasta puntuar (las pruebas lo verifican alterando los comentarios).
- El corte nocturno **excluye** las órdenes ciegas del aprendizaje. `eval:retro` aborta si encuentra una regla o tabulador aprendido cuyo respaldo incluya un caso ciego.
- El reporte da rechazos detectados vs reales (recall/precisión), error del estimado (MAE en pesos y MAPE) y rondas reales vs predichas. **No incluye detalle por caso** salvo `--detail`: no ajustes reglas mirando la ciega.
- **Corre `eval:retro` una vez antes del primer corte nocturno** para fijar el reparto.

## Seguridad y privacidad

- Secretos solo en variables de entorno (`.env.example`); sin datos reales en el repo (todo el seed y los fixtures son ficticios).
- Todo texto que va al modelo o se guarda pasa por `src/ingest/redact.ts` (correo, teléfono, RFC, CURP, placas, nombres tras disparadores y nombres conocidos). Los autores se guardan como hash con sal (`PII_SALT`).
- Logs sin datos personales: el servidor solo registra método/ruta/estado; `llm_calls` guarda **hash del prompt y tokens, nunca el texto**.
- Prompts en archivos versionados: `prompts/*.md`.
- RLS forzada en todas las tablas con `group_id`; `audit_log` es solo-agregar con hash encadenado por grupo (`select verify_audit_chain('<grupo>')` devuelve `null` si está íntegra).

## Agentes (LLM)

`LLM_MODE=mock` (por defecto en pruebas y demo) usa un agente determinista que imita el contrato; `LLM_MODE=live` usa la API de Anthropic con `ANTHROPIC_API_KEY` y `LLM_MODEL`. Las salidas se validan con zod (un reintento) y, si el lector de evidencia falla, el checklist determinista sigue funcionando. Las tarifas por token para el costo están en `config/defaults.ts` (`LLM_PRICE_IN/OUT`, **en 0 hasta que las configures**).

## Estructura

```
supabase/migrations/   0001…0009 (esquema, RLS, auditoría, aprendizaje)
src/{db,auth,ingest,verify,estimate,outcome,metrics,nightly,rules,events,eval,llm,demo,routes}
prompts/  taxonomy/  config/  scripts/  tests/
```
