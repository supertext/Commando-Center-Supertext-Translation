// Needs a Postgres server: TEST_DATABASE_URL (default postgres://postgres:postgres@127.0.0.1:5432/postgres).
// Each run drops and recreates the database commando_test on it, applies the migrations and
// exercises the store and the report endpoint.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import examples from '../../spec/report-examples.json';

const SERVER = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const NAME = 'commando_test';

let store: typeof import('../../src/lib/db');
let route: typeof import('../../src/app/api/v1/report/route');

beforeAll(async () => {
  const admin = postgres(SERVER, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  await admin.end();
  process.env.DATABASE_URL = SERVER;
  // No real pings from tests: the spec example's endpoint host maps to a reserved address (refused offline).
  process.env.COMMANDO_PING_HOSTS = 'www.example.ch=192.0.2.1';
  process.env.COMMANDO_DB_NAME = NAME;
  // Twice: the second run must be a no-op.
  for (let i = 0; i < 2; i++) {
    execFileSync('node', ['scripts/migrate.mjs'], { env: process.env, stdio: 'pipe' });
  }
  store = await import('../../src/lib/db');
  route = await import('../../src/app/api/v1/report/route');
});

afterAll(async () => {
  await store?.db().end();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return route.POST(
    new Request('http://center.test/api/v1/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const base = {
  schema: 1,
  event: 'installed',
  site_url: 'https://www.kunde.ch/',
  plugin: { name: 'supertext-wordpress-polylang', version: '2.0.0' },
  system: { name: 'WordPress', version: '6.8.3' },
  runtime: { name: 'PHP', version: '8.3.12' },
  api_key_configured: false,
};

describe('report endpoint and store', () => {
  it('creates an installation from the first report', async () => {
    const res = await post(base);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const [i] = await store.listInstallations();
    expect(i).toMatchObject({
      site_url: 'https://www.kunde.ch',
      plugin: 'supertext-wordpress-polylang',
      plugin_version: '2.0.0',
      system_version: '6.8.3',
      last_event: 'installed',
      report_count: 1,
      client_id: null,
    });
  });

  it('a settings save without changes adds history but no change', async () => {
    await post({ ...base, event: 'settings_saved', site_url: 'HTTPS://WWW.KUNDE.CH' });
    const [i] = await store.listInstallations();
    expect(i.report_count).toBe(2);
    const h = await store.installationHistory(i.id);
    expect(h.map((r) => [r.event, r.changed])).toEqual([
      ['settings_saved', false],
      ['installed', true],
    ]);
  });

  it('records a system upgrade (WordPress 6.8.3 → 6.9.0) as a change', async () => {
    await post({ ...base, event: 'upgraded', system: { name: 'WordPress', version: '6.9.0' }, api_key_configured: true });
    const [i] = await store.listInstallations();
    expect(i).toMatchObject({ system_version: '6.9.0', last_event: 'upgraded', api_key_configured: true, report_count: 3 });
    const [latest] = await store.installationHistory(i.id);
    expect(latest).toMatchObject({ event: 'upgraded', system_version: '6.9.0', changed: true });
  });

  it('keeps the same URL with another plugin as a separate installation', async () => {
    await post({ ...base, plugin: { name: 'Typo3-Supertext-Translation', version: '0.4.0' }, system: { name: 'TYPO3' } });
    expect(await store.listInstallations()).toHaveLength(2);
    expect(await store.listPlugins()).toEqual(['supertext-wordpress-polylang', 'Typo3-Supertext-Translation']);
  });

  it('hides local hosts unless asked', async () => {
    await post({ ...base, site_url: 'http://localhost:8080/' });
    expect(await store.listInstallations()).toHaveLength(2);
    expect(await store.listInstallations({ includeLocal: true })).toHaveLength(3);
  });

  it('accepts every valid example and rejects every invalid one', async () => {
    for (const ex of examples.valid) expect((await post(ex.body, { 'x-forwarded-for': '198.51.100.8' })).status, ex.name).toBe(202);
    for (const ex of examples.invalid) expect((await post(ex.body, { 'x-forwarded-for': '198.51.100.8' })).status, ex.name).toBe(400);
  });

  it('rejects non-JSON, oversized bodies and floods', async () => {
    expect((await post('not json', { 'x-forwarded-for': '198.51.100.9' })).status).toBe(400);
    expect((await post(base, { 'content-type': 'text/plain', 'x-forwarded-for': '198.51.100.9' })).status).toBe(415);
    const big = { ...base, padding: 'x'.repeat(9000) };
    expect((await post(big, { 'x-forwarded-for': '198.51.100.9' })).status).toBe(413);
    const statuses: number[] = [];
    for (let k = 0; k < 62; k++) statuses.push((await post(base, { 'x-forwarded-for': '198.51.100.10' })).status);
    expect(statuses.slice(0, 60).every((s) => s === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  describe('named API keys', () => {
    const site = { ...base, site_url: 'https://wp.example.ch', plugin: { name: 'supertext-wordpress-polylang', version: '2.1.0' }, system: { name: 'WordPress' } };
    const ip = { 'x-forwarded-for': '198.51.100.30' };
    const find = async () => (await store.listInstallations({ q: 'wp.example.ch' }))[0];
    const t1 = new Date(Date.now() - 120_000).toISOString();
    const t2 = new Date(Date.now() - 60_000).toISOString();

    it('stores every key and the worst status as the summary', async () => {
      await post(
        {
          ...site,
          event: 'settings_saved',
          api_keys: [
            { name: 'AI translation', configured: true, check: { status: 'ok', checked_at: t1, http_status: 200 } },
            { name: 'Professional orders', configured: true, check: { status: 'invalid', checked_at: t1, http_status: 401 } },
          ],
        },
        ip,
      );
      const i = await find();
      expect(i.api_key_status).toBe('invalid');
      expect(i.api_key_configured).toBe(true);
      expect(i.api_keys?.map((k) => [k.name, k.status])).toEqual([
        ['AI translation', 'ok'],
        ['Professional orders', 'invalid'],
      ]);
      expect((await store.listInstallations({ keyStatus: 'problem' })).some((x) => x.id === i.id)).toBe(true);
    });

    it('keeps a newer stored check per key and records the change', async () => {
      await post(
        {
          ...site,
          event: 'api_key_check',
          api_keys: [
            { name: 'AI translation', configured: true },
            { name: 'Professional orders', configured: true, check: { status: 'ok', checked_at: t2, http_status: 200 } },
          ],
        },
        ip,
      );
      const i = await find();
      expect(i.api_keys?.map((k) => [k.name, k.status])).toEqual([
        ['AI translation', 'ok'],
        ['Professional orders', 'ok'],
      ]);
      expect(i.api_key_status).toBe('ok');
      const [last] = await store.installationHistory(i.id);
      expect(last.changed).toBe(true);
      expect(last.api_keys?.map((k) => k.status)).toEqual([null, 'ok']);
    });
  });

  describe('API key check', () => {
    const site = { ...base, site_url: 'https://keys.example.ch', plugin: { name: 'Strapi-Supertext-Translation', version: '0.2.0' }, system: { name: 'Strapi' } };
    const ip = { 'x-forwarded-for': '198.51.100.20' };
    const find = async () => (await store.listInstallations({ q: 'keys.example.ch' }))[0];

    it('stores the check result of a settings save', async () => {
      const t = new Date(Date.now() - 60_000).toISOString();
      await post({ ...site, event: 'settings_saved', api_key_check: { status: 'ok', checked_at: t, http_status: 200 } }, ip);
      expect(await find()).toMatchObject({ api_key_status: 'ok', api_key_http_status: 200, api_key_error_code: null });
      expect((await find()).api_key_checked_at?.toISOString()).toBe(new Date(t).toISOString());
    });

    it('a report without a check (upgrade) keeps the stored result', async () => {
      await post({ ...site, event: 'upgraded', plugin: { name: 'Strapi-Supertext-Translation', version: '0.3.0' } }, ip);
      const i = await find();
      expect(i).toMatchObject({ plugin_version: '0.3.0', api_key_status: 'ok' });
      expect((await store.installationHistory(i.id))[0].api_key_status).toBeNull();
    });

    it('a rejected key is a change, with HTTP status and error code', async () => {
      await post(
        { ...site, event: 'api_key_check', plugin: { name: 'Strapi-Supertext-Translation', version: '0.3.0' },
          api_key_check: { status: 'invalid', http_status: 401, error_code: 'INVALID_API_KEY' } },
        ip,
      );
      const i = await find();
      expect(i).toMatchObject({ api_key_status: 'invalid', api_key_http_status: 401, api_key_error_code: 'INVALID_API_KEY', last_event: 'api_key_check' });
      const [latest] = await store.installationHistory(i.id);
      expect(latest).toMatchObject({ event: 'api_key_check', api_key_status: 'invalid', changed: true });
      // without checked_at the center uses the receive time
      expect(Math.abs(latest.api_key_checked_at!.getTime() - latest.received_at.getTime())).toBeLessThan(1000);
    });

    it('an older check doesn\'t overwrite a newer one', async () => {
      await post({ ...site, event: 'check', plugin: { name: 'Strapi-Supertext-Translation', version: '0.3.0' }, api_key_check: { status: 'ok', checked_at: '2026-01-01T00:00:00Z' } }, ip);
      expect((await find()).api_key_status).toBe('invalid');
    });

    it('filters by key status', async () => {
      // The spec examples posted earlier add a rejected key (www.example.ch) and an unreachable check (cms.example.org).
      expect((await store.listInstallations({ keyStatus: 'problem' })).map((i) => `${i.site_url} ${i.api_key_status}`).sort()).toEqual([
        'https://blog.example.ch invalid',
        'https://cms.example.org unreachable',
        'https://keys.example.ch invalid',
        'https://www.example.ch invalid',
      ]);
      expect((await store.listInstallations({ keyStatus: 'ok' })).every((i) => i.api_key_status === 'ok')).toBe(true);
      expect((await store.listInstallations({ keyStatus: 'unchecked' })).every((i) => i.api_key_status === null)).toBe(true);
    });

    it('a malformed check is ignored, the report still counts', async () => {
      const before = (await find()).report_count;
      const res = await post({ ...site, event: 'settings_saved', plugin: { name: 'Strapi-Supertext-Translation', version: '0.3.0' }, api_key_check: { status: 'BROKEN' } }, ip);
      expect(res.status).toBe(202);
      expect(await find()).toMatchObject({ api_key_status: 'invalid', report_count: before + 1 });
    });
  });

  describe('callback ping', () => {
    let server: http.Server;
    let port: number;
    let hits = 0;
    let pinger: typeof import('../../src/lib/pinger');
    const ip = { 'x-forwarded-for': '198.51.100.30' };
    const site = (host: string, path = '/supertext/ping') => ({
      ...base,
      event: 'settings_saved',
      site_url: `http://${host}:${port}`,
      plugin: { name: 'Grav-Supertext-Translation', version: '0.2.0' },
      system: { name: 'Grav', version: '2.0.0' },
      callback: { url: `http://${host}:${port}${path}` },
    });
    const find = async (host: string) => (await store.listInstallations({ q: host }))[0];
    const settle = () => new Promise((r) => setTimeout(r, 300));

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        hits++;
        const u = new URL(req.url ?? '/', 'http://x');
        res.writeHead(u.pathname === '/supertext/ping' ? 200 : 403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, plugin: 'Grav-Supertext-Translation', challenge: u.searchParams.get('challenge') }));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
      // Test-only switches: let the pinger reach the local server under public-looking names.
      process.env.COMMANDO_PING_ALLOW_PRIVATE = '1';
      process.env.COMMANDO_PING_HOSTS = 'grav.example.ch=127.0.0.1,locked.example.ch=127.0.0.1,www.example.ch=192.0.2.1';
      pinger = await import('../../src/lib/pinger');
      pinger.resetPinger();
    });
    afterAll(async () => {
      delete process.env.COMMANDO_PING_ALLOW_PRIVATE;
      delete process.env.COMMANDO_PING_HOSTS;
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('a report with an endpoint is pinged after the answer and stored', async () => {
      expect((await post(site('grav.example.ch'), ip)).status).toBe(202);
      await settle();
      const i = await find('grav.example.ch');
      expect(i).toMatchObject({ callback_url: `http://grav.example.ch:${port}/supertext/ping`, callback_status: 'reachable', callback_http_status: 200 });
      expect(i.callback_ms).toBeGreaterThanOrEqual(0);
      const [p] = await store.pingHistory(i.id);
      expect(p).toMatchObject({ trigger: 'report', status: 'reachable' });
    });

    it('a second report within a minute does not ping again', async () => {
      const before = hits;
      await post(site('grav.example.ch'), ip);
      await settle();
      expect(hits).toBe(before);
    });

    it('Ping now pings and records the trigger', async () => {
      const i = await find('grav.example.ch');
      pinger.resetPinger();
      const out = await pinger.pingInstallation(i.id, 'manual');
      expect(out.pinged).toBe(true);
      expect((await store.pingHistory(i.id))[0].trigger).toBe('manual');
      expect(await pinger.pingInstallation(i.id, 'manual')).toEqual({ pinged: false, reason: 'pinged a moment ago' });
    });

    it('a report without an endpoint keeps the stored one', async () => {
      const { callback, ...noCallback } = site('grav.example.ch');
      void callback;
      await post({ ...noCallback, event: 'upgraded' }, ip);
      expect((await find('grav.example.ch')).callback_url).toBe(`http://grav.example.ch:${port}/supertext/ping`);
    });

    it('records a blocked endpoint', async () => {
      await post(site('locked.example.ch', '/wrong/path'), ip);
      await settle();
      expect(await find('locked.example.ch')).toMatchObject({ callback_status: 'blocked', callback_http_status: 403, callback_detail: 'HTTP 403' });
    });

    it('refuses an endpoint on another host without connecting', async () => {
      const before = hits;
      await post({ ...site('grav2.example.ch'), callback: { url: `http://evil.example.net:${port}/supertext/ping` } }, ip);
      await settle();
      expect(hits).toBe(before);
      expect(await find('grav2.example.ch')).toMatchObject({ callback_status: 'refused', callback_detail: expect.stringMatching(/not grav2\.example\.ch/) });
    });

    it('filters by reachability', async () => {
      // Only this suite's sites (the spec example www.example.ch was refused).
      const ours = (rows: { site_url: string }[]) => rows.map((i) => i.site_url).filter((u) => u.endsWith(`:${port}`)).sort();
      expect(ours(await store.listInstallations({ callback: 'problem' }))).toEqual([`http://grav2.example.ch:${port}`, `http://locked.example.ch:${port}`]);
      expect(ours(await store.listInstallations({ callback: 'reachable' }))).toEqual([`http://grav.example.ch:${port}`]);
      expect((await store.listInstallations({ callback: 'none' })).every((i) => i.callback_url === null)).toBe(true);
    });
  });

  it('maps installations to clients by hand', async () => {
    const [i] = await store.listInstallations({ q: 'kunde', plugin: 'supertext-wordpress-polylang' });
    const id = await store.ensureClient('Kunde AG');
    expect(await store.ensureClient('kunde ag')).toBe(id); // same client, case-insensitive
    await store.updateInstallation(i.id, id, 'Production');
    expect(await store.getInstallation(i.id)).toMatchObject({ client_id: id, client_name: 'Kunde AG', notes: 'Production' });
    expect(await store.listInstallations({ clientId: id })).toHaveLength(1);
    expect((await store.listInstallations({ clientId: 'none' })).every((x) => x.client_id === null)).toBe(true);
    expect((await store.getClient(id))?.installation_count).toBe(1);
    expect(await store.listInstallations({ q: 'Kunde AG' })).toHaveLength(1);
  });

  it('search escapes LIKE wildcards', async () => {
    expect(await store.listInstallations({ q: '%' })).toHaveLength(0);
  });

  it('deleting a client unmaps its installations; deleting an installation removes its history', async () => {
    const [c] = await store.listClients();
    await store.deleteClient(c.id);
    const [i] = await store.listInstallations({ q: 'kunde', plugin: 'supertext-wordpress-polylang' });
    expect(i.client_id).toBeNull();
    await store.deleteInstallation(i.id);
    expect(await store.getInstallation(i.id)).toBeNull();
    expect(await store.installationHistory(i.id)).toEqual([]);
  });
});
