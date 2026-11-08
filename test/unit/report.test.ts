import { describe, expect, it } from 'vitest';
import examples from '../../spec/report-examples.json';
import { parseApiKeyCheck, parseReport } from '../../src/lib/report';

describe('parseReport (spec/report-examples.json)', () => {
  for (const ex of examples.valid) {
    it(`accepts: ${ex.name}`, () => {
      const r = parseReport(ex.body);
      expect(r.ok).toBe(true);
    });
  }
  for (const ex of examples.invalid) {
    it(`rejects: ${ex.name}`, () => {
      const r = parseReport(ex.body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/\S/);
    });
  }

  it('maps the fields and normalizes the URL', () => {
    const r = parseReport(examples.valid[0].body, Date.parse('2026-10-13T12:00:00Z'));
    expect(r).toEqual({
      ok: true,
      report: {
        event: 'settings_saved',
        siteUrl: 'https://www.example.ch',
        local: false,
        plugin: 'Typo3-Supertext-Translation',
        pluginVersion: '0.4.0',
        system: 'TYPO3',
        systemVersion: '13.4.2',
        runtime: 'PHP',
        runtimeVersion: '8.3.12',
        sdkVersion: '0.3.0',
        apiKeyConfigured: true,
        apiKeyCheck: { status: 'ok', checkedAt: new Date('2026-10-13T07:15:00Z'), httpStatus: 200, errorCode: null },
        callbackUrl: 'https://www.example.ch/supertext/ping',
        apiKeys: null,
        extensions: null,
      },
    });
  });

  it('leaves optional fields null when missing or of the wrong type', () => {
    const r = parseReport({ ...examples.valid[2].body, runtime: 'PHP', api_key_configured: 'yes' });
    expect(r.ok && r.report).toMatchObject({ runtime: null, runtimeVersion: null, sdkVersion: null, apiKeyConfigured: null, systemVersion: null, apiKeyCheck: null, callbackUrl: null });
  });
});

describe('api_key_check (spec/report-examples.json → stored)', () => {
  const NOW = Date.parse('2026-10-13T12:00:00Z');
  for (const ex of examples.valid.filter((e) => 'stored' in e)) {
    it(ex.name, () => {
      const r = parseReport(ex.body, NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const stored = (
        ex as {
          stored: {
            api_key_check: Record<string, unknown> | null;
            callback_url?: string | null;
            api_key_configured?: boolean;
            api_keys?: Record<string, unknown>[];
            extensions?: Record<string, unknown>[];
          };
        }
      ).stored;
      if ('callback_url' in stored) expect(r.report.callbackUrl).toBe(stored.callback_url);
      if ('api_key_configured' in stored) expect(r.report.apiKeyConfigured).toBe(stored.api_key_configured);
      if ('extensions' in stored) expect(r.report.extensions).toEqual(stored.extensions);
      else expect(r.report.extensions).toBeNull();
      if ('api_keys' in stored) {
        expect(
          r.report.apiKeys?.map((k) => ({
            name: k.name,
            configured: k.configured,
            status: k.check?.status ?? null,
            checked_at: k.check?.checkedAt?.toISOString() ?? null,
            http_status: k.check?.httpStatus ?? null,
            error_code: k.check?.errorCode ?? null,
          })),
        ).toEqual(stored.api_keys);
      } else {
        expect(r.report.apiKeys).toBeNull();
      }
      const want = stored.api_key_check;
      const got = r.report.apiKeyCheck;
      if (want === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).toMatchObject({ status: want.status, httpStatus: want.http_status, errorCode: want.error_code });
      if (want.checked_at === '<receive time>') expect(got?.checkedAt).toBeNull();
      else expect(got?.checkedAt?.toISOString()).toBe(want.checked_at);
    });
  }

  it('uses the receive time for clocks in the future or the distant past', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(parseApiKeyCheck({ status: 'ok', checked_at: '2026-10-13T13:00:00Z' }, now)?.checkedAt).toBeNull();
    expect(parseApiKeyCheck({ status: 'ok', checked_at: '1999-01-01T00:00:00Z' }, now)?.checkedAt).toBeNull();
    expect(parseApiKeyCheck({ status: 'ok', checked_at: 'yesterday' }, now)?.checkedAt).toBeNull();
    expect(parseApiKeyCheck({ status: 'ok', checked_at: '2026-10-13T12:03:00Z' }, now)?.checkedAt).toEqual(new Date('2026-10-13T12:03:00Z'));
  });

  it('drops malformed checks', () => {
    for (const bad of [null, 'ok', [], {}, { status: 'OK' }, { status: 'ok', http_status: 99 }, { status: 'ok', http_status: 401.5 }, { status: 'ok', error_code: 'x\u0000' }]) {
      expect(parseApiKeyCheck(bad)).toBeNull();
    }
  });

  it('keeps unknown statuses for forward compatibility', () => {
    expect(parseApiKeyCheck({ status: 'quota_exceeded' })?.status).toBe('quota_exceeded');
  });
});

describe('api_keys', () => {
  it('keeps at most 20 keys and the worst check as the summary', async () => {
    const { parseApiKeys, worstCheck } = await import('../../src/lib/report');
    const many = Array.from({ length: 25 }, (_, n) => ({ name: `Key ${n}`, configured: true }));
    expect(parseApiKeys(many)).toHaveLength(20);
    expect(parseApiKeys('nope')).toBeNull();
    const c = (status: string, t: string) => ({ check: { status, checkedAt: new Date(t), httpStatus: null, errorCode: null } });
    expect(worstCheck([c('ok', '2026-01-02'), c('unreachable', '2026-01-01'), c('invalid', '2026-01-01')])?.status).toBe('invalid');
    expect(worstCheck([c('ok', '2026-01-01'), c('ok', '2026-01-03')])?.checkedAt?.toISOString()).toBe('2026-01-03T00:00:00.000Z');
    expect(worstCheck([c('ok', '2026-01-01'), c('weird', '2026-01-01')])?.status).toBe('weird');
    expect(worstCheck([{ check: null }])).toBeNull();
  });
});

describe('extensions', () => {
  const base = { schema: 1, event: 'extensions', site_url: 'https://www.example.ch', plugin: { name: 'X', version: '1.0.0' }, system: { name: 'WordPress' } };

  it('treats a value that is not a list as absent', () => {
    for (const extensions of [null, 'Polylang', { name: 'Polylang' }]) {
      const r = parseReport({ ...base, extensions });
      expect(r.ok && r.report.extensions).toBeNull();
    }
  });

  it('keeps at most 500 entries', () => {
    const extensions = Array.from({ length: 520 }, (_, n) => ({ name: `Plugin ${n}`, version: '1.0' }));
    const r = parseReport({ ...base, extensions });
    expect(r.ok && r.report.extensions?.length).toBe(500);
  });

  it('keeps a plugin and a theme of the same name apart', () => {
    const r = parseReport({ ...base, extensions: [{ name: 'Astra', type: 'plugin' }, { name: 'Astra', type: 'theme' }] });
    expect(r.ok && r.report.extensions?.map((e) => e.type)).toEqual(['plugin', 'theme']);
  });
});
