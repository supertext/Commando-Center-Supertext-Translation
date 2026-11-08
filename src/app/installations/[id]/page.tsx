import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/session';
import { getInstallation, installationHistory, listClients, pingHistory, type Installation, type ReportRow } from '@/lib/db';
import { latestRelease, repoUrl } from '@/lib/releases';
import { extensionChanges, sortExtensions } from '@/lib/extensions';
import { CallbackStatus, EVENT_LABEL, KeyStatus, NameVersion, PluginVersion, ago, formatDate, keyStatusWord } from '@/components/ui';
import ConfirmButton from '@/components/confirm-button';
import { pingNow, removeInstallation, saveInstallation } from '../../actions';

export const dynamic = 'force-dynamic';

/** What changed in a report compared with the reports before it (history is newest first). */
function changes(history: ReportRow[], k: number, i: Installation): string[] {
  const out = versionAndKeyChanges(history, k, i);
  const row = history[k];
  // Installed plugins: compared with the last report that carried a list.
  if (row.extensions) {
    const prev = history.slice(k + 1).find((h) => h.extensions)?.extensions ?? null;
    out.push(...extensionChanges(prev, row.extensions));
  }
  return out;
}

function versionAndKeyChanges(history: ReportRow[], k: number, i: Installation): string[] {
  const row = history[k];
  const before = history[k + 1];
  if (!before) return row.api_key_status ? ['first report', `API key ${keyStatusWord(row.api_key_status)}`] : ['first report'];
  const out: string[] = [];
  const diff = (label: string, a: string | null, b: string | null) => {
    if (a !== b) out.push(`${label} ${a ?? '–'} → ${b ?? '–'}`);
  };
  diff('Plugin', before.plugin_version, row.plugin_version);
  diff(i.system, before.system_version, row.system_version);
  diff(i.runtime ?? 'Runtime', before.runtime_version, row.runtime_version);
  diff('SDK', before.sdk_version, row.sdk_version);
  if (before.api_key_configured !== row.api_key_configured && row.api_key_configured !== null) {
    out.push(row.api_key_configured ? 'API key set' : 'API key removed');
  }
  // Named keys: what changed per key, compared with the last report that had them.
  if (row.api_keys) {
    const prevKeys = history.slice(k + 1).find((h) => h.api_keys)?.api_keys ?? null;
    for (const key of row.api_keys) {
      const old = prevKeys?.find((p) => p.name === key.name);
      if (!old) out.push(`${key.name}: ${key.status ? keyStatusWord(key.status) : key.configured ? 'set' : 'not set'}`);
      else if (key.status && old.status !== key.status)
        out.push(`${key.name}: ${old.status ? `${keyStatusWord(old.status)} → ` : ''}${keyStatusWord(key.status)}`);
      else if (old.configured !== key.configured && key.configured !== null) out.push(`${key.name}: ${key.configured ? 'set' : 'removed'}`);
    }
    for (const old of prevKeys ?? []) if (!row.api_keys.some((x) => x.name === old.name)) out.push(`${old.name}: no longer reported`);
    return out;
  }
  // Reports without a check (e.g. upgrades) don't change the key status: compare with the last check before.
  if (row.api_key_status) {
    const prev = history.slice(k + 1).find((h) => h.api_key_status)?.api_key_status ?? null;
    if (prev !== row.api_key_status) {
      out.push(prev ? `API key ${keyStatusWord(prev)} → ${keyStatusWord(row.api_key_status)}` : `API key ${keyStatusWord(row.api_key_status)}`);
    }
  }
  return out;
}

