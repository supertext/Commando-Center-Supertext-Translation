/**
 * Sign-in with a Supertext account: OpenID Connect against Supertext's Person Service
 * (IdentityServer, issuer https://www.supertext.com/person). Authorization code flow with
 * PKCE (S256), state and nonce; the ID token is checked against the issuer's JWKS (RS256/ES256,
 * iss, aud, azp, exp, nonce). Only staff get in: a role from COMMANDO_OIDC_ALLOWED_ROLES
 * (default "Administrator", the Person Service's role for Supertext staff) or an address or
 * domain from COMMANDO_OIDC_ALLOWED_EMAILS.
 *
 * Outgoing requests go only to the configured issuer: https (http only for localhost), every
 * endpoint on the issuer's origin, no redirects followed, 10 s timeout, 256 KB per answer.
 * Codes, tokens and e-mail addresses are never logged.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { APP_REPO, APP_VERSION } from './version';

export const DEFAULT_SCOPES = 'openid profile email custom.profile';
export const DEFAULT_ROLES = 'Administrator';
export const TIMEOUT_MS = 10_000;
export const MAX_BYTES = 256 * 1024;
const CLOCK_SKEW_S = 120;
const CACHE_MS = 3600_000;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  scopes: string;
  allowedRoles: string[];
  allowedEmails: string[];
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

export type Claims = Record<string, unknown>;

export class OidcError extends Error {
  constructor(
    /** "denied": not staff; "failed": anything else (shown generically). */
    readonly kind: 'denied' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function allowedUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u;
  return null;
}

/** The OIDC settings, or null when sign-in with a Supertext account isn't set up. */
export function oidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.COMMANDO_OIDC_ISSUER?.trim();
  const clientId = env.COMMANDO_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  return {
    issuer: trimSlash(issuer),
    clientId,
    clientSecret: env.COMMANDO_OIDC_CLIENT_SECRET?.trim() || null,
    scopes: env.COMMANDO_OIDC_SCOPES?.trim() || DEFAULT_SCOPES,
    allowedRoles: list(env.COMMANDO_OIDC_ALLOWED_ROLES, DEFAULT_ROLES).map((r) => r.toLowerCase()),
    allowedEmails: list(env.COMMANDO_OIDC_ALLOWED_EMAILS, '').map((e) => e.toLowerCase()),
  };
}

/** What's wrong with the OIDC settings (shown on the login page), or null. */
export function oidcProblem(cfg: OidcConfig | null, sessionSecretSet: boolean): string | null {
  if (!cfg) return null;
  if (!allowedUrl(cfg.issuer)) return 'COMMANDO_OIDC_ISSUER must be an https URL.';
  if (!sessionSecretSet) return 'COMMANDO_SESSION_SECRET is missing or shorter than 32 characters.';
  if (!cfg.scopes.split(' ').includes('openid')) return 'COMMANDO_OIDC_SCOPES must include openid.';
  if (cfg.allowedRoles.length === 0 && cfg.allowedEmails.length === 0)
    return 'Nobody is allowed: set COMMANDO_OIDC_ALLOWED_ROLES or COMMANDO_OIDC_ALLOWED_EMAILS.';
  return null;
}

// ---- HTTP to the issuer ------------------------------------------------------------------

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const USER_AGENT = `Supertext-Commando-Center/${APP_VERSION} (+${APP_REPO})`;

