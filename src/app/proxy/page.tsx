import { requireAuth } from '@/lib/session';
import { proxyUsage } from '@/lib/proxy-usage';
import { latestReleases, repoUrl } from '@/lib/releases';
import { formatDate, PluginVersion } from '@/components/ui';

export const dynamic = 'force-dynamic';

const tenantName = (label: string, tenant: string) => label || `Key ${tenant.slice(0, 10)}…`;

/** Plugins that send their translations through the Supertext translation proxy. */
export default async function ProxyPage() {
  await requireAuth();
  const usage = await proxyUsage();
  const rows = usage.status === 'ok' ? usage.integrations : [];
  const latest = await latestReleases(rows.filter((r) => r.plugin).map((r) => r.plugin));
  const plugins = new Set(rows.filter((r) => r.plugin).map((r) => r.plugin));
  const tenants = new Set(rows.map((r) => r.tenant));
  const uploads = rows.reduce((n, r) => n + r.uploads, 0);
  const memory = rows.reduce((n, r) => n + r.memoryAnswers, 0);
  return (
    <>
      <h1>Translation proxy</h1>
      <p className="sub">
        Plugins that send their translations through the Supertext translation proxy, per customer (the proxy&apos;s tenant: one
        Supertext API key). <em>From the memory</em> counts uploads the proxy answered without calling Supertext. Translations and
        review links are managed in the proxy itself.
      </p>
      {usage.status === 'not_configured' && (
        <p className="notice">
          Not connected to the proxy yet. Set <code>COMMANDO_PROXY_URL</code> and <code>COMMANDO_PROXY_TOKEN</code> (the proxy&apos;s{' '}
          <code>REVIEW_USAGE_TOKEN</code>) in the service variables.
        </p>
      )}
      {usage.status === 'error' && <p className="notice error">{usage.detail}</p>}
      {usage.status === 'ok' && (
        <>
          <div className="stats">
            <div className="stat"><div className="n">{plugins.size}</div><div className="l">Plugins</div></div>
            <div className="stat"><div className="n">{tenants.size}</div><div className="l">Customers (API keys)</div></div>
            <div className="stat"><div className="n">{uploads}</div><div className="l">Uploads</div></div>
            <div className="stat">
              <div className="n">{uploads ? Math.round((100 * memory) / uploads) : 0} %</div>
              <div className="l">Answered from the memory</div>
            </div>
          </div>
          <div className="card table-wrap">
            {rows.length === 0 ? (
              <p className="empty">No plugin has used the proxy yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Plugin</th>
                    <th>Version</th>
                    <th>Customer</th>
                    <th>Uploads</th>
                    <th>From the memory</th>
                    <th>Key checks</th>
                    <th>First request</th>
                    <th>Last request</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.tenant}|${r.plugin}`}>
                      <td className="url">
                        {r.plugin ? (
                          <a className="link" href={repoUrl(r.plugin)} target="_blank" rel="noopener">{r.plugin}</a>
                        ) : (
                          <span className="muted">Unknown plugin</span>
                        )}
                        {r.sdk && <div className="small muted">SDK: {r.sdk}</div>}
                      </td>
                      <td>{r.plugin && r.pluginVersion ? <PluginVersion plugin={r.plugin} version={r.pluginVersion} latest={latest.get(r.plugin) ?? null} /> : '–'}</td>
                      <td className="url">{tenantName(r.tenantLabel, r.tenant)}</td>
                      <td>{r.uploads}</td>
                      <td>{r.uploads ? `${r.memoryAnswers} (${Math.round((100 * r.memoryAnswers) / r.uploads)} %)` : '–'}</td>
                      <td>{r.keyChecks}</td>
                      <td>{formatDate(r.firstSeenAt)}</td>
                      <td>{formatDate(r.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="small muted">As of {formatDate(usage.generatedAt)}; refreshed every minute.</p>
        </>
      )}
    </>
  );
}
