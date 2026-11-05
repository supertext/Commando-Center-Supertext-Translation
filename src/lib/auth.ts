import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sessions. Staff sign in with their Supertext account (OIDC against the Person Service, see
 * oidc.ts); the shared password (COMMANDO_PASSWORD) is an optional fallback.
 *
 * The cookie is "v2.<payload>.<hmac>", payload = base64url JSON of the session. Each way of
 * signing in has its own key: password sessions are signed with a key derived from the
 * password (changing it signs those out), Supertext-account sessions with one derived from
 * COMMANDO_SESSION_SECRET (changing it signs those out). The cookie holds no token.
 */
export const SESSION_COOKIE = 'commando_session';
export const SESSION_DAYS = 14;
export const OIDC_SESSION_HOURS = 12;

export type SignInMethod = 'password' | 'oidc';

export interface SessionUser {
  via: SignInMethod;
  /** Person Service subject (OIDC only). */
  sub?: string;
  name?: string;
  email?: string;
}

interface Payload extends SessionUser {
  exp: number;
}

function password(): string | null {
  const p = process.env.COMMANDO_PASSWORD;
  return p && p.length >= 12 ? p : null;
}

export function passwordConfigured(): boolean {
  return password() !== null;
}

/** COMMANDO_SESSION_SECRET, at least 32 characters; signs Supertext-account sessions. */
export function sessionSecret(): string | null {
  const s = process.env.COMMANDO_SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

/** The signing key for one way of signing in, or null if that way isn't configured. */
export function signingKey(kind: SignInMethod | 'oidc-flow'): Buffer | null {
  if (kind === 'password') {
    const pw = password();
    return pw ? createHash('sha256').update(`commando-session:${pw}`).digest() : null;
  }
  const s = sessionSecret();
  return s ? createHash('sha256').update(`commando-${kind}:${s}`).digest() : null;
}

function same(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export function checkPassword(candidate: string): boolean {
  const pw = password();
  return pw !== null && same(candidate, pw);
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

function lifetimeMs(via: SignInMethod): number {
  return via === 'password' ? SESSION_DAYS * 24 * 3600_000 : OIDC_SESSION_HOURS * 3600_000;
}

export function createSession(user: SessionUser = { via: 'password' }, now = Date.now()): { value: string; expires: Date } | null {
  const key = signingKey(user.via);
  if (!key) return null;
  const exp = now + lifetimeMs(user.via);
  const payload: Payload = { via: user.via, exp };
  if (user.sub) payload.sub = user.sub.slice(0, 200);
  if (user.name) payload.name = user.name.slice(0, 200);
  if (user.email) payload.email = user.email.slice(0, 200);
  return { value: seal(key, payload), expires: new Date(exp) };
}

/** The signed-in user, or null. The method is read from the payload, then checked with that method's key. */
export function readSession(value: string | undefined, now = Date.now()): SessionUser | null {
  if (!value) return null;
  const body = value.split('.')[1];
  let via: unknown;
  try {
    via = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'))?.via;
  } catch {
    return null;
  }
  if (via !== 'password' && via !== 'oidc') return null;
  const p = unseal(signingKey(via), value) as Payload | null;
  if (!p || p.via !== via || typeof p.exp !== 'number' || p.exp < now) return null;
  const user: SessionUser = { via };
  if (typeof p.sub === 'string') user.sub = p.sub;
  if (typeof p.name === 'string') user.name = p.name;
  if (typeof p.email === 'string') user.email = p.email;
  return user;
}

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  return readSession(value, now) !== null;
}
