import { describe, it, expect } from 'vitest';
import { redact, redactDetailed, redactFields, toModelView, hashRef, vinLast6 } from '../src/redact/index.js';
import { COMMENTS } from './fixtures/comments.js';

const r = (s: string, names?: string[]) => redact(s, { knownNames: names }).text;

describe('redact: identificadores', () => {
  it('quita correos, también ofuscados', () => {
    expect(r('escribir a juan.perez@gmail.com hoy')).toBe('escribir a [EMAIL] hoy');
    expect(r('juan.perez (at) gmail.com')).toBe('[EMAIL]');
    expect(r('es juan arroba gmail punto com')).toBe('es [EMAIL]');
  });
  it('quita teléfonos de 10 dígitos en todos los formatos', () => {
    for (const t of ['443 123 4567', '4431234567', '+52 443 123 4567', '+52 1 443 123 4567', '(443) 123-4567', '443-123-4567',
      '443.123.4567', '55-1234-5678', '55 1234 5678', '044 443 123 4567', '045 55 1234 5678', '01 443 123 4567', '(44) 3123-9876', '+524431234567'])
      expect(r(`llamar al ${t} por favor`), t).toBe('llamar al [TEL] por favor');
  });
  it('quita teléfonos sin lada solo con palabra de contexto', () => {
    expect(r('tel 321 4567')).toBe('tel [TEL]');
    expect(r('Cel: 1234-5678')).toBe('Cel: [TEL]');
    expect(r('WhatsApp 3214567')).toBe('WhatsApp [TEL]');
    expect(r('llamar al 4567 1234')).toBe('llamar al [TEL]');
  });
  it('no confunde importes, km, folios ni piezas con teléfonos', () => {
    const s = 'total $1234567890.50 y 42,180 km folio 2024-0099 PZ-MT-6120 OP-MT-031 cantidad 3214567';
    expect(r(s)).toBe(s);
  });
  it('quita RFC (física y moral) y CURP, con o sin separadores y en minúsculas', () => {
    expect(r('RFC PEPJ800101AB3')).toBe('RFC [RFC]');
    expect(r('RFC pepj-800101-ab3')).toBe('RFC [RFC]');
    expect(r('empresa ABC800101XY1 sa de cv')).toBe('empresa [RFC] sa de cv');
    expect(r('CURP PEPJ800101HMNRRN09')).toBe('CURP [CURP]');
    expect(r('curp pepj800101hmnrrn09')).toBe('curp [CURP]');
  });
  it('quita clave de elector y CIC/OCR', () => {
    expect(r('clave RZCRAN90051516M600 ok')).toBe('clave [CLAVE_ELECTOR] ok');
    expect(r('clave de elector: RZCRAN90051516M600')).toContain('[CLAVE_ELECTOR]');
    expect(r('INE CIC 123456789012')).toContain('[CLAVE_ELECTOR]');
    expect(r('OCR 0123456789012')).toBe('OCR [CLAVE_ELECTOR]');
  });
  it('quita placas en formatos mexicanos', () => {
    for (const p of ['ABC-123-D', 'ABC-12-34', 'MXA-482-C', '123-ABC', 'A12-BCD', 'ABC 123 D', 'AB-12-345'])
      expect(r(`placas ${p} del auto`), p).toBe('placas [PLACA] del auto');
    expect(r('la placa abc1234 pendiente')).toBe('la placa [PLACA] pendiente');
  });
  it('no toma códigos técnicos por placa', () => {
    const s = 'DTC-1234 VIN-5678 PZ-MT-6120 OP-TR-210 P0300';
    expect(r(s)).toBe(s);
  });
});

