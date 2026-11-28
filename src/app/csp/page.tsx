import { requireAuth } from '@/lib/session';
import { listCspViolations, pruneCspViolations } from '@/lib/db';
import { formatDate } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** What the Content-Security-Policy of our own pages blocked in browsers (the last 30 days). */
export default async function CspPage() {
  await requireAuth();
  await pruneCspViolations(90); // fixed ones disappear after 90 days without a report
  const rows = await listCspViolations(30);
  const sites = new Set(rows.map((r) => r.site));
  const enforced = rows.filter((r) => r.enforced).reduce((n, r) => n + r.count, 0);
  return (
    <>
      <h1>CSP reports</h1>
      <p className="sub">
        What the Content-Security-Policy of our own pages (hosted apps, Plugin Health, the translation proxy, the Toolbox, the
        integrations site) blocked in visitors&apos; browsers in the last 30 days. <em>Blocked</em> rows broke something on a live
        page; <em>Report only</em> rows come from a stricter policy being tried out. Only the page&apos;s path and the blocked
        source&apos;s origin are kept.
      </p>
      <div className="stats">
        <div className="stat"><div className="n">{sites.size}</div><div className="l">Sites with reports</div></div>
        <div className="stat"><div className="n">{enforced}</div><div className="l">Blocked (30 days)</div></div>
        <div className="stat"><div className="n">{rows.length}</div><div className="l">Different violations</div></div>
      </div>
      <div className="card table-wrap">
        {rows.length === 0 ? (
          <p className="empty">No CSP violations reported in the last 30 days.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Page</th>
                <th>Directive</th>
                <th>Blocked</th>
                <th>Mode</th>
                <th>Count</th>
                <th>First seen</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.site}|${r.page}|${r.directive}|${r.blocked}|${r.enforced}`}>
                  <td className="mono">{r.site}</td>
                  <td className="mono">{r.page}</td>
                  <td className="mono">{r.directive}</td>
                  <td className="mono">{r.blocked}</td>
                  <td>{r.enforced ? 'Blocked' : 'Report only'}</td>
                  <td>{r.count}</td>
                  <td>{formatDate(r.first_seen_at)}</td>
                  <td>{formatDate(r.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
