import { describe, it, expect } from 'vitest';
import { reconcile, reconciliationSummary } from '../src/ingest/reconcile.js';

const P = (n: string, ref = `p:${n}`) => ({ order_number: n, ref });
describe('reconcile PREA ↔ transacción', () => {
  it('une por número de orden, ignorando espacios y mayúsculas', () => {
    const r = reconcile([P('h-001'), P(' H-002 ')], [P('H-001', 't1'), P('H-002', 't2')]);
    expect(r.matched.map(m => m.order_number)).toEqual(['H-001', 'H-002']);
    expect(r.preaWithoutTransaction).toEqual([]);
  });
  it('reporta huérfanas de ambos lados', () => {
    const r = reconcile([P('A1'), P('A2')], [P('A2'), P('A3')]);
    expect(r.matched.map(m => m.order_number)).toEqual(['A2']);
    expect(r.preaWithoutTransaction.map(p => p.order_number)).toEqual(['A1']);
    expect(r.transactionWithoutPrea.map(p => p.order_number)).toEqual(['A3']);
  });
  it('reporta duplicados y no los une', () => {
    const r = reconcile([P('B1', 'p1'), P('B1', 'p2'), P('B2')], [P('B1', 't1'), P('B2', 't2'), P('B2', 't3')]);
    expect(r.duplicatePreas).toEqual([{ order_number: 'B1', refs: ['p1', 'p2'] }]);
    expect(r.duplicateTransactions).toEqual([{ order_number: 'B2', refs: ['t2', 't3'] }]);
    expect(r.matched).toEqual([]);
  });
  it('sugiere posibles errores de captura (ceros, guiones)', () => {
    const r = reconcile([P('H-0012')], [P('H12')]);
    expect(r.matched).toEqual([]);
    expect(r.nearMiss).toEqual([{ prea: 'H-0012', transaction: 'H12' }]);
    expect(reconciliationSummary(r)).toContain('¿mismo número?');
  });
});
