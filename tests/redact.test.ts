import { describe, it, expect } from 'vitest';
import { redact, redactFields, hashRef } from '../src/ingest/redact.js';

describe('redact', () => {
  it('quita correos', () => expect(redact('escribir a juan.perez@gmail.com hoy').text).toBe('escribir a [EMAIL] hoy'));
  it('quita teléfonos en varios formatos', () => {
    for (const t of ['443 123 4567', '4431234567', '+52 443 123 4567', '(443) 123-4567', '55-1234-5678'])
      expect(redact(`llamar al ${t} por favor`).text, t).toBe('llamar al [TEL] por favor');
  });
  it('quita RFC y CURP', () => {
    expect(redact('RFC PEPJ800101AB3').text).toBe('RFC [RFC]');
    expect(redact('CURP PEPJ800101HMNRRN09').text).toBe('CURP [CURP]');
  });
  it('quita nombres tras disparadores y conserva el resto', () => {
    expect(redact('Cliente Juan Pérez López reporta ruido').text).toBe('Cliente [NOMBRE] reporta ruido');
    expect(redact('a nombre de María de la Cruz, unidad 2022').text).toContain('[NOMBRE]');
    expect(redact('Sr. Ortega indica falla').text).toBe('Sr. [NOMBRE] indica falla');
  });
  it('quita nombres conocidos aunque no haya disparador', () => {
    expect(redact('Hablé con Lucía Ortega ayer', { knownNames: ['Lucía Ortega'] }).text).toBe('Hablé con [NOMBRE] ayer');
  });
  it('quita placas', () => expect(redact('placas ABC-123-D').text).toBe('placas [PLACA]'));
  it('conserva VIN, piezas, operaciones, importes y km', () => {
    const s = 'VIN 3GNAXKEV5NL123456 PZ-MT-6120 OP-MT-031 $12,345.50 42,180 km folio 2024-0099 total 1840.00';
    expect(redact(s).text).toBe(s);
  });
  it('es idempotente', () => {
    const once = redact('Cliente Ana Ruiz tel 443 123 4567 ana@x.com').text;
    expect(redact(once).text).toBe(once);
  });
  it('redactFields respeta llaves protegidas', () => {
    const r = redactFields({ vin: '3GNAXKEV5NL123456', complaint_text: 'Cliente Pedro Gómez, 443 111 2222' });
    expect(r.vin).toBe('3GNAXKEV5NL123456');
    expect(r.complaint_text).toBe('Cliente [NOMBRE], [TEL]');
  });
  it('hashRef es estable y no contiene el nombre', () => {
    const h = hashRef('Lucía Ortega', 's');
    expect(h).toBe(hashRef('  lucía ortega ', 's'));
    expect(h).not.toMatch(/luc/i);
  });
});
