# Probar los agentes con la API real

Solo con **fixtures ficticios** (`tests/fixtures/live-cases.ts`, 5 casos). Todo pasa por redacción y `sealForModel` antes de salir; el VIN va como `…últimos6` + hash.

```bash
export ANTHROPIC_API_KEY=...        # tu clave
export LLM_MODEL=claude-haiku-5-5   # opcional
export LLM_PRICE_IN=...             # USD por millón de tokens de entrada (tu contrato)
export LLM_PRICE_OUT=...            # USD por millón de tokens de salida
pnpm live:compare                   # reporta en reports/live-compare-<fecha>.{md,json}
pnpm live:compare --dry             # solo simulado (sin API): verifica la tubería de redacción
```

Por caso se corren 2 agentes (lector de texto de evidencia y clasificador de comentario de planta) con el agente simulado y con el real. El reporte da: diferencias (evidencia detectada, faltantes, operaciones, piezas, causa, campo), diferencias contra lo que esperaría un revisor humano, tokens y **costo por PREA** (suma de ambas llamadas). Las tarifas viven solo en variables de entorno; sin ellas el costo sale `n/d`, nunca 0.

Las pruebas (`tests/livecompare.test.ts`) usan un SDK falso: validan la comparación, el cálculo de costo y que ningún dato personal llegue al cliente real, sin red ni clave.