describe('redact: domicilios', () => {
  it('calle, número, interior, colonia y CP', () => {
    expect(r('vive en Calle Benito Juárez #123 Int. 4, Col. Centro, C.P. 58000')).toBe('vive en [DOMICILIO], [DOMICILIO], [CP]');
    expect(r('Av. Universidad 1500 Fracc. Los Pinos CP 60600')).toBe('[DOMICILIO] [DOMICILIO] [CP]');
    expect(r('Blvd. García de León No. 45, Colonia Las Américas')).toBe('[DOMICILIO], [DOMICILIO]');
    expect(r('CALLE 5 DE MAYO NUM 20, COL. CENTRO')).toBe('[DOMICILIO], [DOMICILIO]');
    expect(r('código postal 58000')).toBe('[CP]');
  });
  it('no toca ciudades ni palabras comunes', () => {
    const s = 'La unidad llegó a Morelia y el camino estaba bloqueado; col de escape dañada';
    expect(r(s)).toBe(s);
  });
  it('no se come el siguiente disparador de nombre', () => {
    expect(r('Calle Hidalgo 12 Cliente Pedro Gómez')).toBe('[DOMICILIO] Cliente [NOMBRE]');
  });
});

describe('redact: nombres', () => {
  it('quita nombres tras disparadores y conserva el resto', () => {
    expect(r('Cliente Juan Pérez López reporta ruido')).toBe('Cliente [NOMBRE] reporta ruido');
    expect(r('a nombre de María de la Cruz, unidad 2022')).toContain('[NOMBRE]');
    expect(r('Sr. Ortega indica falla')).toBe('Sr. [NOMBRE] indica falla');
    expect(r('Cliente: LUIS ENRIQUE VARGAS TORRES')).toBe('Cliente: [NOMBRE]');
    expect(r('Saludos, Marcela Quiroz')).toBe('Saludos, [NOMBRE]');
    expect(r('el técnico Ricardo Soto revisó')).toContain('[NOMBRE]');
  });
  it('quita nombres conocidos aunque no haya disparador', () => {
    expect(r('Hablé con Lucía Ortega ayer', ['Lucía Ortega'])).toBe('Hablé con [NOMBRE] ayer');
  });
});

describe('redact: VIN', () => {
  it('en texto libre deja solo los últimos 6', () => {
    const o = r('VIN 3GNAXKEV5NL123456 con ruido');
    expect(o).toBe('VIN [VIN …123456] con ruido');
    expect(o).not.toContain('3GNAXKEV5NL');
  });
  it('no confunde códigos largos solo-letras o solo-dígitos', () => {
    const s = 'ABCDEFGHJKLMNPRST 12345678901234567';
    expect(r(s)).toBe(s);
  });
  it('toModelView sustituye el VIN por últimos 6 + hash y no incluye el VIN completo', () => {
    const v = toModelView({ vin: '3GNAXKEV5NL123456', odometer: 42180, work_op: 'OP-MT-031' });
    expect(v.vin).toBe('…123456');
    expect(String(v.vin_hash)).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(v)).not.toContain('3GNAXKEV5NL');
    expect(v.work_op).toBe('OP-MT-031');
    expect(vinLast6('3gnaxkev5nl123456')).toBe('123456');
  });
});

describe('redact: general', () => {
  it('conserva piezas, operaciones, importes y km', () => {
    const s = 'PZ-MT-6120 OP-MT-031 $12,345.50 42,180 km folio 2024-0099 total 1840.00';
    expect(r(s)).toBe(s);
  });
  it('es idempotente', () => {
    for (const c of COMMENTS) { const once = r(c.text, c.names); expect(r(once, c.names), c.name).toBe(once); }
  });
  it('redactFields respeta el VIN (almacenamiento privado) y reemplaza campos de cliente completos', () => {
    const f = redactFields({ vin: '3GNAXKEV5NL123456', complaint_text: 'Cliente Pedro Gómez, 443 111 2222', customer_name: 'Pedro Gómez',
      customer_phone: '4431112222', correo_cliente: 'p@x.com', domicilio: 'Hidalgo 5', placas: 'ABC-123-D', codigo_postal: '58000', nombre_pieza: 'Tensor' });
    expect(f).toMatchObject({ vin: '3GNAXKEV5NL123456', complaint_text: 'Cliente [NOMBRE], [TEL]', customer_name: '[NOMBRE]', customer_phone: '[TEL]',
      correo_cliente: '[EMAIL]', domicilio: '[DOMICILIO]', placas: '[PLACA]', codigo_postal: '[CP]', nombre_pieza: 'Tensor' });
  });
  it('hashRef es estable y no contiene el nombre', () => {
    const h = hashRef('Lucía Ortega', 's');
    expect(h).toBe(hashRef('  lucía ortega ', 's'));
    expect(h).not.toMatch(/luc/i);
  });
  it('reporta qué quitó, con etiqueta y original', () => {
    const d = redactDetailed('Cliente Ana Ruiz tel 443 123 4567 ana@x.com');
    expect(d.counts).toEqual({ EMAIL: 1, TEL: 1, NOMBRE: 1 });
    expect(d.findings.map(f => f.original).sort()).toEqual(['Ana Ruiz', '443 123 4567', 'ana@x.com'].sort());
  });
});

