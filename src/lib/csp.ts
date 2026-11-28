/**
 * Content-Security-Policy of every page (set per request in src/proxy.ts): scripts only with this
 * request's nonce (Next.js puts it on its own scripts) or loaded by them ('strict-dynamic'); styles,
 * fonts and images from the app (style attributes allowed: React's `style={…}`); no plugins, no other
 * <base>, forms only to the app, never inside a frame.
 */
export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Violations go to our own collector (src/app/api/v1/csp-report).
    'report-uri /api/v1/csp-report',
    'report-to csp',
  ].join('; ');
}

/** A fresh nonce for one request: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
