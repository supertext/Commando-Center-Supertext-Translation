import { releaseUrl } from '@/lib/releases';
import { versionStatus, type VersionStatus } from '@/lib/semver';

const TZ = process.env.COMMANDO_TIMEZONE || 'Europe/Zurich';

export function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString('de-CH', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ago(d: Date | string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

const LABEL: Record<VersionStatus, string> = {
  current: 'latest',
  outdated: 'update available',
  ahead: 'newer than release',
  unknown: 'no release',
};

export function PluginVersion({ plugin, version, latest }: { plugin: string; version: string; latest: string | null }) {
  const status = versionStatus(version, latest);
  const url = releaseUrl(plugin, version);
  return (
    <span className="row" style={{ gap: 6 }}>
      {url ? (
        <a className="link mono" href={url} target="_blank" rel="noopener">
          {version}
        </a>
      ) : (
        <span className="mono">{version}</span>
      )}
      <span className={`badge ${status}`} title={latest ? `Latest release: ${latest}` : 'No published release found on GitHub'}>
        {status === 'outdated' && latest ? `${latest} available` : LABEL[status]}
      </span>
    </span>
  );
}

export function NameVersion({ name, version }: { name: string | null; version: string | null }) {
  if (!name) return <span className="muted">–</span>;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {name} {version && <span className="mono">{version}</span>}
    </span>
  );
}

export const EVENT_LABEL: Record<string, string> = {
  installed: 'installed',
  settings_saved: 'settings saved',
  upgraded: 'upgraded',
  api_key_check: 'key checked',
  check: 'check',
  extensions: 'plugins sent',
  languages: 'languages sent',
};

const KEY_LABEL: Record<string, { label: string; cls: string; hint: string }> = {
  ok: { label: 'key ok', cls: 'current', hint: 'Supertext accepted the API key' },
  invalid: { label: 'key rejected', cls: 'bad', hint: 'Supertext rejected the API key (HTTP 401/403)' },
  missing: { label: 'no key', cls: 'bad', hint: 'No API key is set' },
  unreachable: { label: 'Supertext unreachable', cls: 'outdated', hint: "The plugin couldn't reach Supertext to check the key" },
  error: { label: 'check failed', cls: 'outdated', hint: 'Supertext answered the check with an unexpected error' },
};

/** Result of the plugin's latest automatic API key check. */
/**
 * "test" when the installation counts as a test installation (marked by staff, or a local or test host while
 * nobody chose), nothing for a real one.
 */
export function TestBadge({ local, test_override }: { local: boolean; test_override: boolean | null }) {
  if (!(test_override ?? local)) return null;
  return (
    <span className="badge local" title={test_override ? 'Marked as a test installation' : 'Local or test host (automatic)'}>
      test
    </span>
  );
}

export function KeyStatus({
  status,
  checkedAt,
  httpStatus,
  errorCode,
}: {
  status: string | null;
  checkedAt?: Date | string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
}) {
  if (!status) {
    return (
      <span className="badge unknown" title="This plugin version doesn't send an API key check yet">
        not checked
      </span>
    );
  }
  const k = KEY_LABEL[status] ?? { label: status, cls: 'outdated', hint: 'Unknown check result' };
  const detail = [httpStatus ? `HTTP ${httpStatus}` : '', errorCode ?? ''].filter(Boolean).join(', ');
  const title = [k.hint, detail, checkedAt ? `checked ${formatDate(checkedAt)}` : ''].filter(Boolean).join(' · ');
  return (
    <span className={`badge ${k.cls}`} title={title}>
      {k.label}
      {status === 'error' && httpStatus ? ` (${httpStatus})` : ''}
    </span>
  );
}

const KEY_WORD: Record<string, string> = {
  ok: 'ok',
  invalid: 'rejected',
  missing: 'missing',
  unreachable: 'not checked (Supertext unreachable)',
  error: 'check failed',
};

/** Short wording for history lines: "API key rejected → ok". */
export function keyStatusWord(status: string | null): string {
  return status ? (KEY_WORD[status] ?? status) : 'not checked';
}

const CALLBACK_LABEL: Record<string, { label: string; cls: string; hint: string }> = {
  reachable: { label: 'reachable', cls: 'current', hint: 'The plugin answered the ping from the internet' },
  unreachable: { label: 'not reachable', cls: 'bad', hint: 'No connection: DNS, firewall, timeout or TLS problem' },
  blocked: { label: 'blocked', cls: 'bad', hint: 'The site answered with an error or a redirect (login, firewall)' },
  wrong_answer: { label: 'wrong answer', cls: 'outdated', hint: 'Something answered, but not the plugin (cache, firewall or login page)' },
  refused: { label: 'refused', cls: 'outdated', hint: "The center didn't ping this URL (not on the site's host, or a private address)" },
};

/** Result of the latest callback ping. */
export function CallbackStatus({
  url,
  status,
  ms,
  checkedAt,
  detail,
}: {
  url: string | null;
  status: string | null;
  ms?: number | null;
  checkedAt?: Date | string | null;
  detail?: string | null;
}) {
  if (!url) {
    return (
      <span className="badge unknown" title="This plugin version reports no ping endpoint">
        no endpoint
      </span>
    );
  }
  if (!status) {
    return (
      <span className="badge unknown" title="Endpoint reported, not pinged yet">
        not pinged
      </span>
    );
  }
  const c = CALLBACK_LABEL[status] ?? { label: status, cls: 'outdated', hint: 'Unknown result' };
  const title = [c.hint, detail ?? '', checkedAt ? `pinged ${formatDate(checkedAt)}` : ''].filter(Boolean).join(' · ');
  return (
    <span className={`badge ${c.cls}`} title={title}>
      {c.label}
      {status === 'reachable' && ms != null ? ` · ${ms} ms` : ''}
    </span>
  );
}
