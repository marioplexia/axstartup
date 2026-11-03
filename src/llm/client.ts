import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../../config/defaults.js';
import { sha, isSealed, RedactionRequiredError } from '../redact/index.js';
import { mockComplete } from './mock.js';

export interface LlmUsage { model: string; promptHash: string; inputTokens: number; outputTokens: number; costUsd: number }
export interface LlmClient {
  /** Llama a un agente con un prompt versionado y devuelve salida validada con zod. Nunca registra el texto. */
  run<T>(agent: string, promptFile: string, input: unknown, schema: z.ZodType<T>): Promise<{ output: T; usage: LlmUsage }>;
}

const PROMPTS = path.resolve(import.meta.dirname, '../../prompts');
export const loadPrompt = (file: string) => fs.readFileSync(path.join(PROMPTS, file), 'utf8');
export const cost = (i: number, o: number) => +(i * CONFIG.llm.priceInPerMTok / 1e6 + o * CONFIG.llm.priceOutPerMTok / 1e6).toFixed(6);

export function extractJson(s: string): unknown {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('la respuesta no contiene JSON');
  return JSON.parse(s.slice(a, b + 1));
}

class MockClient implements LlmClient {
  async run<T>(agent: string, promptFile: string, input: unknown, schema: z.ZodType<T>) {
    const prompt = loadPrompt(promptFile) + '\n\n' + JSON.stringify(input);
    const raw = mockComplete(agent, input);
    const output = schema.parse(raw);
    const inT = Math.ceil(prompt.length / 4), outT = Math.ceil(JSON.stringify(raw).length / 4);
    return { output, usage: { model: 'mock', promptHash: sha(prompt), inputTokens: inT, outputTokens: outT, costUsd: 0 } };
  }
}

class LiveClient implements LlmClient {
  private sdk = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  async run<T>(agent: string, promptFile: string, input: unknown, schema: z.ZodType<T>) {
    // Bloqueo: al modelo real solo llega lo que pasó por sealForModel (redacción + verificación de residuos).
    if (!isSealed(input)) throw new RedactionRequiredError(`agente ${agent}: el payload no pasó por la redacción (usa sealForModel)`);
    const prompt = loadPrompt(promptFile) + '\n\n' + JSON.stringify(input);
    let inT = 0, outT = 0, lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = await this.sdk.messages.create({ model: CONFIG.llm.model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
      inT += msg.usage.input_tokens; outT += msg.usage.output_tokens;
      const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
      try {
        const output = schema.parse(extractJson(text));
        return { output, usage: { model: CONFIG.llm.model, promptHash: sha(prompt), inputTokens: inT, outputTokens: outT, costUsd: cost(inT, outT) } };
      } catch (e) { lastErr = e; }
    }
    throw new Error('salida del agente inválida tras reintento: ' + (lastErr as Error).message);
  }
}

export function makeLlm(): LlmClient {
  return process.env.LLM_MODE === 'live' ? new LiveClient() : new MockClient();
}
