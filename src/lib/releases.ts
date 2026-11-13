/**
 * Latest published release of each plugin, read from GitHub (supertext/<repository>).
 * The plugins publish 0.x versions as pre-releases, so /releases/latest (which skips them)
 * isn't enough: take the newest non-draft release from the list. Cached in memory.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; version: string | null }>();

export const GITHUB_OWNER = process.env.GITHUB_OWNER || 'supertext';

/** Plugins whose repository isn't named like the plugin name they report. */
const REPOSITORIES: Record<string, string> = {
  'supertext-wordpress-polylang': 'Wordpress-Polylang-Supertext-Translation',
  'supertext-wordpress-wpml': 'Wordpress-WPML-Supertext-Translation',
};

/** The GitHub repository of a reported plugin name. */
export function repoName(plugin: string): string {
  return REPOSITORIES[plugin] ?? plugin;
}
const GITHUB_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

export function releaseUrl(plugin: string, version: string): string | null {
  return /^v?\d+\.\d+\.\d+/.test(version)
    ? `https://github.com/${GITHUB_OWNER}/${encodeURIComponent(repoName(plugin))}/releases/tag/v${version.replace(/^v/, '')}`
    : null;
}

export function repoUrl(plugin: string): string {
  return `https://github.com/${GITHUB_OWNER}/${encodeURIComponent(repoName(plugin))}`;
}

export async function latestRelease(plugin: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const hit = cache.get(plugin);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.version;
  let version: string | null = null;
  let ttl = TTL_MS;
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'supertext-commando-center' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetchImpl(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${encodeURIComponent(repoName(plugin))}/releases?per_page=10`,
      { headers, signal: AbortSignal.timeout(5000), cache: 'no-store' },
    );
    if (res.ok) {
      const list = (await res.json()) as Array<{ tag_name?: string; draft?: boolean }>;
      const tag = list.find((r) => !r.draft && r.tag_name)?.tag_name;
      version = tag ? tag.replace(/^v/, '') : null;
    } else if (res.status !== 404) {
      ttl = FAIL_TTL_MS; // rate limit or outage: try again sooner
    }
  } catch {
    ttl = FAIL_TTL_MS;
  }
  cache.set(plugin, { at: Date.now(), ttl, version });
  return version;
}

export async function latestReleases(plugins: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(plugins)];
  const versions = await Promise.all(unique.map((p) => latestRelease(p)));
  return new Map(unique.map((p, i) => [p, versions[i]]));
}

export function clearReleaseCache(): void {
  cache.clear();
}
