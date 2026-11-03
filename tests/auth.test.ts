import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { DevAuthProvider, SupabaseAuthProvider, AuthConfigError, makeAuthProvider, signDevToken, type AuthProvider } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { closePool } from '../src/db/pool.js';

afterEach(() => vi.unstubAllEnvs());
afterAll(closePool);

const P = { userId: '00000000-0000-0000-0000-000000000001', groupId: '00000000-0000-0000-0000-000000000002', role: 'advisor' as const, agencyId: '00000000-0000-0000-0000-000000000003' };

describe('tokens de desarrollo', () => {
  it('con NODE_ENV=development se emiten y se aceptan', async () => {
    expect(process.env.NODE_ENV).toBe('development');
    const p = await new DevAuthProvider().verify(await signDevToken(P));
    expect(p).toMatchObject(P);
  });

  for (const env of ['production', 'test', 'staging', '']) {
    it(`NODE_ENV=${env || '(vacío)'}: no se emiten, no se aceptan y el proveedor no se construye`, async () => {
      const token = await signDevToken(P); // emitido legítimamente en development
      vi.stubEnv('NODE_ENV', env);
      await expect(signDevToken(P)).rejects.toThrow(AuthConfigError);
      expect(() => new DevAuthProvider()).toThrow(AuthConfigError);
      vi.stubEnv('NODE_ENV', 'development');
      const provider = new DevAuthProvider(); // construido en development…
      vi.stubEnv('NODE_ENV', env);
      await expect(provider.verify(token)).rejects.toThrow(AuthConfigError); // …pero igual rechaza al verificar fuera de él
    });
  }

  it('NODE_ENV sin definir tampoco los acepta', async () => {
    const token = await signDevToken(P);
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
    delete process.env.NODE_ENV;
    expect(() => new DevAuthProvider()).toThrow(AuthConfigError);
    await expect(signDevToken(P)).rejects.toThrow(/NODE_ENV=development/);
    void token;
  });

  it('un JWT firmado con el mismo secreto pero sin el emisor de desarrollo se rechaza', async () => {
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ group_id: P.groupId, role: 'owner' }).setProtectedHeader({ alg: 'HS256' }).setSubject('x').setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    await expect(new DevAuthProvider().verify(forged)).rejects.toThrow();
  });
});

describe('selección de proveedor', () => {
  it('en development usa el de desarrollo', () => expect(makeAuthProvider().name).toBe('dev'));
  it('fuera de development falla cerrado hasta que exista Supabase Auth', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => makeAuthProvider()).toThrow(/Supabase Auth aún no está implementado/);
    expect(() => new SupabaseAuthProvider()).toThrow(AuthConfigError);
  });
  it('AUTH_PROVIDER=dev no salta la restricción de entorno', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('AUTH_PROVIDER', 'dev');
    expect(() => makeAuthProvider()).toThrow(/NODE_ENV=development/);
  });
  it('AUTH_PROVIDER desconocido es error', () => {
    vi.stubEnv('AUTH_PROVIDER', 'magia');
    expect(() => makeAuthProvider()).toThrow(/desconocido/);
  });
});

describe('el servidor depende de la interfaz', () => {
  it('buildServer no arranca en producción sin proveedor real', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(buildServer()).rejects.toThrow(AuthConfigError);
  });

  it('acepta cualquier AuthProvider (p. ej. el futuro de Supabase) y no usa el de desarrollo', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fake: AuthProvider = { name: 'fake', verify: async t => { if (t !== 'tok-ok') throw new Error('no'); return { ...P, role: 'reviewer', agencyId: undefined }; } };
    const app = await buildServer({ auth: fake });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer malo' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer tok-ok' } })).statusCode).not.toBe(401);
    await app.close();
  });
});
