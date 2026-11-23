import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sessions. Staff sign in with their Supertext account (OIDC against the Person Service, see
 * oidc.ts); there is no other way in.
 *
 * The cookie is "v2.<payload>.<hmac>", payload = base64url JSON of the session, signed with a
 * key derived from COMMANDO_SESSION_SECRET (changing it signs everyone out). The cookie holds
 * no token.
 */
export const SESSION_COOKIE = 'commando_session';
export const SESSION_HOURS = 12;

export interface SessionUser {
  /** Person Service subject. */
  sub: string;
  name?: string;
  email?: string;
}

interface Payload extends SessionUser {
  via: 'oidc';
  exp: number;
}

/** COMMANDO_SESSION_SECRET, at least 32 characters; signs the session and sign-in cookies. */
export function sessionSecret(): string | null {
  const s = process.env.COMMANDO_SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

/** The signing key for the session ("oidc") or the pending sign-in ("oidc-flow"), or null. */
export function signingKey(kind: 'oidc' | 'oidc-flow'): Buffer | null {
  const s = sessionSecret();
  return s ? createHash('sha256').update(`commando-${kind}:${s}`).digest() : null;
}

function same(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** Signs a JSON value as "v2.<payload>.<mac>". */
export function seal(key: Buffer, value: unknown): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `v2.${body}.${createHmac('sha256', key).update(`v2.${body}`).digest('base64url')}`;
}

/** The value sealed by seal(), or null if the format or signature is wrong. */
export function unseal(key: Buffer | null, sealed: string | undefined): unknown {
  if (!key || !sealed || sealed.length > 8192) return null;
  const [v, body, mac] = sealed.split('.');
  if (v !== 'v2' || !body || !mac) return null;
  if (!same(mac, createHmac('sha256', key).update(`v2.${body}`).digest('base64url'))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function createSession(user: SessionUser, now = Date.now()): { value: string; expires: Date } | null {
  const key = signingKey('oidc');
  if (!key || !user.sub) return null;
  const exp = now + SESSION_HOURS * 3600_000;
  const payload: Payload = { via: 'oidc', sub: user.sub.slice(0, 200), exp };
  if (user.name) payload.name = user.name.slice(0, 200);
  if (user.email) payload.email = user.email.slice(0, 200);
  return { value: seal(key, payload), expires: new Date(exp) };
}

/** The signed-in user, or null. */
export function readSession(value: string | undefined, now = Date.now()): SessionUser | null {
  const p = unseal(signingKey('oidc'), value) as Payload | null;
  if (!p || p.via !== 'oidc' || typeof p.sub !== 'string' || !p.sub || typeof p.exp !== 'number' || p.exp < now) return null;
  const user: SessionUser = { sub: p.sub };
  if (typeof p.name === 'string') user.name = p.name;
  if (typeof p.email === 'string') user.email = p.email;
  return user;
}

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  return readSession(value, now) !== null;
}
