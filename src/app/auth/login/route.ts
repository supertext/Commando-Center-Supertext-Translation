import { NextResponse, type NextRequest } from 'next/server';
import { sessionSecret } from '@/lib/auth';
import { authorizeUrl, discover, newTransaction, oidcConfig, oidcProblem, publicBaseUrl } from '@/lib/oidc';
import { FLOW_COOKIE, FLOW_MAX_AGE, cookieOptions, sealFlow } from '@/lib/oidc-cookies';

export const dynamic = 'force-dynamic';

/** Public: starts the sign-in with a Supertext account (redirect to the Person Service). */
export async function GET(request: NextRequest) {
  const base = publicBaseUrl(request.headers);
  const cfg = oidcConfig();
  if (!cfg || oidcProblem(cfg, sessionSecret() !== null)) return NextResponse.redirect(`${base}/login?error=config`, 303);
  const tx = newTransaction();
  const sealed = sealFlow(tx);
  try {
    if (!sealed) throw new Error('no session secret');
    const doc = await discover(cfg);
    const res = NextResponse.redirect(authorizeUrl(cfg, doc, tx, `${base}/auth/callback`), 303);
    res.cookies.set(FLOW_COOKIE, sealed, cookieOptions('/auth', FLOW_MAX_AGE));
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (e) {
    console.warn(`sign-in: the Person Service couldn't be reached (${e instanceof Error ? e.message : 'error'})`);
    return NextResponse.redirect(`${base}/login?error=unavailable`, 303);
  }
}
