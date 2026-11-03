export interface SplitCase { id: string; claim_date: string | null; order_number: string; split: 'build' | 'blind' | null }

/**
 * Reparto cronológico: construcción = los más antiguos, prueba ciega = los siguientes (el futuro del sistema nunca se usa para
 * aprender del pasado). Las asignaciones existentes JAMÁS se mueven: una orden ciega no vuelve a ser de construcción.
 */
export function assignSplit(cases: SplitCase[], build: number, blind: number) {
  const existing = new Map(cases.filter(c => c.split).map(c => [c.id, c.split!]));
  const count = (s: 'build' | 'blind') => [...existing.values()].filter(x => x === s).length;
  const free = cases.filter(c => !c.split).sort((a, b) => (a.claim_date ?? '').localeCompare(b.claim_date ?? '') || a.order_number.localeCompare(b.order_number));
  const needBuild = Math.max(0, build - count('build')), needBlind = Math.max(0, blind - count('blind'));
  const assigned = new Map<string, 'build' | 'blind'>();
  free.slice(0, needBuild).forEach(c => assigned.set(c.id, 'build'));
  free.slice(needBuild, needBuild + needBlind).forEach(c => assigned.set(c.id, 'blind'));
  const buildTotal = count('build') + [...assigned.values()].filter(x => x === 'build').length;
  const blindTotal = count('blind') + [...assigned.values()].filter(x => x === 'blind').length;
  return { assigned, buildTotal, blindTotal, shortfall: { build: Math.max(0, build - buildTotal), blind: Math.max(0, blind - blindTotal) } };
}
