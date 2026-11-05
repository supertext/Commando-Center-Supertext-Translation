import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, createSession } from '@/lib/auth';
import { OidcError, displayName, finishSignIn, oidcConfig, publicBaseUrl } from '@/lib/oidc';
import { FLOW_COOKIE, ID_TOKEN_COOKIE, MAX_ID_TOKEN, cookieOptions, unsealFlow } from '@/lib/oidc-cookies';
import { RateLimiter, clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const attempts = new RateLimiter(30, 15 * 60_000);

/** Public: the Person Service sends people back here with the authorization code. */
export async function GET(request: NextRequest) {
  const base = publicBaseUrl(request.headers);
  const fail = (error: string) => {
    const res = NextResponse.redirect(`${base}/login?error=${error}`, 303);
    res.cookies.set(FLOW_COOKIE, '', cookieOptions('/auth', 0));
    return res;
  };
  const cfg = oidcConfig();
  if (!cfg) return fail('config');
  if (!attempts.take(clientIp(request.headers))) return fail('busy');
  const tx = unsealFlow(request.cookies.get(FLOW_COOKIE)?.value);
  if (!tx) return fail('expired');

  const q = request.nextUrl.searchParams;
  try {
    const { claims, idToken } = await finishSignIn(
      cfg,
      tx,
      { code: q.get('code'), state: q.get('state'), error: q.get('error') },
      `${base}/auth/callback`,
    );
    const session = createSession({
      sub: String(claims.sub),
      name: displayName(claims),
      email: typeof claims.email === 'string' ? claims.email : undefined,
    });
    if (!session) return fail('config');
    const res = NextResponse.redirect(`${base}/`, 303);
    res.cookies.set(FLOW_COOKIE, '', cookieOptions('/auth', 0));
    const maxAge = Math.floor((session.expires.getTime() - Date.now()) / 1000);
    res.cookies.set(SESSION_COOKIE, session.value, cookieOptions('/', maxAge));
    if (idToken.length <= MAX_ID_TOKEN) res.cookies.set(ID_TOKEN_COOKIE, idToken, cookieOptions('/', maxAge));
    return res;
  } catch (e) {
    const kind = e instanceof OidcError ? e.kind : 'failed';
    console.warn(`sign-in ${kind === 'denied' ? 'refused' : 'failed'}: ${e instanceof Error ? e.message : 'error'}`);
    return fail(kind);
  }
}
