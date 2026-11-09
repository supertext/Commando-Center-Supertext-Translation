import postgres from 'postgres';
import { databaseUrls } from './db-url.mjs';
import { worstCheck, type ApiKeyCheck, type Extension, type LanguageMapping, type NamedApiKey, type Report } from './report';

type Sql = postgres.Sql;

const globalForDb = globalThis as unknown as { commandoSql?: Sql };

export function db(): Sql {
  if (!globalForDb.commandoSql) {
    globalForDb.commandoSql = postgres(databaseUrls().url, { max: 5, idle_timeout: 30, onnotice: () => {} });
  }
  return globalForDb.commandoSql;
}

export interface Installation {
  id: number;
  site_url: string;
  plugin: string;
  local: boolean;
  client_id: number | null;
  client_name: string | null;
  notes: string;
  plugin_version: string;
  system: string;
  system_version: string | null;
  runtime: string | null;
  runtime_version: string | null;
  sdk_version: string | null;
  api_key_configured: boolean | null;
  api_key_status: string | null;
  api_key_checked_at: Date | null;
  api_key_http_status: number | null;
  api_key_error_code: string | null;
  /** Named keys (plugins with several API keys), or null: the single-key columns are all there is. */
  api_keys: StoredApiKey[] | null;
  /** The other plugins installed on the site, as last sent; null: never sent. */
  extensions: Extension[] | null;
  extensions_at: Date | null;
  /** The plugin's language mapping, as last sent; null: never sent. */
  languages: LanguageMapping[] | null;
  languages_at: Date | null;
  callback_url: string | null;
  callback_status: string | null;
  callback_checked_at: Date | null;
  callback_http_status: number | null;
  callback_ms: number | null;
  callback_detail: string | null;
  last_event: string;
  first_seen: Date;
  last_seen: Date;
  report_count: number;
}

export interface ReportRow {
  id: number;
  received_at: Date;
  event: string;
  plugin_version: string;
  system_version: string | null;
  runtime_version: string | null;
  sdk_version: string | null;
  api_key_configured: boolean | null;
  api_key_status: string | null;
  api_key_checked_at: Date | null;
  api_key_http_status: number | null;
  api_key_error_code: string | null;
  api_keys: StoredApiKey[] | null;
  /** The installed plugins this report carried; null: none. */
  extensions: Extension[] | null;
  /** The language mapping this report carried; null: none. */
  languages: LanguageMapping[] | null;
  changed: boolean;
}

/** A named key as stored (JSON in installations.api_keys and reports.api_keys). */
export interface StoredApiKey {
  name: string;
  configured: boolean | null;
  status: string | null;
  checked_at: string | null;
  http_status: number | null;
  error_code: string | null;
}

function storeKey(name: string, configured: boolean | null, check: ApiKeyCheck | null): StoredApiKey {
  return {
    name,
    configured,
    status: check?.status ?? null,
    checked_at: check?.checkedAt?.toISOString() ?? null,
    http_status: check?.httpStatus ?? null,
    error_code: check?.errorCode ?? null,
  };
}

function storedCheck(k: StoredApiKey): ApiKeyCheck | null {
  return k.status ? { status: k.status, checkedAt: k.checked_at ? new Date(k.checked_at) : null, httpStatus: k.http_status, errorCode: k.error_code } : null;
}

/**
 * The installation's named keys after a report: the reported list (names and order), each keeping the
 * newest check (a report without a check for a key, or with an older one, keeps the stored result).
 */
export function mergeApiKeys(reported: NamedApiKey[], stored: StoredApiKey[] | null, now: Date): StoredApiKey[] {
  return reported.map((k) => {
    const check = k.check ? { ...k.check, checkedAt: k.check.checkedAt ?? now } : null;
    const old = stored?.find((s) => s.name === k.name);
    const oldCheck = old ? storedCheck(old) : null;
    const keep = oldCheck && (!check || (oldCheck.checkedAt && check.checkedAt < oldCheck.checkedAt));
    return storeKey(k.name, k.configured, keep ? oldCheck : check);
  });
}

/** The installed plugins in a stable order, to notice a changed list. */
export function extensionsKey(list: Extension[] | null): string {
  return JSON.stringify(
    (list ?? [])
      .map((e) => [e.type ?? '', e.name.toLowerCase(), e.version, e.active])
      .sort((a, b) => (`${a[0]}\u0000${a[1]}` < `${b[0]}\u0000${b[1]}` ? -1 : 1)),
  );
}

