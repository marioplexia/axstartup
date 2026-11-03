import { SignJWT, jwtVerify } from 'jose';
import type { Role, Tenant } from './db/pool.js';

export interface Principal extends Tenant { userId: string; role: Role; agencyId?: string }

/**
 * Frontera de autenticación. El servidor solo conoce esta interfaz: valida un bearer token y devuelve el Principal
 * (usuario, grupo, rol y agencia). Hoy hay un proveedor de desarrollo; Supabase Auth se enchufa aquí sin tocar rutas.
 */
export interface AuthProvider {
  readonly name: string;
  verify(token: string): Promise<Principal>;
}

export class AuthConfigError extends Error { constructor(msg: string) { super(msg); this.name = 'AuthConfigError'; } }

export const isDevelopment = () => process.env.NODE_ENV === 'development';

const DEV_ISSUER = 'axai-dev';
const devSecret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET no está definido');
  return new TextEncoder().encode(s);
};
const assertDevelopment = (what: string) => {
  if (!isDevelopment()) throw new AuthConfigError(`${what} solo se permite con NODE_ENV=development (actual: ${process.env.NODE_ENV ?? 'sin definir'})`);
};

/** Tokens HS256 firmados con JWT_SECRET. SOLO desarrollo: fuera de NODE_ENV=development ni se emiten ni se aceptan. */
export class DevAuthProvider implements AuthProvider {
  readonly name = 'dev';
  constructor() { assertDevelopment('El proveedor de autenticación de desarrollo'); }
  async verify(token: string): Promise<Principal> {
    assertDevelopment('Aceptar tokens de desarrollo'); // se re-evalúa en cada llamada
    const { payload } = await jwtVerify(token, devSecret(), { algorithms: ['HS256'], issuer: DEV_ISSUER });
    const role = payload.role as Role;
    if (!payload.sub || !payload.group_id || !['advisor', 'reviewer', 'owner'].includes(role)) throw new Error('claims inválidos');
    return { userId: payload.sub, groupId: String(payload.group_id), role, agencyId: payload.agency_id ? String(payload.agency_id) : undefined };
  }
}

/**
 * PENDIENTE: Supabase Auth. Contrato esperado cuando se implemente: verificar el JWT de Supabase (JWKS de SUPABASE_URL o
 * SUPABASE_JWT_SECRET) y mapear a Principal desde `sub` y `app_metadata.{group_id, role, agency_id}` (no desde user_metadata,
 * que edita el usuario). Mientras tanto falla cerrado: no se puede construir.
 */
export class SupabaseAuthProvider implements AuthProvider {
  readonly name = 'supabase';
  constructor() { throw new AuthConfigError('Supabase Auth aún no está implementado; no hay forma de autenticar usuarios fuera de NODE_ENV=development'); }
  async verify(_token: string): Promise<Principal> { throw new AuthConfigError('Supabase Auth aún no está implementado'); }
}

/** AUTH_PROVIDER=dev|supabase. Por defecto: dev en development, supabase (que hoy falla cerrado) en cualquier otro entorno. */
export function makeAuthProvider(): AuthProvider {
  const choice = process.env.AUTH_PROVIDER ?? (isDevelopment() ? 'dev' : 'supabase');
  if (choice === 'dev') return new DevAuthProvider();
  if (choice === 'supabase') return new SupabaseAuthProvider();
  throw new AuthConfigError(`AUTH_PROVIDER desconocido: ${choice}`);
}

/** Emisor de tokens SOLO para desarrollo, pruebas y demo. En otros entornos lanza. */
export async function signDevToken(p: { userId: string; groupId: string; role: Role; agencyId?: string }, ttl = '2h') {
  assertDevelopment('Emitir tokens de desarrollo');
  return new SignJWT({ group_id: p.groupId, role: p.role, agency_id: p.agencyId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(DEV_ISSUER).setSubject(p.userId).setIssuedAt().setExpirationTime(ttl).sign(devSecret());
}
