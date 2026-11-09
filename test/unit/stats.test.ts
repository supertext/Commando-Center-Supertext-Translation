import { describe, expect, it } from 'vitest';
import { checkStatsToken, computeStats, type StatsRow } from '../../src/lib/stats';

const TOKEN = 'x'.repeat(40);

describe('checkStatsToken', () => {
  it('is off without a token of at least 32 characters', () => {
    expect(checkStatsToken(`Bearer ${TOKEN}`, undefined)).toBe('off');
    expect(checkStatsToken('Bearer short', 'short')).toBe('off');
  });
  it('accepts only the exact bearer token', () => {
    expect(checkStatsToken(`Bearer ${TOKEN}`, TOKEN)).toBe('ok');
    expect(checkStatsToken(`bearer ${TOKEN}`, TOKEN)).toBe('ok');
    expect(checkStatsToken(`Bearer ${TOKEN}y`, TOKEN)).toBe('wrong');
    expect(checkStatsToken(TOKEN, TOKEN)).toBe('missing');
    expect(checkStatsToken(`Basic ${TOKEN}`, TOKEN)).toBe('missing');
    expect(checkStatsToken(null, TOKEN)).toBe('missing');
  });
});

const now = new Date('2026-11-09T12:00:00Z');
const row = (o: Partial<StatsRow>): StatsRow => ({
  plugin: 'Strapi-Supertext-Translation',
  plugin_version: '0.5.0',
  system: 'Strapi',
  system_version: '5.20.0',
  runtime: 'Node.js',
  runtime_version: '22.11.0',
  sdk_version: '0.9.0',
  api_key_status: 'ok',
  callback_status: 'reachable',
  client_id: null,
  last_seen: now,
  extensions: null,
  languages: null,
  ...o,
});

describe('computeStats', () => {
  const rows = [
    row({}),
    row({ plugin_version: '0.4.0', api_key_status: 'invalid', last_seen: new Date('2026-08-01T00:00:00Z'), client_id: 3 }),
    row({ system_version: '5.21.0', callback_status: 'unreachable' }),
    row({ plugin: 'Typo3-Supertext-Translation', plugin_version: '1.0.0', system: 'TYPO3', system_version: null, runtime: null, runtime_version: null, api_key_status: null }),
  ];
  const latest = new Map([
    ['Strapi-Supertext-Translation', '0.5.0'],
    ['Typo3-Supertext-Translation', null],
  ]);
  const s = computeStats(rows, latest, false, now);

  it('counts per plugin, most installations first', () => {
    expect(s.plugins.map((p) => [p.plugin, p.installations])).toEqual([
      ['Strapi-Supertext-Translation', 3],
      ['Typo3-Supertext-Translation', 1],
    ]);
    const strapi = s.plugins[0];
    expect(strapi).toMatchObject({ latest_release: '0.5.0', active: 2, up_to_date: 2, outdated: 1, api_key_problem: 1, unreachable: 1, with_client: 1 });
    expect(strapi.versions).toEqual([
      { value: '0.5.0', installations: 2 },
      { value: '0.4.0', installations: 1 },
    ]);
    expect(strapi.system_versions).toEqual([
      { value: 'Strapi 5.20.0', installations: 2 },
      { value: 'Strapi 5.21.0', installations: 1 },
    ]);
    expect(s.plugins[1]).toMatchObject({ latest_release: null, up_to_date: 0, outdated: 0, system_versions: [{ value: 'TYPO3', installations: 1 }], runtimes: [{ value: null, installations: 1 }] });
  });

  it('sums the totals and identifies no site or client', () => {
    expect(s.totals).toMatchObject({ installations: 4, active: 3, up_to_date: 2, outdated: 1, api_key_problem: 1, unreachable: 1, with_client: 1, plugins: 2 });
    expect(s.totals.extensions).toEqual({ reported: 0, installed: null, active: null, by_type: [] });
    expect(s.totals.languages).toEqual({ reported: 0, with_unmapped: 0, per_site: null, supertext: [], mappings: [] });
    expect(s).toMatchObject({ generated_at: now.toISOString(), active_days: 30, include_local: false });
    expect(JSON.stringify(s)).not.toMatch(/site_url|client_id|client_name|notes/);
  });
});

describe('installed plugins (counts only)', () => {
  const ext = (n: number, active: boolean | null, type: string | null = 'plugin') =>
    Array.from({ length: n }, (_, i) => ({ name: `secret-plugin-${type}-${i}`, version: '1.0.0', active: i === 0 ? active : (active === null ? null : !active), type }));
  const rows: StatsRow[] = [
    { ...row({ plugin: 'WP' }), extensions: [...ext(10, true), ...ext(2, true, 'theme')] },
    { ...row({ plugin: 'WP' }), extensions: ext(4, null) },
    { ...row({ plugin: 'WP' }), extensions: [] },
    { ...row({ plugin: 'WP' }), extensions: null },
  ];
  const s = computeStats(rows, new Map(), false, now);
  const e = s.plugins[0].extensions;

  it('summarises how many each site has installed and active', () => {
    expect(e.reported).toBe(3);
    expect(e.installed).toEqual({ min: 0, median: 4, mean: 5.3, max: 12 });
    // Active counts only lists that say which are active: here only the first (1 plugin + 1 theme active).
    expect(e.active).toEqual({ min: 2, median: 2, mean: 2, max: 2 });
    expect(e.by_type).toEqual([
      { type: 'plugin', installations: 2, installed: { min: 4, median: 7, mean: 7, max: 10 } },
      { type: 'theme', installations: 1, installed: { min: 2, median: 2, mean: 2, max: 2 } },
    ]);
    expect(s.totals.extensions).toEqual(e);
  });

  it('never returns the names of installed plugins', () => {
    expect(JSON.stringify(s)).not.toContain('secret-plugin');
  });
});

describe('language mappings', () => {
  const rows: StatsRow[] = [
    row({ plugin: 'WP', languages: [{ code: 'de_CH', supertext: 'de-CH' }, { code: 'fr_FR', supertext: 'fr-FR' }, { code: 'en_IE', supertext: null }] }),
    row({ plugin: 'WP', languages: [{ code: 'de', supertext: 'de-CH' }, { code: 'de_AT', supertext: 'de-CH' }] }),
    row({ plugin: 'WP', languages: [] }),
    row({ plugin: 'WP' }),
  ];
  const l = computeStats(rows, new Map(), false, now).plugins[0].languages;

  it('counts Supertext languages per site and unmapped languages', () => {
    expect(l).toMatchObject({ reported: 3, with_unmapped: 1, per_site: { min: 0, median: 2, mean: 1.7, max: 3 } });
    expect(l.supertext).toEqual([
      { value: 'de-CH', installations: 2 },
      { value: 'fr-FR', installations: 1 },
    ]);
    expect(l.mappings).toEqual([
      { code: 'de', supertext: 'de-CH', installations: 1 },
      { code: 'de_AT', supertext: 'de-CH', installations: 1 },
      { code: 'de_CH', supertext: 'de-CH', installations: 1 },
      { code: 'en_IE', supertext: null, installations: 1 },
      { code: 'fr_FR', supertext: 'fr-FR', installations: 1 },
    ]);
  });
});
