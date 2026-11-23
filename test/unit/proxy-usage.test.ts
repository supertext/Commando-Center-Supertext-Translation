import { afterEach, describe, expect, it } from 'vitest';
import { clearProxyUsageCache, parseUsage, proxyConfig, proxyUsage } from '../../src/lib/proxy-usage';

const entry = {
  tenant: 'a'.repeat(64),
  tenantLabel: 'Hotel Alpenblick',
  plugin: 'Typo3-Supertext-Translation',
  pluginVersion: '0.6.0',
  sdk: 'php',
  keyChecks: 1,
  uploads: 4,
  memoryAnswers: 1,
  firstSeenAt: '2026-10-18T17:00:00.000Z',
  lastSeenAt: '2026-10-18T17:30:00.000Z',
};

afterEach(() => {
  delete process.env.COMMANDO_PROXY_URL;
  delete process.env.COMMANDO_PROXY_TOKEN;
  clearProxyUsageCache();
});

describe('proxy usage', () => {
  it('parses schema 1 and drops invalid entries', () => {
    const r = parseUsage({ schema: 1, generatedAt: '2026-10-18T17:31:00.000Z', integrations: [entry, { ...entry, tenant: 'x' }, { ...entry, uploads: -1 }, null, { ...entry, extra: 'ignored' }] });
    expect(r?.integrations).toHaveLength(2);
    expect(r?.generatedAt).toBe('2026-10-18T17:31:00.000Z');
    expect(parseUsage({ schema: 2, integrations: [] })).toBeNull();
    expect(parseUsage('nope')).toBeNull();
  });

  it('needs both settings', () => {
    expect(proxyConfig({})).toBeNull();
    expect(proxyConfig({ COMMANDO_PROXY_URL: 'https://p.example/', COMMANDO_PROXY_TOKEN: 't' })).toEqual({ url: 'https://p.example', token: 't' });
    expect(proxyConfig({ COMMANDO_PROXY_URL: 'ftp://p.example', COMMANDO_PROXY_TOKEN: 't' })).toBeNull();
  });

  it('reads the API with the token, caches it, and reports errors', async () => {
    expect((await proxyUsage()).status).toBe('not_configured');
    process.env.COMMANDO_PROXY_URL = 'https://proxy.example';
    process.env.COMMANDO_PROXY_TOKEN = 'secret-token';
    const calls: [string, RequestInit][] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ schema: 1, generatedAt: entry.lastSeenAt, integrations: [entry] }));
    }) as unknown as typeof fetch;
    const r = await proxyUsage(ok, 1000);
    expect(r).toMatchObject({ status: 'ok', integrations: [entry] });
    expect(calls[0]![0]).toBe('https://proxy.example/api/usage');
    expect((calls[0]![1].headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    await proxyUsage(ok, 2000);
    expect(calls).toHaveLength(1); // cached
    clearProxyUsageCache();
    const denied = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    expect(await proxyUsage(denied, 3000)).toMatchObject({ status: 'error', detail: expect.stringContaining('COMMANDO_PROXY_TOKEN') });
    clearProxyUsageCache();
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await proxyUsage(down, 4000)).toMatchObject({ status: 'error', detail: 'The proxy can’t be reached.' });
  });
});
