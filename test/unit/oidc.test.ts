import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as signData, type JsonWebKey, type KeyObject } from 'node:crypto';
import {
  OidcError,
  authorizeUrl,
  checkIdToken,
  clearOidcCache,
  discover,
  displayName,
  endSessionUrl,
  finishSignIn,
  isStaff,
  newTransaction,
  oidcConfig,
  oidcProblem,
  publicBaseUrl,
  type Fetcher,
  type OidcConfig,
} from '../../src/lib/oidc';

const ISSUER = 'https://www.supertext.com/person';
const CLIENT = 'Supertext.PluginHealth';
const REDIRECT = 'https://commando.example/auth/callback';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk: JsonWebKey = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b(header)}.${b(claims)}`;
  return `${data}.${signData('sha256', Buffer.from(data), key).toString('base64url')}`;
}

const NOW = 1_800_000_000_000;
const base = (nonce: string) => ({ iss: ISSUER, aud: CLIENT, sub: '42', nonce, exp: NOW / 1000 + 300, iat: NOW / 1000 });

const cfg: OidcConfig = oidcConfig({
  COMMANDO_OIDC_ISSUER: `${ISSUER}/`,
  COMMANDO_OIDC_CLIENT_ID: CLIENT,
  COMMANDO_OIDC_ALLOWED_EMAILS: 'boss@partner.ch, @supertext.com',
} as unknown as NodeJS.ProcessEnv)!;

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: 'https://www.supertext.com/person/connect/authorize',
  token_endpoint: 'https://www.supertext.com/person/connect/token',
  userinfo_endpoint: 'https://www.supertext.com/person/connect/userinfo',
  end_session_endpoint: 'https://www.supertext.com/person/connect/endsession',
  jwks_uri: 'https://www.supertext.com/person/.well-known/openid-configuration/jwks',
};

interface Fake {
  fetcher: Fetcher;
  calls: { url: string; init: RequestInit }[];
}

function fakeIssuer(opts: { idToken: (nonce: string) => string; userinfo?: Record<string, unknown>; doc?: Record<string, unknown> }, nonce: string): Fake {
  const calls: Fake['calls'] = [];
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/.well-known/openid-configuration')) return json(opts.doc ?? discovery);
    if (url === discovery.jwks_uri) return json({ keys: [jwk] });
    if (url === discovery.token_endpoint) return json({ id_token: opts.idToken(nonce), access_token: 'at', token_type: 'Bearer' });
    if (url === discovery.userinfo_endpoint) return opts.userinfo ? json(opts.userinfo) : json({}, 500);
    return json({}, 404);
  };
  return { fetcher, calls };
}

beforeEach(() => clearOidcCache());

describe('oidc settings', () => {
  it('is off without issuer and client id', () => {
    expect(oidcConfig({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(oidcConfig({ COMMANDO_OIDC_ISSUER: ISSUER } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('defaults to the Administrator role and the custom.profile scope', () => {
    expect(cfg.issuer).toBe(ISSUER);
    expect(cfg.allowedRoles).toEqual(['administrator']);
    expect(cfg.scopes).toBe('openid profile email custom.profile');
    expect(cfg.clientSecret).toBeNull();
  });

  it('reports problems', () => {
    expect(oidcProblem(cfg, true)).toBeNull();
    expect(oidcProblem(cfg, false)).toMatch(/COMMANDO_SESSION_SECRET/);
    expect(oidcProblem({ ...cfg, issuer: 'http://evil.example' }, true)).toMatch(/https/);
    expect(oidcProblem({ ...cfg, allowedRoles: [], allowedEmails: [] }, true)).toMatch(/Nobody/);
    expect(oidcProblem({ ...cfg, scopes: 'profile' }, true)).toMatch(/openid/);
  });
});

describe('discovery', () => {
  it('refuses another issuer and endpoints on another origin', async () => {
    await expect(discover(cfg, fakeIssuer({ idToken: () => '', doc: { ...discovery, issuer: 'https://evil.example' } }, 'n').fetcher)).rejects.toThrow(/issuer/);
    clearOidcCache();
    await expect(
      discover(cfg, fakeIssuer({ idToken: () => '', doc: { ...discovery, token_endpoint: 'https://evil.example/token' } }, 'n').fetcher),
    ).rejects.toThrow(/token_endpoint/);
  });

  it('follows no redirects and caches the document', async () => {
    const f = fakeIssuer({ idToken: () => '' }, 'n');
    await discover(cfg, f.fetcher, NOW);
    await discover(cfg, f.fetcher, NOW + 1000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init.redirect).toBe('manual');
  });
});

describe('authorize URL', () => {
  it('uses PKCE S256, state and nonce', () => {
    const tx = newTransaction(NOW);
    const u = new URL(authorizeUrl(cfg, discovery, tx, REDIRECT));
    expect(u.origin + u.pathname).toBe(discovery.authorization_endpoint);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('state')).toBe(tx.state);
    expect(u.searchParams.get('nonce')).toBe(tx.nonce);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(tx.verifier).digest('base64url'));
    expect(u.searchParams.get('code_verifier')).toBeNull();
  });
});

describe('ID token', () => {
  const expectations = { issuer: ISSUER, clientId: CLIENT, nonce: 'n1' };

  it('accepts a valid token', () => {
    expect(checkIdToken(jwt(base('n1')), [jwk], expectations, NOW).sub).toBe('42');
  });

  it.each([
    ['another key', () => jwt(base('n1'), other), /signature/],
    ['alg none', () => jwt(base('n1'), privateKey, { alg: 'none' }), /algorithm/],
    ['HS256', () => jwt(base('n1'), privateKey, { alg: 'HS256', kid: 'k1' }), /algorithm/],
    ['an unknown kid', () => jwt(base('n1'), privateKey, { alg: 'RS256', kid: 'k2' }), /no key/],
    ['another issuer', () => jwt({ ...base('n1'), iss: 'https://evil.example' }), /issuer/],
    ['another audience', () => jwt({ ...base('n1'), aud: 'Other' }), /audience/],
    ['several audiences without azp', () => jwt({ ...base('n1'), aud: [CLIENT, 'Other'] }), /azp/],
    ['an expired token', () => jwt({ ...base('n1'), exp: NOW / 1000 - 600 }), /expired/],
    ['another nonce', () => jwt(base('n2')), /nonce/],
    ['no sub', () => jwt({ ...base('n1'), sub: '' }), /sub/],
  ])('refuses %s', (_name, token, error) => {
    expect(() => checkIdToken(token(), [jwk], expectations, NOW)).toThrow(error);
  });
});

describe('finishing the sign-in', () => {
  const params = (state: string) => ({ code: 'c0de', state, error: null });

  it('signs in staff with the Administrator role from userinfo', async () => {
    const tx = newTransaction(NOW);
    const f = fakeIssuer({ idToken: (n) => jwt({ ...base(n), email: 'ada@example.com' }), userinfo: { sub: '42', role: ['Customer', 'Administrator'], name: 'Ada Muster' } }, tx.nonce);
    const { claims } = await finishSignIn(cfg, tx, params(tx.state), REDIRECT, f.fetcher, NOW);
    expect(displayName(claims)).toBe('Ada Muster');
    const token = f.calls.find((c) => c.url === discovery.token_endpoint)!;
    const body = new URLSearchParams(String(token.init.body));
    expect(body.get('code_verifier')).toBe(tx.verifier);
    expect(body.get('redirect_uri')).toBe(REDIRECT);
    expect(body.get('client_secret')).toBeNull();
  });

  it('sends the client secret when one is set', async () => {
    const tx = newTransaction(NOW);
    const f = fakeIssuer({ idToken: (n) => jwt({ ...base(n), role: 'Administrator' }) }, tx.nonce);
    await finishSignIn({ ...cfg, clientSecret: 's3cret' }, tx, params(tx.state), REDIRECT, f.fetcher, NOW);
    const token = f.calls.find((c) => c.url === discovery.token_endpoint)!;
    expect(new URLSearchParams(String(token.init.body)).get('client_secret')).toBe('s3cret');
  });

  it('refuses customers', async () => {
    const tx = newTransaction(NOW);
    const f = fakeIssuer({ idToken: (n) => jwt({ ...base(n), role: 'Customer', email: 'someone@customer.ch' }) }, tx.nonce);
    await expect(finishSignIn(cfg, tx, params(tx.state), REDIRECT, f.fetcher, NOW)).rejects.toMatchObject({ kind: 'denied' });
  });

  it('ignores userinfo for another subject', async () => {
    const tx = newTransaction(NOW);
    const f = fakeIssuer({ idToken: (n) => jwt(base(n)), userinfo: { sub: '99', role: 'Administrator' } }, tx.nonce);
    await expect(finishSignIn(cfg, tx, params(tx.state), REDIRECT, f.fetcher, NOW)).rejects.toMatchObject({ kind: 'denied' });
  });

  it('refuses a wrong state, an old transaction and an error from the issuer', async () => {
    const tx = newTransaction(NOW);
    const f = fakeIssuer({ idToken: (n) => jwt({ ...base(n), role: 'Administrator' }) }, tx.nonce);
    await expect(finishSignIn(cfg, tx, params('other'), REDIRECT, f.fetcher, NOW)).rejects.toThrow(/state/);
    await expect(finishSignIn(cfg, tx, params(tx.state), REDIRECT, f.fetcher, NOW + 11 * 60_000)).rejects.toThrow(/too long/);
    await expect(finishSignIn(cfg, tx, { code: null, state: tx.state, error: 'access_denied' }, REDIRECT, f.fetcher, NOW)).rejects.toMatchObject({
      kind: 'denied',
    });
    expect(f.calls.some((c) => c.url === discovery.token_endpoint)).toBe(false);
  });
});

describe('staff rule', () => {
  it('matches roles case-insensitively and addresses or domains', () => {
    expect(isStaff(cfg, { role: 'administrator' })).toBe(true);
    expect(isStaff(cfg, { role: ['TeamAdmin'] })).toBe(false);
    expect(isStaff(cfg, { email: 'Ada@Supertext.com' })).toBe(true);
    expect(isStaff(cfg, { email: 'ada@supertext.com.evil.ch' })).toBe(false);
    expect(isStaff(cfg, { email: 'boss@partner.ch' })).toBe(true);
    expect(isStaff(cfg, { email: 'other@partner.ch' })).toBe(false);
    expect(isStaff(cfg, { email: 'ada@supertext.com', email_verified: false })).toBe(false);
    expect(isStaff(cfg, {})).toBe(false);
  });
});

describe('helpers', () => {
  it('builds the end-session URL', () => {
    const u = new URL(endSessionUrl(cfg, discovery, 'https://commando.example/login', 'idt')!);
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('https://commando.example/login');
    expect(u.searchParams.get('id_token_hint')).toBe('idt');
    expect(endSessionUrl(cfg, { ...discovery, end_session_endpoint: undefined }, 'x')).toBeNull();
  });

  it('finds the public URL', () => {
    const h = new Headers({ 'x-forwarded-host': 'commando.example', 'x-forwarded-proto': 'https', host: '10.0.0.5:8080' });
    expect(publicBaseUrl(h, {} as unknown as NodeJS.ProcessEnv)).toBe('https://commando.example');
    expect(publicBaseUrl(h, { COMMANDO_PUBLIC_URL: 'https://cc.supertext.com/' } as unknown as NodeJS.ProcessEnv)).toBe('https://cc.supertext.com');
  });

  it('OidcError carries its kind', () => {
    expect(new OidcError('denied', 'x').kind).toBe('denied');
  });
});
