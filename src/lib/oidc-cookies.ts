/** Cookies of the Supertext-account sign-in (see oidc.ts). */
import { seal, signingKey, unseal } from './auth';
import { TRANSACTION_MINUTES, type Transaction } from './oidc';

/** The pending sign-in (state, nonce, PKCE verifier), signed, 10 minutes, only sent to /auth. */
export const FLOW_COOKIE = 'commando_oidc';
/** The ID token, kept only as id_token_hint for signing out at the Person Service. */
export const ID_TOKEN_COOKIE = 'commando_idt';
/** Browsers drop cookies over 4 KB; a bigger ID token is simply not kept. */
export const MAX_ID_TOKEN = 3500;

export function cookieOptions(path: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path,
    maxAge: maxAgeSeconds,
  };
}

export const FLOW_MAX_AGE = TRANSACTION_MINUTES * 60;

export function sealFlow(tx: Transaction): string | null {
  const key = signingKey('oidc-flow');
  return key ? seal(key, tx) : null;
}

export function unsealFlow(value: string | undefined): Transaction | null {
  const t = unseal(signingKey('oidc-flow'), value) as Partial<Transaction> | null;
  if (!t || typeof t.state !== 'string' || typeof t.nonce !== 'string' || typeof t.verifier !== 'string' || typeof t.exp !== 'number')
    return null;
  return t as Transaction;
}
