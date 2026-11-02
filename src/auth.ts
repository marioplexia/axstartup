import { SignJWT, jwtVerify } from 'jose';
import type { Role, Tenant } from './db/pool.js';

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET no está definido');
  return new TextEncoder().encode(s);
};

export interface Principal extends Tenant { userId: string; role: Role; agencyId?: string }

export async function verifyToken(token: string): Promise<Principal> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
  const role = payload.role as Role;
  if (!payload.sub || !payload.group_id || !['advisor', 'reviewer', 'owner'].includes(role)) throw new Error('claims inválidos');
  return { userId: payload.sub, groupId: String(payload.group_id), role, agencyId: payload.agency_id ? String(payload.agency_id) : undefined };
}

/** Emisor de tokens SOLO para pruebas/demo. En producción los emite Supabase Auth con los mismos claims. */
export async function signDevToken(p: { userId: string; groupId: string; role: Role; agencyId?: string }, ttl = '2h') {
  return new SignJWT({ group_id: p.groupId, role: p.role, agency_id: p.agencyId })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(p.userId).setIssuedAt().setExpirationTime(ttl).sign(secret());
}
