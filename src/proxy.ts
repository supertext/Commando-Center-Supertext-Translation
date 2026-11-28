import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from '@/lib/csp';

/** A fresh nonce and the Content-Security-Policy for every page (Next.js adds the nonce to its scripts). */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Reporting-Endpoints', 'csp="/api/v1/csp-report"');
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the report API, Next's static files or the public files.
      source: '/((?!api/|_next/static|_next/image|fonts/|favicon|supertext-logo).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
