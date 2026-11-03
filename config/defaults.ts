// Parámetros configurables (todo sobreescribible por variables de entorno en producción).
export const CONFIG = {
  llm: {
    model: process.env.LLM_MODEL ?? 'claude-haiku-5-5',
    // USD por millón de tokens, SOLO por variables de entorno (LLM_PRICE_IN / LLM_PRICE_OUT). Sin ellas el costo sale en 0
    // y `pricesConfigured()` es false; los reportes lo indican en vez de mostrar un costo falso.
    priceInPerMTok: Number(process.env.LLM_PRICE_IN ?? 0),
    priceOutPerMTok: Number(process.env.LLM_PRICE_OUT ?? 0),
  },
  nightly: { minCasesForRule: 3, minCasesForTabulator: 3, tabulatorDeviationPct: 5 },
  eval: { buildCases: 30, blindCases: 20 },
};

export const pricesConfigured = () => !!process.env.LLM_PRICE_IN && !!process.env.LLM_PRICE_OUT && Number(process.env.LLM_PRICE_IN) > 0 && Number(process.env.LLM_PRICE_OUT) > 0;
