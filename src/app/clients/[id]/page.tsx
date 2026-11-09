import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/session';
import { getClient, listInstallations } from '@/lib/db';
import { latestReleases } from '@/lib/releases';
import { CallbackStatus, KeyStatus, NameVersion, PluginVersion, ago, formatDate, TestBadge } from '@/components/ui';
import ConfirmButton from '@/components/confirm-button';
import { removeClient, saveClient } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function ClientPage({
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
  const client = await getClient(n);
  if (!client) notFound();
  const installations = await listInstallations({ clientId: n, includeLocal: true });
  const latest = await latestReleases(installations.map((i) => i.plugin));

  return (
    <>
      <p className="small">
        <Link className="link" href="/clients">
          ← Clients
        </Link>
      </p>
      <h1>{client.name}</h1>
      <p className="sub">Client since {formatDate(client.created_at)}</p>
      {sp.saved && <p className="notice">Saved.</p>}
      {sp.error === 'duplicate' && <p className="notice error">Another client already has that name.</p>}

      <h2>Installations</h2>
      <div className="card table-wrap">
        {installations.length === 0 ? (
          <p className="empty">No installations mapped to this client yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Plugin</th>
                <th>Plugin version</th>
                <th>API key</th>
                <th>Reachable</th>
                <th>System</th>
                <th>Runtime</th>
                <th>Last report</th>
              </tr>
            </thead>
            <tbody>
              {installations.map((i) => (
                <tr key={i.id}>
                  <td className="url">
                    <Link className="link" href={`/installations/${i.id}`}>
                      {i.site_url.replace(/^https?:\/\//, '')}
                    </Link>{' '}
                    <TestBadge local={i.local} test_override={i.test_override} />
                  </td>
                  <td>{i.plugin.replace(/-Supertext-Translation$/, '')}</td>
                  <td>
                    <PluginVersion plugin={i.plugin} version={i.plugin_version} latest={latest.get(i.plugin) ?? null} />
                  </td>
                  <td>
                    <KeyStatus status={i.api_key_status} checkedAt={i.api_key_checked_at} httpStatus={i.api_key_http_status} errorCode={i.api_key_error_code} />
                  </td>
                  <td>
                    <CallbackStatus url={i.callback_url} status={i.callback_status} ms={i.callback_ms} checkedAt={i.callback_checked_at} detail={i.callback_detail} />
                  </td>
                  <td>
                    <NameVersion name={i.system} version={i.system_version} />
                  </td>
                  <td>
                    <NameVersion name={i.runtime} version={i.runtime_version} />
                  </td>
                  <td title={formatDate(i.last_seen)}>{ago(i.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Details</h2>
      <form action={saveClient} className="card form-body" style={{ maxWidth: 640 }}>
        <input type="hidden" name="id" value={client.id} />
        <label>
          Name
          <input name="name" defaultValue={client.name} required maxLength={200} />
        </label>
        <label>
          Notes
          <textarea name="notes" defaultValue={client.notes} maxLength={5000} placeholder="Account, contact person, …" />
        </label>
        <div className="row">
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>

      <h2>Remove</h2>
      <form action={removeClient} className="row">
        <input type="hidden" name="id" value={client.id} />
        <span className="muted">Deletes the client. Its installations stay and become unmapped.</span>
        <ConfirmButton message={`Delete the client ${client.name}?`}>Delete client</ConfirmButton>
      </form>
    </>
  );
}
