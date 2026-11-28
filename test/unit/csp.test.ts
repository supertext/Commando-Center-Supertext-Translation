import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce } from '../../src/lib/csp';

describe('Content-Security-Policy', () => {
  it('allows scripts only with the nonce and no framing', () => {
    const csp = contentSecurityPolicy('abc');
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    for (const part of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]) {
      expect(csp).toContain(part);
    }
    expect(contentSecurityPolicy('abc', true)).toContain("'unsafe-eval'");
  });

  it('makes a new nonce every time', () => {
    expect(newNonce()).not.toBe(newNonce());
    expect(newNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