export default async function InstallationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAuth();
  const { id } = await params;
  const sp = await searchParams;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) notFound();
  const i = await getInstallation(n);
  if (!i) notFound();
  const [history, clients, latest, pings] = await Promise.all([
    installationHistory(n),
    listClients(),
    latestRelease(i.plugin),
    pingHistory(n),
  ]);

  return (
    <>
      <p className="small">
        <Link className="link" href="/">
          ← Installations
        </Link>
      </p>
      <h1 className="row">
        {i.site_url}
        {i.local && <span className="badge local">local</span>}
      </h1>
      <p className="sub">
        <a className="link" href={i.site_url} target="_blank" rel="noopener noreferrer">
          Open site
        </a>{' '}
        · first report {formatDate(i.first_seen)} · {i.report_count} reports
      </p>
      {sp.saved && <p className="notice">Saved.</p>}

      <div className="grid2">
        <section className="card" aria-labelledby="state">
          <h2 id="state" style={{ margin: 0, padding: '14px 20px 0' }}>
            Latest report
          </h2>
          <dl className="facts">
            <dt>Plugin</dt>
            <dd>
              <a className="link" href={repoUrl(i.plugin)} target="_blank" rel="noopener">
                {i.plugin}
              </a>
            </dd>
            <dt>Plugin version</dt>
            <dd>
              <PluginVersion plugin={i.plugin} version={i.plugin_version} latest={latest} />
            </dd>
            <dt>System</dt>
            <dd>
              <NameVersion name={i.system} version={i.system_version} />
            </dd>
            <dt>Runtime</dt>
            <dd>
              <NameVersion name={i.runtime} version={i.runtime_version} />
            </dd>
            <dt>SDK</dt>
            <dd className="mono">{i.sdk_version ?? '–'}</dd>
            <dt>{i.api_keys ? 'API keys' : 'API key'}</dt>
            <dd>
              {i.api_keys ? (
                i.api_keys.length === 0 ? (
                  <span className="muted small">none reported</span>
                ) : (
                  <ul className="keys">
                    {i.api_keys.map((key) => (
                      <li key={key.name} className="row" style={{ gap: 6 }}>
                        <span>{key.name}</span>
                        <KeyStatus status={key.status} checkedAt={key.checked_at} httpStatus={key.http_status} errorCode={key.error_code} />
                        {key.checked_at && <span className="muted small">checked {formatDate(key.checked_at)}</span>}
                        {(key.http_status || key.error_code) && key.status !== 'ok' && (
                          <span className="mono small">
                            {[key.http_status ? `HTTP ${key.http_status}` : '', key.error_code ?? ''].filter(Boolean).join(' ')}
                          </span>
                        )}
                        {!key.status && key.configured !== null && <span className="muted small">{key.configured ? 'set' : 'not set'}</span>}
                      </li>
                    ))}
                  </ul>
                )
              ) : (
              <span className="row" style={{ gap: 6 }}>
                <KeyStatus
                  status={i.api_key_status}
                  checkedAt={i.api_key_checked_at}
                  httpStatus={i.api_key_http_status}
                  errorCode={i.api_key_error_code}
                />
                {i.api_key_checked_at && <span className="muted small">checked {formatDate(i.api_key_checked_at)}</span>}
                {(i.api_key_http_status || i.api_key_error_code) && i.api_key_status !== 'ok' && (
                  <span className="mono small">
                    {[i.api_key_http_status ? `HTTP ${i.api_key_http_status}` : '', i.api_key_error_code ?? ''].filter(Boolean).join(' ')}
                  </span>
                )}
                {!i.api_key_status && i.api_key_configured !== null && (
                  <span className="muted small">{i.api_key_configured ? 'set' : 'not set'}</span>
                )}
              </span>
              )}
            </dd>
            <dt>Last report</dt>
            <dd>
              {formatDate(i.last_seen)} ({ago(i.last_seen)}), {EVENT_LABEL[i.last_event] ?? i.last_event}
            </dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="mapping">
          <h2 id="mapping" style={{ margin: 0, padding: '14px 20px 0' }}>
            Client and notes
          </h2>
          <form action={saveInstallation} className="form-body">
            <input type="hidden" name="id" value={i.id} />
            <label>
              Client
              <select name="client" defaultValue={i.client_id ? String(i.client_id) : 'none'}>
                <option value="none">Not mapped</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Or a new client
              <input name="new_client" placeholder="Client name" maxLength={200} />
            </label>
            <label>
              Notes
              <textarea name="notes" defaultValue={i.notes} maxLength={5000} placeholder="Contact, staging or production, …" />
            </label>
            <div className="row">
              <button type="submit" className="primary">
                Save
              </button>
            </div>
          </form>
        </section>
      </div>

      <h2 id="callback">Reachable from the internet</h2>
      <section className="card" aria-labelledby="callback">
        {sp.pinged && <p className="notice" style={{ margin: '16px 20px 0' }}>Pinged.</p>}
        {sp.ping_skipped && (
          <p className="notice error" style={{ margin: '16px 20px 0' }}>
            Not pinged: {sp.ping_skipped}.
          </p>
        )}
        <dl className="facts">
          <dt>Ping endpoint</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {i.callback_url ?? <span className="muted">none reported (older plugin version, hosted app or reporting off)</span>}
          </dd>
          <dt>Last ping</dt>
          <dd>
            <span className="row" style={{ gap: 6 }}>
              <CallbackStatus
                url={i.callback_url}
                status={i.callback_status}
                ms={i.callback_ms}
                checkedAt={i.callback_checked_at}
                detail={i.callback_detail}
              />
              {i.callback_checked_at && <span className="muted small">{formatDate(i.callback_checked_at)}</span>}
              {i.callback_detail && <span className="small">{i.callback_detail}</span>}
            </span>
          </dd>
        </dl>
        {i.callback_url && (
          <form action={pingNow} className="row" style={{ padding: '0 20px 16px' }}>
            <input type="hidden" name="id" value={i.id} />
            <button type="submit">Ping now</button>
            <span className="muted small">Calls the endpoint from the center with a new challenge.</span>
          </form>
        )}
        {pings.length > 0 && (
          <div className="table-wrap" style={{ borderTop: '1px solid var(--line)' }}>
            <table>
              <thead>
                <tr>
                  <th>Pinged</th>
                  <th>Trigger</th>
                  <th>Result</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {pings.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDate(p.checked_at)}</td>
                    <td>
                      <span className="badge event">{p.trigger === 'manual' ? 'Ping now' : 'report'}</span>
                    </td>
                    <td>
                      <CallbackStatus url={p.url} status={p.status} ms={p.ms} checkedAt={p.checked_at} detail={p.detail} />
                    </td>
                    <td className="small" style={{ whiteSpace: 'normal' }}>
                      {[p.http_status ? `HTTP ${p.http_status}` : '', p.detail ?? ''].filter(Boolean).join(' · ') || '–'}
                      {p.url !== i.callback_url && <div className="muted mono">{p.url}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <h2 id="extensions">Installed plugins</h2>
      <section className="card" aria-labelledby="extensions">
        {i.extensions === null ? (
          <p className="muted" style={{ padding: '14px 20px', margin: 0 }}>
            Not sent. The site&apos;s administrator sends the list of the other plugins installed on the site with the
            button in the Supertext plugin&apos;s settings (plugins with Plugin Health 0.3 or newer).
          </p>
        ) : (
          <>
            <p className="small" style={{ padding: '14px 20px 0', margin: 0 }}>
              {i.extensions.length} {i.extensions.length === 1 ? 'plugin' : 'plugins'},{' '}
              {i.extensions.filter((e) => e.active !== false).length} active · sent{' '}
              {i.extensions_at ? `${formatDate(i.extensions_at)} (${ago(i.extensions_at)})` : '–'}
            </p>
            {i.extensions.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 12, borderTop: '1px solid var(--line)' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Version</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortExtensions(i.extensions).map((e) => (
                      <tr key={`${e.type ?? ''}:${e.name}`}>
                        <td>{e.name}</td>
                        <td className="muted">{e.type ?? '–'}</td>
                        <td className="mono">{e.version ?? '–'}</td>
                        <td>
                          {e.active === null ? (
                            <span className="muted">–</span>
                          ) : (
                            <span className={`badge ${e.active ? 'current' : 'unknown'}`}>{e.active ? 'active' : 'inactive'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <h2>History</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Event</th>
              <th>Plugin</th>
              <th>{i.system}</th>
              <th>{i.runtime ?? 'Runtime'}</th>
              <th>API key</th>
              <th>Changes</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r, k) => {
              const c = changes(history, k, i);
              return (
                <tr key={r.id}>
                  <td>{formatDate(r.received_at)}</td>
                  <td>
                    <span className="badge event">{EVENT_LABEL[r.event] ?? r.event}</span>
                  </td>
                  <td className="mono">{r.plugin_version}</td>
                  <td className="mono">{r.system_version ?? '–'}</td>
                  <td className="mono">{r.runtime_version ?? '–'}</td>
                  <td>
                    {r.api_key_status ? (
                      <KeyStatus
                        status={r.api_key_status}
                        checkedAt={r.api_key_checked_at}
                        httpStatus={r.api_key_http_status}
                        errorCode={r.api_key_error_code}
                      />
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td className={c.length ? '' : 'muted'} style={{ whiteSpace: 'normal' }}>
                    {c.length ? c.join(', ') : 'no change'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {history.length >= 200 && <p className="small muted">Showing the latest 200 reports.</p>}

      <h2>Remove</h2>
      <form action={removeInstallation} className="row">
        <input type="hidden" name="id" value={i.id} />
        <span className="muted">Deletes this installation and its history. If the plugin reports again, it comes back as new.</span>
        <ConfirmButton message={`Delete ${i.site_url} and its history?`}>Delete installation</ConfirmButton>
      </form>
    </>
  );
}