/** The language mapping in a stable order, to notice a changed list. */
export function languagesKey(list: LanguageMapping[] | null): string {
  return JSON.stringify((list ?? []).map((l) => [l.code.toLowerCase(), l.supertext]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
}

function keyStatuses(keys: StoredApiKey[] | null): string {
  return JSON.stringify((keys ?? []).map((k) => [k.name, k.configured, k.status]));
}

export interface Client {
  id: number;
  name: string;
  notes: string;
  created_at: Date;
  installation_count: number;
}

/** Stores a report: creates or updates the installation and appends to its history. */
export async function recordReport(r: Report, sql: Sql = db()): Promise<{ installationId: number; created: boolean; changed: boolean }> {
  return sql.begin(async (tx) => {
    const [{ now }] = await tx<{ now: Date }[]>`SELECT now() AS now`;
    const check = r.apiKeyCheck ? { ...r.apiKeyCheck, checkedAt: r.apiKeyCheck.checkedAt ?? now } : null;
    const [existing] = await tx<Installation[]>`
      SELECT * FROM installations WHERE site_url = ${r.siteUrl} AND plugin = ${r.plugin} FOR UPDATE`;

    // The installation keeps the newest check: a report without one (older plugin, or an upgrade
    // report) or with an older one leaves the stored result alone.
    const apiKeys = r.apiKeys ? mergeApiKeys(r.apiKeys, existing?.api_keys ?? null, now) : null;
    const summary = apiKeys ? worstCheck(apiKeys.map((k) => ({ check: storedCheck(k) }))) : null;
    const newer = check && (!existing?.api_key_checked_at || check.checkedAt >= existing.api_key_checked_at);
    const key = apiKeys
      ? {
          status: summary?.status ?? null,
          checkedAt: summary?.checkedAt ?? null,
          httpStatus: summary?.httpStatus ?? null,
          errorCode: summary?.errorCode ?? null,
        }
      : newer
      ? { status: check.status, checkedAt: check.checkedAt, httpStatus: check.httpStatus, errorCode: check.errorCode }
      : {
          status: existing?.api_key_status ?? null,
          checkedAt: existing?.api_key_checked_at ?? null,
          httpStatus: existing?.api_key_http_status ?? null,
          errorCode: existing?.api_key_error_code ?? null,
        };

    let id: number;
    let changed: boolean;
    if (!existing) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO installations (site_url, plugin, local, plugin_version, system, system_version, runtime,
          runtime_version, sdk_version, api_key_configured, api_key_status, api_key_checked_at, api_key_http_status,
          api_key_error_code, api_keys, extensions, extensions_at, languages, languages_at, callback_url, last_event)
        VALUES (${r.siteUrl}, ${r.plugin}, ${r.local}, ${r.pluginVersion}, ${r.system}, ${r.systemVersion},
          ${r.runtime}, ${r.runtimeVersion}, ${r.sdkVersion}, ${r.apiKeyConfigured}, ${key.status}, ${key.checkedAt},
          ${key.httpStatus}, ${key.errorCode}, ${apiKeys ? tx.json(apiKeys as never) : null},
          ${r.extensions ? tx.json(r.extensions as never) : null}, ${r.extensions ? now : null},
          ${r.languages ? tx.json(r.languages as never) : null}, ${r.languages ? now : null}, ${r.callbackUrl}, ${r.event})
        ON CONFLICT (site_url, plugin) DO UPDATE SET last_seen = ${now}
        RETURNING id`;
      id = row.id;
      changed = true;
    } else {
      id = existing.id;
      changed =
        existing.plugin_version !== r.pluginVersion ||
        existing.system !== r.system ||
        existing.system_version !== r.systemVersion ||
        existing.runtime !== r.runtime ||
        existing.runtime_version !== r.runtimeVersion ||
        existing.sdk_version !== r.sdkVersion ||
        existing.api_key_configured !== r.apiKeyConfigured ||
        existing.api_key_status !== key.status ||
        keyStatuses(existing.api_keys) !== keyStatuses(apiKeys) ||
        (r.extensions !== null && (existing.extensions === null || extensionsKey(existing.extensions) !== extensionsKey(r.extensions))) ||
        (r.languages !== null && (existing.languages === null || languagesKey(existing.languages) !== languagesKey(r.languages)));
      await tx`
        UPDATE installations SET plugin_version = ${r.pluginVersion}, system = ${r.system},
          system_version = ${r.systemVersion}, runtime = ${r.runtime}, runtime_version = ${r.runtimeVersion},
          sdk_version = ${r.sdkVersion}, api_key_configured = ${r.apiKeyConfigured}, local = ${r.local},
          api_key_status = ${key.status}, api_key_checked_at = ${key.checkedAt},
          api_key_http_status = ${key.httpStatus}, api_key_error_code = ${key.errorCode},
          api_keys = ${apiKeys ? tx.json(apiKeys as never) : null},
          extensions = ${r.extensions ? tx.json(r.extensions as never) : existing.extensions ? tx.json(existing.extensions as never) : null},
          extensions_at = ${r.extensions ? now : existing.extensions_at},
          languages = ${r.languages ? tx.json(r.languages as never) : existing.languages ? tx.json(existing.languages as never) : null},
          languages_at = ${r.languages ? now : existing.languages_at},
          callback_url = ${r.callbackUrl ?? existing.callback_url},
          last_event = ${r.event}, last_seen = ${now}, report_count = report_count + 1
        WHERE id = ${id}`;
    }
    await tx`
      INSERT INTO reports (installation_id, received_at, event, plugin_version, system_version, runtime_version,
        sdk_version, api_key_configured, api_key_status, api_key_checked_at, api_key_http_status, api_key_error_code,
        api_keys, extensions, languages, changed)
      VALUES (${id}, ${now}, ${r.event}, ${r.pluginVersion}, ${r.systemVersion}, ${r.runtimeVersion}, ${r.sdkVersion},
        ${r.apiKeyConfigured}, ${check?.status ?? null}, ${check?.checkedAt ?? null}, ${check?.httpStatus ?? null},
        ${check?.errorCode ?? null},
        ${r.apiKeys ? tx.json(r.apiKeys.map((k) => storeKey(k.name, k.configured, k.check ? { ...k.check, checkedAt: k.check.checkedAt ?? now } : null)) as never) : null},
        ${r.extensions ? tx.json(r.extensions as never) : null},
        ${r.languages ? tx.json(r.languages as never) : null}, ${changed})`;
    return { installationId: id, created: !existing, changed };
  });
}

export interface InstallationFilter {
  q?: string;
  plugin?: string;
  clientId?: number | 'none';
  includeLocal?: boolean;
  /** 'problem': any check result other than ok; 'unchecked': no check reported yet; or one status. */
  keyStatus?: string;
  /** 'problem': last ping not reachable; 'none': no ping endpoint reported; or one status. */
  callback?: string;
}

export async function listInstallations(f: InstallationFilter = {}, sql: Sql = db()): Promise<Installation[]> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return sql<Installation[]>`
    SELECT i.*, c.name AS client_name
    FROM installations i LEFT JOIN clients c ON c.id = i.client_id
    WHERE true
      ${f.includeLocal ? sql`` : sql`AND NOT i.local`}
      ${f.plugin ? sql`AND i.plugin = ${f.plugin}` : sql``}
      ${f.clientId === 'none' ? sql`AND i.client_id IS NULL` : f.clientId ? sql`AND i.client_id = ${f.clientId}` : sql``}
      ${
        f.keyStatus === 'problem'
          ? sql`AND i.api_key_status IS NOT NULL AND i.api_key_status <> 'ok'`
          : f.keyStatus === 'unchecked'
            ? sql`AND i.api_key_status IS NULL`
            : f.keyStatus
              ? sql`AND i.api_key_status = ${f.keyStatus}`
              : sql``
      }
      ${
        f.callback === 'problem'
          ? sql`AND i.callback_status IS NOT NULL AND i.callback_status <> 'reachable'`
          : f.callback === 'none'
            ? sql`AND i.callback_url IS NULL`
            : f.callback
              ? sql`AND i.callback_status = ${f.callback}`
              : sql``
      }
      ${
        like
          ? sql`AND (i.site_url ILIKE ${like} OR c.name ILIKE ${like} OR i.system ILIKE ${like} OR i.notes ILIKE ${like}
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(i.extensions) e WHERE e->>'name' ILIKE ${like})
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(i.languages) l WHERE l->>'code' ILIKE ${like} OR l->>'supertext' ILIKE ${like}))`
          : sql``
      }
    ORDER BY i.last_seen DESC
    LIMIT 2000`;
}

export async function listPlugins(sql: Sql = db()): Promise<string[]> {
  const rows = await sql<{ plugin: string }[]>`SELECT DISTINCT plugin FROM installations ORDER BY plugin`;
  return rows.map((r) => r.plugin);
}

export async function getInstallation(id: number, sql: Sql = db()): Promise<Installation | null> {
  const [row] = await sql<Installation[]>`
    SELECT i.*, c.name AS client_name FROM installations i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = ${id}`;
  return row ?? null;
}

export async function installationHistory(id: number, limit = 200, sql: Sql = db()): Promise<ReportRow[]> {
  return sql<ReportRow[]>`
    SELECT id, received_at, event, plugin_version, system_version, runtime_version, sdk_version, api_key_configured,
      api_key_status, api_key_checked_at, api_key_http_status, api_key_error_code, api_keys, extensions, languages, changed
    FROM reports WHERE installation_id = ${id} ORDER BY received_at DESC, id DESC LIMIT ${limit}`;
}

export async function updateInstallation(id: number, clientId: number | null, notes: string, sql: Sql = db()): Promise<void> {
  await sql`UPDATE installations SET client_id = ${clientId}, notes = ${notes} WHERE id = ${id}`;
}

export async function deleteInstallation(id: number, sql: Sql = db()): Promise<void> {
  await sql`DELETE FROM installations WHERE id = ${id}`;
}

export async function listClients(sql: Sql = db()): Promise<Client[]> {
  return sql<Client[]>`
    SELECT c.*, count(i.id)::int AS installation_count
    FROM clients c LEFT JOIN installations i ON i.client_id = c.id
    GROUP BY c.id ORDER BY lower(c.name)`;
}

export async function getClient(id: number, sql: Sql = db()): Promise<Client | null> {
  const [row] = await sql<Client[]>`
    SELECT c.*, (SELECT count(*)::int FROM installations WHERE client_id = c.id) AS installation_count
    FROM clients c WHERE c.id = ${id}`;
  return row ?? null;
}

/** Returns the client with this name (case-insensitive), creating it if needed. */
export async function ensureClient(name: string, sql: Sql = db()): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO clients (name) VALUES (${name})
    ON CONFLICT (lower(name)) DO UPDATE SET name = clients.name
    RETURNING id`;
  return row.id;
}

export async function updateClient(id: number, name: string, notes: string, sql: Sql = db()): Promise<void> {
  await sql`UPDATE clients SET name = ${name}, notes = ${notes} WHERE id = ${id}`;
}

export async function deleteClient(id: number, sql: Sql = db()): Promise<void> {
  await sql`DELETE FROM clients WHERE id = ${id}`;
}

export interface PingRow {
  id: number;
  checked_at: Date;
  trigger: string;
  url: string;
  status: string;
  http_status: number | null;
  ms: number | null;
  detail: string | null;
}

/** Stores a ping result on the installation and in its ping history. */
export async function savePing(
  installationId: number,
  trigger: 'report' | 'manual',
  url: string,
  r: { status: string; httpStatus: number | null; ms: number | null; detail: string | null },
  sql: Sql = db(),
): Promise<void> {
  await sql.begin(async (tx) => {
    const [{ now }] = await tx<{ now: Date }[]>`SELECT now() AS now`;
    await tx`
      UPDATE installations SET callback_status = ${r.status}, callback_checked_at = ${now},
        callback_http_status = ${r.httpStatus}, callback_ms = ${r.ms}, callback_detail = ${r.detail}
      WHERE id = ${installationId}`;
    await tx`
      INSERT INTO callback_pings (installation_id, checked_at, trigger, url, status, http_status, ms, detail)
      VALUES (${installationId}, ${now}, ${trigger}, ${url}, ${r.status}, ${r.httpStatus}, ${r.ms}, ${r.detail})`;
  });
}

export async function pingHistory(installationId: number, limit = 20, sql: Sql = db()): Promise<PingRow[]> {
  return sql<PingRow[]>`
    SELECT id, checked_at, trigger, url, status, http_status, ms, detail FROM callback_pings
    WHERE installation_id = ${installationId} ORDER BY checked_at DESC, id DESC LIMIT ${limit}`;
}

export async function lastPingUrl(installationId: number, sql: Sql = db()): Promise<string | null> {
  const [row] = await sql<{ url: string }[]>`
    SELECT url FROM callback_pings WHERE installation_id = ${installationId} ORDER BY checked_at DESC, id DESC LIMIT 1`;
  return row?.url ?? null;
}
