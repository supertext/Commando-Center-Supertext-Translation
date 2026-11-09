import Link from 'next/link';
import { requireAuth } from '@/lib/session';
import { listClients, listInstallations, listPlugins } from '@/lib/db';
import { latestReleases, repoUrl } from '@/lib/releases';
import { versionStatus } from '@/lib/semver';
import { CallbackStatus, EVENT_LABEL, KeyStatus, NameVersion, PluginVersion, ago, formatDate, TestBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

type Search = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export default async function InstallationsPage({ searchParams }: { searchParams: Search }) {
  await requireAuth();
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 200);
  const plugin = one(sp.plugin);
  const client = one(sp.client);
  const status = one(sp.status);
  const includeLocal = one(sp.local) === '1';
  const key = one(sp.key);
  const callback = one(sp.callback);

  const clientId = client === 'none' ? 'none' : Number(client) > 0 ? Number(client) : undefined;
  const [all, plugins, clients] = await Promise.all([
    listInstallations({ q, plugin: plugin || undefined, clientId, includeLocal, keyStatus: key || undefined, callback: callback || undefined }),
    listPlugins(),
    listClients(),
  ]);
  const latest = await latestReleases(all.map((i) => i.plugin));
  const withStatus = all.map((i) => ({ ...i, status: versionStatus(i.plugin_version, latest.get(i.plugin) ?? null) }));
  const rows = status ? withStatus.filter((i) => i.status === status) : withStatus;

  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stats = [
    { n: withStatus.length, l: 'installations' },
    { n: withStatus.filter((i) => i.status === 'outdated').length, l: 'with a plugin update available' },
    { n: withStatus.filter((i) => i.api_key_status && i.api_key_status !== 'ok').length, l: 'with an API key problem' },
    { n: withStatus.filter((i) => i.callback_status && i.callback_status !== 'reachable').length, l: 'not reachable from the internet' },
    { n: withStatus.filter((i) => !i.client_id).length, l: 'not mapped to a client' },
    { n: withStatus.filter((i) => new Date(i.last_seen).getTime() >= monthAgo).length, l: 'reported in the last 30 days' },
  ];

  return (
    <>
      <h1>Installations</h1>
      <p className="sub">Every site that runs a Supertext plugin with version reporting on. The site URL identifies the installation.</p>

      <div className="stats">
        {stats.map((s) => (
          <div className="stat" key={s.l}>
            <div className="n">{s.n}</div>
            <div className="l">{s.l}</div>
          </div>
        ))}
      </div>

      <form className="filters" method="get" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search URL, client, system, notes, installed plugins" aria-label="Search" />
        <select name="plugin" defaultValue={plugin} aria-label="Plugin">
          <option value="">All plugins</option>
          {plugins.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select name="client" defaultValue={client} aria-label="Client">
          <option value="">All clients</option>
          <option value="none">Not mapped</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status} aria-label="Plugin version">
          <option value="">Any version</option>
          <option value="outdated">Update available</option>
          <option value="current">Latest</option>
          <option value="unknown">No release</option>
        </select>
        <select name="key" defaultValue={key} aria-label="API key check">
          <option value="">Any API key</option>
          <option value="problem">Key problem</option>
          <option value="ok">Key ok</option>
          <option value="invalid">Key rejected</option>
          <option value="missing">No key</option>
          <option value="unchecked">Not checked</option>
        </select>
        <select name="callback" defaultValue={callback} aria-label="Reachability">
          <option value="">Any reachability</option>
          <option value="problem">Not reachable</option>
          <option value="reachable">Reachable</option>
          <option value="none">No endpoint</option>
        </select>
        <label className="check">
          <input type="checkbox" name="local" value="1" defaultChecked={includeLocal} /> Show test installations
        </label>
        <button type="submit">Filter</button>
        {(q || plugin || client || status || key || callback || includeLocal) && (
          <Link className="link" href="/">
            Reset
          </Link>
        )}
      </form>

      <div className="card table-wrap">
        {rows.length === 0 ? (
          <p className="empty">
            {all.length === 0 && !q && !plugin && !client && !key && !callback
              ? 'No reports yet. Installations appear here once a plugin saves its settings or is updated.'
              : 'No installation matches these filters.'}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Client</th>
                <th>Plugin</th>
                <th>Plugin version</th>
                <th>API key</th>
                <th>Reachable</th>
                <th>System</th>
                <th>Last report</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="url">
                    <Link className="link" href={`/installations/${i.id}`}>
                      {i.site_url.replace(/^https?:\/\//, '')}
                    </Link>{' '}
                    <TestBadge local={i.local} test_override={i.test_override} />
                  </td>
                  <td>
                    {i.client_id ? (
                      <Link className="link" href={`/clients/${i.client_id}`}>
                        {i.client_name}
                      </Link>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td>
                    <a className="link" href={repoUrl(i.plugin)} target="_blank" rel="noopener">
                      {i.plugin.replace(/-Supertext-Translation$/, '')}
                    </a>
                  </td>
                  <td className="stack">
                    <PluginVersion plugin={i.plugin} version={i.plugin_version} latest={latest.get(i.plugin) ?? null} />
                  </td>
                  <td>
                    <KeyStatus
                      status={i.api_key_status}
                      checkedAt={i.api_key_checked_at}
                      httpStatus={i.api_key_http_status}
                      errorCode={i.api_key_error_code}
                    />
                    {i.api_keys && i.api_keys.length > 1 && (
                      <span
                        className="muted small"
                        title={i.api_keys.map((k) => `${k.name}: ${k.status ?? (k.configured ? 'set' : 'not set')}`).join('\n')}
                      >
                        {' '}
                        {i.api_keys.length} keys
                      </span>
                    )}
                  </td>
                  <td>
                    <CallbackStatus
                      url={i.callback_url}
                      status={i.callback_status}
                      ms={i.callback_ms}
                      checkedAt={i.callback_checked_at}
                      detail={i.callback_detail}
                    />
                  </td>
                  <td className="stack">
                    <NameVersion name={i.system} version={i.system_version} />
                    <div className="muted small">
                      <NameVersion name={i.runtime} version={i.runtime_version} />
                    </div>
                  </td>
                  <td title={formatDate(i.last_seen)} className="stack">
                    {ago(i.last_seen)}
                    <span className="badge event">{EVENT_LABEL[i.last_event] ?? i.last_event}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