describe('redact: comentarios ficticios planta ↔ asesor', () => {
  for (const c of COMMENTS) {
    it(c.name, () => {
      const out = r(c.text, c.names);
      for (const p of c.pii) expect(out, `sobrevive: ${p}`).not.toContain(p);
      for (const k of c.keep) expect(out, `se perdió: ${k}`).toContain(k);
    });
  }
});

import { sealForModel, isSealed, RedactionRequiredError } from '../src/redact/index.js';
import { buildReport, formatReport } from '../src/redact/report.js';
import { makeLlm } from '../src/llm/client.js';
import { z } from 'zod';

describe('bloqueo del modo live', () => {
  it('sealForModel rechaza payloads con datos personales o VIN completo, sin copiar el texto al mensaje', () => {
    expect(() => sealForModel({ comment: 'llamar al 443 123 4567' })).toThrow(RedactionRequiredError);
    expect(() => sealForModel({ fields: { vin: '3GNAXKEV5NL123456' } })).toThrow(/VIN/);
    try { sealForModel({ a: ['x', 'ana@x.com'] }); } catch (e) { expect((e as Error).message).not.toContain('ana@x.com'); expect((e as Error).message).toContain('$.a[1]'); }
  });
  it('un payload redactado se sella y queda congelado', () => {
    const p = sealForModel({ comment: r('Cliente Ana Ruiz 443 123 4567'), fields: toModelView({ vin: '3GNAXKEV5NL123456' }) });
    expect(isSealed(p)).toBe(true);
    expect(Object.isFrozen(p)).toBe(true);
  });
  it('el cliente live no llama a la API con un payload sin sellar', async () => {
    const prev = { m: process.env.LLM_MODE, k: process.env.ANTHROPIC_API_KEY };
    process.env.LLM_MODE = 'live'; process.env.ANTHROPIC_API_KEY = 'sk-no-se-usa';
    try {
      const llm = makeLlm();
      const S = z.object({ cause_code: z.string() });
      await expect(llm.run('rejection-classifier', 'rejection-classifier.v1.md', { comment: 'texto crudo' }, S)).rejects.toThrow(RedactionRequiredError);
      // sellado pero sin red: llega a la llamada (falla por red/clave, NO por redacción)
    } finally { process.env.LLM_MODE = prev.m; if (prev.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev.k; }
  });
});

describe('redact:report', () => {
  it('lista qué se quitó por línea y cuenta por etiqueta', () => {
    const rep = buildReport(COMMENTS.slice(0, 2).map(c => c.text).join('\n'), 'text');
    expect(rep.items).toHaveLength(2);
    expect(rep.counts.TEL).toBeGreaterThanOrEqual(2);
    expect(rep.residual).toEqual([]);
    const md = formatReport(rep, 'x.txt');
    expect(md).toContain('→ [TEL]');
    expect(md).toContain('Sin residuos');
  });
  it('recorre JSON anidado con rutas', () => {
    const rep = buildReport(JSON.stringify({ prea: { comments: [{ body: 'Cliente Ana Ruiz' }, { body: 'sin datos' }] } }), 'json');
    expect(rep.items.map(i => i.where)).toEqual(['$.prea.comments[0].body']);
  });
});
