/**
 * Which plugins send their translations through the Supertext translation
 * proxy (Localization-Review-Supertext-Translation). Read from the proxy's
 * usage API with a shared token; usage only (plugin, version, tenant label,
 * counters), never translations or review links. Cached in memory for a minute.
 *
 *   COMMANDO_PROXY_URL    the proxy's base URL, e.g. https://review-proxy.up.railway.app
 *   COMMANDO_PROXY_TOKEN  the same value as REVIEW_USAGE_TOKEN on the proxy
 */
const TTL_MS = 60 * 1000;
const MAX_BYTES = 2_000_000;

export interface ProxyIntegration {
  /** The tenant: SHA-256 fingerprint of the plugin's Supertext API key. */
  tenant: string;
  tenantLabel: string;
  /** The plugin's repo name, '' when the plugin sent none. */
  plugin: string;
  pluginVersion: string;
  sdk: string;
  keyChecks: number;
  uploads: number;
  memoryAnswers: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type ProxyUsage =
  | { status: 'ok'; generatedAt: string; integrations: ProxyIntegration[] }
  | { status: 'not_configured' }
  | { status: 'error'; detail: string };

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const time = (v: unknown): string | null => {
  const s = str(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};

/** Validates the usage API's answer (schema 1). Invalid entries are dropped; null if the body isn't schema 1. */
export function parseUsage(body: unknown): { generatedAt: string; integrations: ProxyIntegration[] } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { schema?: unknown; generatedAt?: unknown; integrations?: unknown };
  if (b.schema !== 1 || !Array.isArray(b.integrations)) return null;
  const integrations: ProxyIntegration[] = [];
  for (const raw of b.integrations.slice(0, 10_000)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const entry = {
      tenant: str(r.tenant, 64),
      tenantLabel: str(r.tenantLabel, 200),
      plugin: str(r.plugin, 100),
      pluginVersion: str(r.pluginVersion, 40),
      sdk: str(r.sdk, 20),
      keyChecks: count(r.keyChecks),
      uploads: count(r.uploads),
      memoryAnswers: count(r.memoryAnswers),
      firstSeenAt: time(r.firstSeenAt),
      lastSeenAt: time(r.lastSeenAt),
    };
    if (Object.values(entry).some((v) => v === null) || !/^[0-9a-f]{64}$/.test(entry.tenant!)) continue;
    integrations.push(entry as ProxyIntegration);
  }
  return { generatedAt: time(b.generatedAt) ?? new Date().toISOString(), integrations };
}

let cache: { at: number; value: ProxyUsage } | null = null;

export function proxyConfig(env: Record<string, string | undefined> = process.env): { url: string; token: string } | null {
  const url = env.COMMANDO_PROXY_URL?.trim().replace(/\/+$/, '');
  const token = env.COMMANDO_PROXY_TOKEN?.trim();
  if (!url || !token || !/^https?:\/\//.test(url)) return null;
  return { url, token };
}

export async function proxyUsage(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<ProxyUsage> {
  const config = proxyConfig();
  if (!config) return { status: 'not_configured' };
  if (cache && now - cache.at < TTL_MS) return cache.value;
  let value: ProxyUsage;
  try {
    const res = await fetchImpl(`${config.url}/api/usage`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json', 'User-Agent': 'supertext-commando-center' },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) value = { status: 'error', detail: `The proxy answered HTTP ${res.status}${res.status === 401 ? ' (check COMMANDO_PROXY_TOKEN)' : ''}.` };
    else if (text.length > MAX_BYTES) value = { status: 'error', detail: 'The proxy’s answer is too large.' };
    else {
      const parsed = parseUsage(JSON.parse(text));
      value = parsed ? { status: 'ok', ...parsed } : { status: 'error', detail: 'The proxy’s answer has an unknown format.' };
    }
  } catch (e) {
    value = { status: 'error', detail: e instanceof Error && e.name === 'TimeoutError' ? 'The proxy didn’t answer within 5 seconds.' : 'The proxy can’t be reached.' };
  }
  cache = { at: now, value };
  return value;
}

export function clearProxyUsageCache(): void {
  cache = null;
}
