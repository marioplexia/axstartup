import { describe, it, expect } from 'vitest';
import { LiveClient, MockClient } from '../src/llm/client.js';
import { compareAgents, reportToMarkdown, diffRuns } from '../src/eval/livecompare.js';
import { LIVE_CASES } from './fixtures/live-cases.js';
import { sealForModel, RedactionRequiredError } from '../src/redact/index.js';
import { z } from 'zod';

/** SDK falso: responde según el prompt y cuenta tokens. No hay red ni clave. */
function fakeSdk(opts: { deviate?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    sdk: {
      messages: {
        create: async (req: any) => {
          const prompt: string = req.messages[0].content; calls.push(prompt);
          const isClassifier = prompt.startsWith('# rejection-classifier');
          const body = isClassifier
            ? { cause_code: opts.deviate ? 'otro' : (/diagn/i.test(prompt) ? 'falta_diagnostico' : 'otro'), confidence: 0.8, field: null }
            : { concepts: { operations: [], parts: [] }, evidence_detected: ['foto'], missing: [], notes: [] };
          return { content: [{ type: 'text', text: JSON.stringify(body) }], usage: { input_tokens: 1000, output_tokens: 200 } };
        },
      },
    } as any,
  };
}

describe('comparación agente simulado vs real (cliente real falso)', () => {
  it('corre los 5 casos, nunca manda texto crudo y calcula costo con tarifas por millón de tokens', async () => {
    const f = fakeSdk();
    const live = new LiveClient(f.sdk, { priceInPerMTok: 1, priceOutPerMTok: 5 });
    process.env.LLM_PRICE_IN = '1'; process.env.LLM_PRICE_OUT = '5';
    try {
      const rep = await compareAgents(LIVE_CASES, new MockClient(), live, 'modelo-falso');
      expect(rep.cases).toHaveLength(5);
      expect(rep.summary.live_ran).toBe(5);
      // 2 llamadas por PREA × (1000 in + 200 out) = 2000 in, 400 out => 2000*1/1e6 + 400*5/1e6 = 0.004
      expect(rep.summary.avg_cost_per_prea_usd).toBeCloseTo(0.004, 6);
      expect(rep.summary.total_cost_usd).toBeCloseTo(0.02, 6);
      expect(rep.summary.avg_tokens_per_prea).toBe(2400);
      // ningún dato personal ni VIN completo salió hacia el "modelo"
      const sent = f.calls.join('\n');
      for (const pii of ['Roberto', 'Salcedo', '443 555 0192', 'RUCA900515AB3', 'Hidalgo', '58000', '443 111 2233', 'Marcela', 'Luis Hernández', '3GNAXKEV5NL100001'])
        expect(sent, pii).not.toContain(pii);
      expect(sent).toContain('…100001');
    } finally { delete process.env.LLM_PRICE_IN; delete process.env.LLM_PRICE_OUT; }
  });

  it('reporta diferencias entre simulado y real', async () => {
    const live = new LiveClient(fakeSdk({ deviate: true }).sdk, { priceInPerMTok: 1, priceOutPerMTok: 5 });
    const rep = await compareAgents(LIVE_CASES, new MockClient(), live, 'modelo-falso');
    expect(rep.summary.cases_with_diffs).toBeGreaterThan(0);
    const l2 = rep.cases.find(c => c.id === 'L2')!;
    expect(l2.diffs.join(' ')).toMatch(/causa: simulado=falta_diagnostico real=otro/);
    expect(reportToMarkdown(rep)).toContain('Diferencias simulado ↔ real');
  });

  it('sin tarifas en el entorno el costo sale n/d, no 0', async () => {
    delete process.env.LLM_PRICE_IN; delete process.env.LLM_PRICE_OUT;
    const rep = await compareAgents(LIVE_CASES.slice(0, 1), new MockClient(), new LiveClient(fakeSdk().sdk), 'm');
    expect(rep.prices_configured).toBe(false);
    expect(rep.summary.avg_cost_per_prea_usd).toBeNull();
    expect(reportToMarkdown(rep)).toContain('LLM_PRICE_IN');
  });

  it('un error de la API en un caso no tumba la comparación', async () => {
    const bad = { messages: { create: async () => { throw new Error('429 simulado'); } } } as any;
    const rep = await compareAgents(LIVE_CASES.slice(0, 2), new MockClient(), new LiveClient(bad), 'm');
    expect(rep.cases.every(c => c.live && 'error' in c.live)).toBe(true);
  });

  it('el cliente real rechaza un payload sin sellar aunque el SDK sea falso', async () => {
    const f = fakeSdk();
    await expect(new LiveClient(f.sdk).run('a', 'rejection-classifier.v1.md', { comment: 'Cliente Ana 443 123 4567' }, z.any())).rejects.toThrow(RedactionRequiredError);
    expect(f.calls).toHaveLength(0);
    await expect(new LiveClient(f.sdk).run('a', 'rejection-classifier.v1.md', sealForModel({ comment: 'ok' }), z.any())).resolves.toBeDefined();
  });

  it('diffRuns no marca diferencias cuando coinciden', () => {
    const r = { evidence: { evidence_detected: ['foto'], missing: [], concepts: { operations: [], parts: [] } }, classify: { cause_code: 'otro', field: null } };
    expect(diffRuns(r, r)).toEqual([]);
  });
});
