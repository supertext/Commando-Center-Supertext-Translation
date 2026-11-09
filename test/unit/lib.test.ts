import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, versionStatus } from '../../src/lib/semver';
import { createSession, readSession, verifySession } from '../../src/lib/auth';
import { RateLimiter, clientIp } from '../../src/lib/rate-limit';
import { databaseUrls } from '../../src/lib/db-url.mjs';
import { clearReleaseCache, latestRelease, releaseUrl, repoUrl } from '../../src/lib/releases';

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['0.9.0', '0.10.0', -1],
    ['v1.2.3', '1.2.3', 0],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0-beta', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['1.0.0+build.5', '1.0.0', 0],
  ])('%s vs %s', (a, b, want) => expect(compareVersions(a, b)).toBe(want));

  it('returns null for non-versions', () => {
    expect(compareVersions('dev-main', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', null)).toBeNull();
  });

  it('versionStatus', () => {
    expect(versionStatus('0.3.0', '0.4.0')).toBe('outdated');
    expect(versionStatus('0.4.0', '0.4.0')).toBe('current');
    expect(versionStatus('0.5.0', '0.4.0')).toBe('ahead');
    expect(versionStatus('0.4.0', null)).toBe('unknown');
  });
});

describe('auth', () => {
  const old = process.env.COMMANDO_SESSION_SECRET;
  beforeEach(() => {
    process.env.COMMANDO_SESSION_SECRET = 'x'.repeat(40);
  });
  afterEach(() => {
    if (old === undefined) delete process.env.COMMANDO_SESSION_SECRET;
    else process.env.COMMANDO_SESSION_SECRET = old;
  });

  it('signs and verifies sessions', () => {
    const s = createSession({ sub: '7', name: 'Ada Muster', email: 'ada@supertext.com' }, 1_000)!;
    expect(readSession(s.value, 2_000)).toEqual({ sub: '7', name: 'Ada Muster', email: 'ada@supertext.com' });
    expect(s.expires.getTime()).toBe(1_000 + 12 * 3600_000);
    expect(verifySession(s.value, s.expires.getTime() + 1)).toBe(false);
    const [v, body, mac] = s.value.split('.');
    const forged = Buffer.from(JSON.stringify({ via: 'oidc', sub: '1', exp: 9e15 })).toString('base64url');
    expect(verifySession(`${v}.${forged}.${mac}`, 2_000)).toBe(false);
    expect(verifySession(`${v}.${body}.x${mac}`, 2_000)).toBe(false);
    expect(verifySession('garbage', 2_000)).toBe(false);
    expect(verifySession(undefined, 2_000)).toBe(false);
  });

  it('needs COMMANDO_SESSION_SECRET of 32+ characters and signs out on a change', () => {
    const s = createSession({ sub: '7' }, 1_000)!;
    process.env.COMMANDO_SESSION_SECRET = 'y'.repeat(40);
    expect(readSession(s.value, 2_000)).toBeNull();
    process.env.COMMANDO_SESSION_SECRET = 'short';
    expect(createSession({ sub: '7' })).toBeNull();
  });

  it('refuses old password sessions', () => {
    const forged = Buffer.from(JSON.stringify({ via: 'password', exp: 9e15 })).toString('base64url');
    expect(readSession(`v2.${forged}.x`, 2_000)).toBeNull();
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window', () => {
    const r = new RateLimiter(2, 1000);
    expect([r.take('a', 0), r.take('a', 1), r.take('a', 2), r.take('b', 2)]).toEqual([true, true, false, true]);
    expect(r.take('a', 1001)).toBe(true);
  });

  it('reads the client IP', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('databaseUrls', () => {
  it('uses DATABASE_URL as is without COMMANDO_DB_NAME', () => {
    expect(databaseUrls({ DATABASE_URL: 'postgres://u:p@h:5432/railway' })).toEqual({
      url: 'postgres://u:p@h:5432/railway',
      adminUrl: null,
      name: null,
    });
  });

  it('switches to its own database on a shared server', () => {
    const r = databaseUrls({ DATABASE_URL: 'postgresql://u:p@h:5432/railway?sslmode=disable', COMMANDO_DB_NAME: 'commando' });
    expect(r.url).toBe('postgresql://u:p@h:5432/commando?sslmode=disable');
    expect(r.adminUrl).toBe('postgresql://u:p@h:5432/railway?sslmode=disable');
  });

  it('rejects unsafe names and a missing URL', () => {
    expect(() => databaseUrls({ DATABASE_URL: 'postgres://h/x', COMMANDO_DB_NAME: 'a"; DROP' })).toThrow();
    expect(() => databaseUrls({})).toThrow(/DATABASE_URL/);
  });
});

describe('latestRelease', () => {
  beforeEach(() => clearReleaseCache());

  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('takes the newest non-draft release, pre-releases included', async () => {
    const f = reply(200, [{ tag_name: 'v0.5.0', draft: true }, { tag_name: 'v0.4.0', prerelease: true }, { tag_name: 'v0.3.0' }]);
    expect(await latestRelease('X', f)).toBe('0.4.0');
  });

  it('caches the answer', async () => {
    const f = reply(200, [{ tag_name: 'v1.0.0' }]);
    await latestRelease('Y', f);
    await latestRelease('Y', f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns null without releases or on errors', async () => {
    expect(await latestRelease('A', reply(200, []))).toBeNull();
    expect(await latestRelease('B', reply(404, {}))).toBeNull();
    expect(await latestRelease('C', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });

  it('builds release links only for X.Y.Z versions', () => {
    expect(releaseUrl('Typo3-Supertext-Translation', '0.4.0')).toBe(
      'https://github.com/supertext/Typo3-Supertext-Translation/releases/tag/v0.4.0',
    );
    expect(releaseUrl('X', 'dev-main')).toBeNull();
  });
});

describe('repoUrl', () => {
  it('knows the WordPress plugin under its repository name', () => {
    expect(repoUrl('supertext-wordpress-polylang')).toBe('https://github.com/supertext/Wordpress-Polylang-Supertext-Translation');
    expect(releaseUrl('supertext-wordpress-polylang', '0.14.0')).toBe('https://github.com/supertext/Wordpress-Polylang-Supertext-Translation/releases/tag/v0.14.0');
  });
});