async function getJson(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetcher(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
  });
  const text = await readCapped(res);
  if (!res.ok) throw new OidcError('failed', `HTTP ${res.status} from ${new URL(url).pathname}`);
  try {
    const json: unknown = JSON.parse(text);
    if (json && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new OidcError('failed', `no JSON from ${new URL(url).pathname}`);
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new OidcError('failed', 'answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** An endpoint from the discovery document: must be on the issuer's origin. */
function endpoint(cfg: OidcConfig, value: unknown, name: string, required: true): string;
function endpoint(cfg: OidcConfig, value: unknown, name: string, required: false): string | undefined;
function endpoint(cfg: OidcConfig, value: unknown, name: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  const u = typeof value === 'string' ? allowedUrl(value) : null;
  if (!u || u.origin !== new URL(cfg.issuer).origin) throw new OidcError('failed', `discovery: ${name} not on the issuer's origin`);
  return u.toString();
}

let discoveryCache: { key: string; at: number; doc: Discovery } | null = null;
let jwksCache: { key: string; at: number; keys: JsonWebKey[] } | null = null;

export function clearOidcCache(): void {
  discoveryCache = null;
  jwksCache = null;
}

export async function discover(cfg: OidcConfig, fetcher: Fetcher = fetch, now = Date.now()): Promise<Discovery> {
  if (discoveryCache && discoveryCache.key === cfg.issuer && now - discoveryCache.at < CACHE_MS) return discoveryCache.doc;
  if (!allowedUrl(cfg.issuer)) throw new OidcError('failed', 'issuer must be https');
  const raw = await getJson(fetcher, `${cfg.issuer}/.well-known/openid-configuration`);
  if (typeof raw.issuer !== 'string' || trimSlash(raw.issuer) !== cfg.issuer) throw new OidcError('failed', 'discovery: issuer mismatch');
  const doc: Discovery = {
    issuer: raw.issuer,
    authorization_endpoint: endpoint(cfg, raw.authorization_endpoint, 'authorization_endpoint', true),
    token_endpoint: endpoint(cfg, raw.token_endpoint, 'token_endpoint', true),
    jwks_uri: endpoint(cfg, raw.jwks_uri, 'jwks_uri', true),
    userinfo_endpoint: endpoint(cfg, raw.userinfo_endpoint, 'userinfo_endpoint', false),
    end_session_endpoint: endpoint(cfg, raw.end_session_endpoint, 'end_session_endpoint', false),
  };
  discoveryCache = { key: cfg.issuer, at: now, doc };
  return doc;
}

async function jwks(doc: Discovery, fetcher: Fetcher, now: number, refresh: boolean): Promise<JsonWebKey[]> {
  if (!refresh && jwksCache && jwksCache.key === doc.jwks_uri && now - jwksCache.at < CACHE_MS) return jwksCache.keys;
  const raw = await getJson(fetcher, doc.jwks_uri);
  const keys = Array.isArray(raw.keys) ? (raw.keys as JsonWebKey[]) : [];
  jwksCache = { key: doc.jwks_uri, at: now, keys };
  return keys;
}

// ---- The flow ----------------------------------------------------------------------------

export interface Transaction {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
}

export const TRANSACTION_MINUTES = 10;

export function newTransaction(now = Date.now()): Transaction {
  const r = () => randomBytes(32).toString('base64url');
  return { state: r(), nonce: r(), verifier: r(), exp: now + TRANSACTION_MINUTES * 60_000 };
}

export function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function authorizeUrl(cfg: OidcConfig, doc: Discovery, tx: Transaction, redirectUri: string): string {
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('state', tx.state);
  u.searchParams.set('nonce', tx.nonce);
  u.searchParams.set('code_challenge', challenge(tx.verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

function decodePart(part: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new OidcError('failed', 'id_token is not a JWT');
}

const ALGORITHMS: Record<string, { hash: string; kty: string; ec?: boolean }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  ES256: { hash: 'sha256', kty: 'EC', ec: true },
  ES384: { hash: 'sha384', kty: 'EC', ec: true },
};

/** Checks the ID token's signature and claims; returns its claims. */
export function checkIdToken(
  token: string,
  keys: JsonWebKey[],
  expect: { issuer: string; clientId: string; nonce: string },
  now = Date.now(),
): Claims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('failed', 'id_token is not a JWT');
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const alg = ALGORITHMS[String(header.alg)];
  if (!alg) throw new OidcError('failed', `id_token algorithm ${String(header.alg)} not accepted`);
  const candidates = keys.filter(
    (k) => k.kty === alg.kty && (k.use === undefined || k.use === 'sig') && (header.kid === undefined || k.kid === header.kid),
  );
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  const ok = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      return verifySignature(alg.hash, data, alg.ec ? { key, dsaEncoding: 'ieee-p1363' } : key, sig);
    } catch {
      return false;
    }
  });
  if (!ok) throw new OidcError('failed', candidates.length ? 'id_token signature invalid' : 'no key for the id_token');

  const s = Math.floor(now / 1000);
  if (typeof claims.iss !== 'string' || trimSlash(claims.iss) !== expect.issuer) throw new OidcError('failed', 'id_token issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.clientId)) throw new OidcError('failed', 'id_token audience mismatch');
  if (aud.length > 1 && claims.azp !== expect.clientId) throw new OidcError('failed', 'id_token azp mismatch');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < s) throw new OidcError('failed', 'id_token expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > s) throw new OidcError('failed', 'id_token issued in the future');
  if (claims.nonce !== expect.nonce) throw new OidcError('failed', 'id_token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new OidcError('failed', 'id_token has no sub');
  return claims;
}

export interface SignedIn {
  claims: Claims;
  idToken: string;
}

/** Exchanges the code, checks the ID token, adds the userinfo claims and checks the staff rule. */
export async function finishSignIn(
  cfg: OidcConfig,
  tx: Transaction,
  params: { code: string | null; state: string | null; error: string | null },
  redirectUri: string,
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<SignedIn> {
  if (params.error) throw new OidcError(params.error === 'access_denied' ? 'denied' : 'failed', `issuer answered ${params.error.slice(0, 60)}`);
  if (!params.state || params.state !== tx.state) throw new OidcError('failed', 'state mismatch');
  if (tx.exp < now) throw new OidcError('failed', 'sign-in took too long');
  if (!params.code) throw new OidcError('failed', 'no code');

  const doc = await discover(cfg, fetcher, now);
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: tx.verifier,
  });
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  const tokens = await getJson(fetcher, doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (typeof tokens.id_token !== 'string') throw new OidcError('failed', 'no id_token');
  const expect = { issuer: cfg.issuer, clientId: cfg.clientId, nonce: tx.nonce };
  let claims: Claims;
  try {
    claims = checkIdToken(tokens.id_token, await jwks(doc, fetcher, now, false), expect, now);
  } catch (e) {
    // The issuer may have rotated its keys: fetch them once more.
    if (!(e instanceof OidcError) || !/key|signature/.test(e.message)) throw e;
    claims = checkIdToken(tokens.id_token, await jwks(doc, fetcher, now, true), expect, now);
  }

  if (doc.userinfo_endpoint && typeof tokens.access_token === 'string') {
    try {
      const info = await getJson(fetcher, doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (info.sub === claims.sub) claims = { ...info, ...claims, role: mergeRoles(claims.role, info.role) };
    } catch {
      // The ID token's claims are enough when userinfo doesn't answer.
    }
  }

  if (!isStaff(cfg, claims)) throw new OidcError('denied', 'not allowed by the staff rule');
  return { claims, idToken: tokens.id_token };
}

function asList(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function mergeRoles(a: unknown, b: unknown): string[] {
  return [...new Set([...asList(a), ...asList(b)])];
}

/** Staff: one of the allowed roles, or an allowed address or @domain. */
export function isStaff(cfg: OidcConfig, claims: Claims): boolean {
  const roles = asList(claims.role).map((r) => r.toLowerCase());
  if (roles.some((r) => cfg.allowedRoles.includes(r))) return true;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || claims.email_verified === false) return false;
  const domain = email.slice(email.lastIndexOf('@'));
  return cfg.allowedEmails.some((e) => (e.startsWith('@') ? e === domain : e === email));
}

/** Name to show in the header. */
export function displayName(claims: Claims): string | undefined {
  const pick = (k: string) => (typeof claims[k] === 'string' && (claims[k] as string).trim()) || undefined;
  const full = [pick('given_name'), pick('family_name')].filter(Boolean).join(' ');
  return pick('display_name') ?? pick('name') ?? (full || undefined) ?? pick('preferred_username') ?? pick('email');
}

/** Where the issuer should send people after signing out, or null. */
export function endSessionUrl(cfg: OidcConfig, doc: Discovery, postLogout: string, idToken?: string): string | null {
  if (!doc.end_session_endpoint) return null;
  const u = new URL(doc.end_session_endpoint);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('post_logout_redirect_uri', postLogout);
  if (idToken) u.searchParams.set('id_token_hint', idToken);
  return u.toString();
}

/** The center's public base URL: COMMANDO_PUBLIC_URL, else from the proxy's forwarded headers. */
export function publicBaseUrl(headers: Headers, env: NodeJS.ProcessEnv = process.env): string {
  const set = env.COMMANDO_PUBLIC_URL?.trim();
  if (set) return trimSlash(set);
  const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost').split(',')[0].trim();
  const proto = (headers.get('x-forwarded-proto') ?? (env.NODE_ENV === 'production' ? 'https' : 'http')).split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}
