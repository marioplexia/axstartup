// Parámetros configurables (todo sobreescribible por variables de entorno en producción).
export const CONFIG = {
  llm: {
    model: process.env.LLM_MODEL ?? 'claude-haiku-5-5',
    // USD por millón de tokens. PLACEHOLDER: pon aquí la tarifa vigente de tu contrato; con 0 el costo sale en 0.
    priceInPerMTok: Number(process.env.LLM_PRICE_IN ?? 0),
    priceOutPerMTok: Number(process.env.LLM_PRICE_OUT ?? 0),
  },
  nightly: { minCasesForRule: 3, minCasesForTabulator: 3, tabulatorDeviationPct: 5 },
  eval: { buildCases: 30, blindCases: 20 },
};
