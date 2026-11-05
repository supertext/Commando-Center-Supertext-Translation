import { redirect } from 'next/navigation';
import { isSignedIn } from '@/lib/session';
import { sessionSecret } from '@/lib/auth';
import { oidcConfig, oidcProblem } from '@/lib/oidc';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  denied: 'Your Supertext account isn’t allowed to use Plugin Health. Ask an administrator for access.',
  failed: 'Signing in with Supertext didn’t work. Try again.',
  expired: 'The sign-in took too long or was started in another browser. Try again.',
  unavailable: 'Supertext’s login service can’t be reached right now. Try again in a moment.',
  busy: 'Too many sign-in attempts. Wait 15 minutes and try again.',
  config: 'Signing in with a Supertext account isn’t set up correctly.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isSignedIn()) redirect('/');
  const { error } = await searchParams;
  const cfg = oidcConfig();
  const problem = oidcProblem(cfg, sessionSecret() !== null);
  const sso = cfg !== null && problem === null;
  const message = error ? ERRORS[error] : undefined;
  return (
    <div className="card login">
      <h1>Plugin Health</h1>
      {message && (
        <p className="notice error" role="alert">
          {message}
        </p>
      )}
      {problem && (
        <p className="notice error">
          Sign-in with a Supertext account is not configured correctly: {problem}
        </p>
      )}
      {sso && (
        <div className="form-body" style={{ padding: 0 }}>
          <a className="button primary" href="/auth/login">
            Sign in with Supertext
          </a>
          <p className="muted" style={{ margin: 0 }}>
            With your Supertext staff account.
          </p>
        </div>
      )}
      {!cfg && (
        <p className="notice error">
          Login is not configured yet. Set <code>COMMANDO_OIDC_ISSUER</code>, <code>COMMANDO_OIDC_CLIENT_ID</code> and{' '}
          <code>COMMANDO_SESSION_SECRET</code> in the service variables.
        </p>
      )}
    </div>
  );
}
