import { describe, it, expect, afterAll } from 'vitest';
import { closePool } from '../src/db/pool.js';
import { runDemo } from '../src/demo/run.js';

afterAll(closePool);

describe('demo de punta a punta', () => {
  it('verifica, estima, registra, corta, aprueba y la misma PREA cambia de resultado', async () => {
    const lines: string[] = [];
    const r = await runDemo(s => lines.push(s));
    expect(r.before).toHaveLength(0);                                   // antes: la PREA sin foto pasa
    expect(r.after.map((f: any) => f.rule_key)).toEqual(['learned.falta_foto.foto']); // después: la regla aprendida la detiene
    expect(r.candidates).toEqual(['learned.falta_foto.foto']);
    expect(r.estimateAfter).toBeGreaterThan(r.estimateBefore);          // tarifa 420 → 450 aprobada
    expect(r.auditIntact).toBe(true);
    expect(lines.join('\n')).not.toMatch(/Juan|Pérez|443 123/);          // la salida no expone datos personales
  });
});
