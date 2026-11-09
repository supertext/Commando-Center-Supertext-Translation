import { createHash, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { db } from './db';
import type { Extension } from './report';
import { versionStatus } from './semver';

/**
 * Statistics API (GET /api/v1/stats): totals only, never site URLs, client names or notes.
 * Protected by one shared token in COMMANDO_STATS_TOKEN (Authorization: Bearer <token>).
 */

export const MIN_TOKEN_LENGTH = 32;
export const ACTIVE_DAYS = 30;

export type TokenCheck = 'ok' | 'off' | 'missing' | 'wrong';

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Compares the bearer token with the configured one in constant time. 'off': no usable token configured. */
export function checkStatsToken(authorization: string | null, configured = process.env.COMMANDO_STATS_TOKEN): TokenCheck {
  const expected = configured?.trim() ?? '';
  if (expected.length < MIN_TOKEN_LENGTH) return 'off';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (!m) return 'missing';
  return timingSafeEqual(digest(m[1]), digest(expected)) ? 'ok' : 'wrong';
}

/** The columns the statistics need; nothing that identifies a site or a client. */
export interface StatsRow {
  plugin: string;
  plugin_version: string;
  system: string;
  system_version: string | null;
  runtime: string | null;
  runtime_version: string | null;
  sdk_version: string | null;
  api_key_status: string | null;
  callback_status: string | null;
  client_id: number | null;
  last_seen: Date | string;
  /** Only the counts are used: names never leave this module. */
  extensions: Extension[] | null;
}

export async function loadStatsRows(includeLocal: boolean, sql: Sql = db()): Promise<StatsRow[]> {
  return sql<StatsRow[]>`
    SELECT plugin, plugin_version, system, system_version, runtime, runtime_version, sdk_version,
           api_key_status, callback_status, client_id, last_seen, extensions
    FROM installations
    ${includeLocal ? sql`` : sql`WHERE NOT local`}`;
}

export interface Count {
  value: string | null;
  installations: number;
}

export interface Totals {
  installations: number;
  active: number;
  up_to_date: number;
  outdated: number;
  api_key_problem: number;
  unreachable: number;
  with_client: number;
}

/** Distribution of a number over the installations that sent their list. */
export interface Summary {
  min: number;
  median: number;
  mean: number;
  max: number;
}

/** How many other plugins (themes, modules, …) the sites have installed: counts only, never names. */
export interface ExtensionStats {
  /** Installations that sent their list of installed plugins. */
  reported: number;
  installed: Summary | null;
  active: Summary | null;
  /** Per type (plugin, theme, mu-plugin, …): installations listing at least one, and how many each lists. */
  by_type: Array<{ type: string | null; installations: number; installed: Summary }>;
}

export interface PluginStats extends Totals {
  plugin: string;
  latest_release: string | null;
  versions: Count[];
  system_versions: Count[];
  runtimes: Count[];
  sdk_versions: Count[];
  api_key_status: Count[];
  extensions: ExtensionStats;
}

export interface Stats {
  generated_at: string;
  active_days: number;
  include_local: boolean;
  totals: Totals & { plugins: number; extensions: ExtensionStats };
  plugins: PluginStats[];
}

function counts(values: (string | null)[]): Count[] {
  const m = new Map<string | null, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m]
    .map(([value, installations]) => ({ value, installations }))
    .sort((a, b) => b.installations - a.installations || String(a.value ?? '').localeCompare(String(b.value ?? ''), 'en', { numeric: true }));
}

function summary(values: number[]): Summary | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { min: v[0], median, mean: Math.round(mean * 10) / 10, max: v[v.length - 1] };
}

export function extensionStats(rows: StatsRow[]): ExtensionStats {
  const lists = rows.map((r) => r.extensions).filter((l): l is Extension[] => Array.isArray(l));
  const types = new Map<string | null, number[]>();
  for (const l of lists) {
    const perType = new Map<string | null, number>();
    for (const e of l) perType.set(e.type ?? null, (perType.get(e.type ?? null) ?? 0) + 1);
    for (const [t, n] of perType) types.set(t, [...(types.get(t) ?? []), n]);
  }
  return {
    reported: lists.length,
    installed: summary(lists.map((l) => l.length)),
    // Active: only entries the system marks as active; lists that never say count as unknown.
    active: summary(lists.filter((l) => l.some((e) => e.active !== null)).map((l) => l.filter((e) => e.active === true).length)),
    by_type: [...types]
      .map(([type, n]) => ({ type, installations: n.length, installed: summary(n)! }))
      .sort((a, b) => b.installations - a.installations || String(a.type ?? '').localeCompare(String(b.type ?? ''))),
  };
}

function join(name: string | null, version: string | null): string | null {
  if (!name) return null;
  return version ? `${name} ${version}` : name;
}

function totals(rows: StatsRow[], latest: string | null, since: number): Totals {
  const status = rows.map((r) => versionStatus(r.plugin_version, latest));
  return {
    installations: rows.length,
    active: rows.filter((r) => new Date(r.last_seen).getTime() >= since).length,
    up_to_date: status.filter((s) => s === 'current' || s === 'ahead').length,
    outdated: status.filter((s) => s === 'outdated').length,
    api_key_problem: rows.filter((r) => r.api_key_status && r.api_key_status !== 'ok').length,
    unreachable: rows.filter((r) => r.callback_status && r.callback_status !== 'reachable').length,
    with_client: rows.filter((r) => r.client_id !== null).length,
  };
}

/** Pure: aggregates installations per plugin. `latest` maps plugin → latest release (or null). */
export function computeStats(rows: StatsRow[], latest: Map<string, string | null>, includeLocal: boolean, now = new Date()): Stats {
  const since = now.getTime() - ACTIVE_DAYS * 24 * 60 * 60 * 1000;
  const byPlugin = new Map<string, StatsRow[]>();
  for (const r of rows) byPlugin.set(r.plugin, [...(byPlugin.get(r.plugin) ?? []), r]);
  const plugins = [...byPlugin]
    .map(([plugin, list]): PluginStats => {
      const l = latest.get(plugin) ?? null;
      return {
        plugin,
        latest_release: l,
        ...totals(list, l, since),
        versions: counts(list.map((r) => r.plugin_version)),
        system_versions: counts(list.map((r) => join(r.system, r.system_version))),
        runtimes: counts(list.map((r) => join(r.runtime, r.runtime_version))),
        sdk_versions: counts(list.map((r) => r.sdk_version)),
        api_key_status: counts(list.map((r) => r.api_key_status)),
        extensions: extensionStats(list),
      };
    })
    .sort((a, b) => b.installations - a.installations || a.plugin.localeCompare(b.plugin));

  // Overall up to date / outdated: each installation against its own plugin's latest release.
  const all = plugins.reduce(
    (t, p) => {
      for (const k of Object.keys(t) as (keyof Totals)[]) t[k] += p[k];
      return t;
    },
    { installations: 0, active: 0, up_to_date: 0, outdated: 0, api_key_problem: 0, unreachable: 0, with_client: 0 } as Totals,
  );
  return {
    generated_at: now.toISOString(),
    active_days: ACTIVE_DAYS,
    include_local: includeLocal,
    totals: { ...all, plugins: plugins.length, extensions: extensionStats(rows) },
    plugins,
  };
}
