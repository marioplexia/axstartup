import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { signDevToken } from '../src/auth.js';
import { closePool, getPool, withTenant } from '../src/db/pool.js';
import { makeGroup } from './helpers/tenant.js';
import { readEvidenceMetadata, validateFile, loadEvidenceCatalog } from '../src/evidence/metadata.js';

afterAll(closePool);

describe('lector de evidencia por metadatos', () => {
  it('el catálogo carga y todo lo que "satisface" existe como tipo exigible', () => {
    const cat = loadEvidenceCatalog();
    expect(Object.keys(cat.kinds)).toEqual(expect.arrayContaining(['foto_tablero', 'diagnostico_escaner', 'orden_firmada']));
  });

  it('la etiqueta específica cubre al tipo genérico que exigen las reglas', () => {
    const r = readEvidenceMetadata([
      { kind: 'foto_tablero', filename: 'tablero.jpg' }, { kind: 'diagnostico_escaner', filename: 'scan.pdf' }, { kind: 'orden_firmada', filename: 'orden.pdf' },
    ], ['foto', 'diagnostico', 'orden_reparacion', 'factura']);
    expect(r.evidence_detected).toEqual(expect.arrayContaining(['foto', 'diagnostico', 'orden_reparacion']));
    expect(r.missing).toEqual([{ kind: 'factura', reason: 'el asesor no adjuntó evidencia de este tipo' }]);
    expect(r.source).toBe('metadata');
  });

  it('rechaza etiqueta desconocida, extensión que no corresponde, mime distinto, vacío y exceso de tamaño', () => {
    expect(validateFile({ kind: 'foto_marciana', filename: 'a.jpg' })).toMatch(/desconocida/);
    expect(validateFile({ kind: 'foto_tablero', filename: 'a.pdf' })).toMatch(/no es un tipo válido/);
    expect(validateFile({ kind: 'orden_firmada', filename: 'a.pdf', mime: 'image/png' })).toMatch(/no coincide/);
    expect(validateFile({ kind: 'orden_firmada', filename: 'a.pdf', size_bytes: 0 })).toMatch(/vacío/);
    expect(validateFile({ kind: 'orden_firmada', filename: 'a.pdf', size_bytes: 30 * 1024 * 1024 })).toMatch(/excede/);
    expect(validateFile({ kind: 'orden_firmada', filename: 'A.PDF', mime: 'application/pdf', size_bytes: 1000 })).toBeNull();
  });

  it('un archivo inválido no cuenta como presente y el motivo queda en el faltante', () => {
    const r = readEvidenceMetadata([{ kind: 'foto_tablero', filename: 'tablero.pdf' }], ['foto']);
    expect(r.evidence_detected).toEqual([]);
    expect(r.missing[0].reason).toMatch(/no es válido.*tablero\.pdf/);
    expect(r.notes[0]).toMatch(/Evidencia no válida/);
  });

  it('el mismo archivo con dos etiquetas solo cuenta una vez', () => {
    const sha = 'a'.repeat(64);
    const r = readEvidenceMetadata([{ kind: 'foto_tablero', filename: 'x.jpg', sha256: sha }, { kind: 'foto_pieza', filename: 'x.jpg', sha256: sha }, { kind: 'foto_vin', filename: 'v.jpg', sha256: 'b'.repeat(64) }], []);
    expect(r.evidence_detected).toContain('foto_tablero');
    expect(r.evidence_detected).not.toContain('foto_pieza');
    expect(r.notes.join(' ')).toMatch(/ya se usó como foto_tablero/);
  });

  it('no usa el contenido: el texto extraído no influye', () => {
    const r = readEvidenceMetadata([{ kind: 'foto_tablero', filename: 'a.jpg', text: 'diagnóstico OP-MT-031' } as any], ['diagnostico']);
    expect(r.missing).toHaveLength(1);
  });
});

describe('POST /prea/verify con evidencia etiquetada', () => {
  async function setup() {
    const g = await makeGroup('EVI');
    const app = await buildServer();
    const tok = async (_role: 'advisor') => signDevToken({ userId: g.advisorId, groupId: g.groupId, role: 'advisor', agencyId: g.agencyId });
    await getPool().query(
      `insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,severity,condition,origin,valid_from)
       values ($1,$2,'learned.diag',1,1,'active','required_evidence','Planta exige diagnóstico','warning',$3,'learned','2024-01-01')`,
      [g.groupId, g.brandId, JSON.stringify({ type: 'required_evidence', evidence_kind: 'diagnostico' })]);
    return { g, app, tok };
  }
  it('sin modelo: etiqueta válida cubre la regla; etiqueta con archivo inválido la deja pendiente con el motivo', async () => {
    const { g, app, tok } = await setup();
    const post = async (evidence: any[]) => (await app.inject({ method: 'POST', url: '/prea/verify', headers: { authorization: `Bearer ${await tok('advisor')}` },
      payload: { agency_id: g.agencyId, draft: { fields: { vin: 'V1' }, evidence } } })).json();
    const ok = await post([{ kind: 'diagnostico_escaner', filename: 'scan.pdf', mime: 'application/pdf' }]);
    expect(ok.findings).toHaveLength(0);
    expect(ok.reading.source).toBe('metadata');
    const bad = await post([{ kind: 'diagnostico_escaner', filename: 'scan.mp4' }]);
    expect(bad.findings.map((f: any) => f.rule_key)).toContain('learned.diag');
    expect(bad.findings.some((f: any) => /no es un tipo válido/.test(f.message))).toBe(true);
    const calls = await withTenant({ groupId: g.groupId }, c => c.query('select count(*)::int n from llm_calls'));
    expect(calls.rows[0].n).toBe(0);
  });
});
