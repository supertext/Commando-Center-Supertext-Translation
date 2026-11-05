'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { SESSION_COOKIE, checkPassword, createSession, readSession } from '@/lib/auth';
import { requireAuth } from '@/lib/session';
import { discover, endSessionUrl, oidcConfig, publicBaseUrl } from '@/lib/oidc';
import { ID_TOKEN_COOKIE } from '@/lib/oidc-cookies';
import { RateLimiter, clientIp } from '@/lib/rate-limit';
import * as store from '@/lib/db';
import { pingInstallation } from '@/lib/pinger';

const loginAttempts = new RateLimiter(10, 15 * 60_000);

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const h = await headers();
  if (!loginAttempts.take(clientIp(h))) return { error: 'Too many attempts. Wait 15 minutes and try again.' };
  const pw = String(form.get('password') ?? '');
  if (!checkPassword(pw)) return { error: 'Wrong password.' };
  const session = createSession();
  if (!session) return { error: 'The shared password is not configured.' };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: session.expires,
  });
  redirect('/');
}

/** Signs out here and, after a Supertext-account sign-in, at the Person Service too. */
export async function logout(): Promise<void> {
  const jar = await cookies();
  const user = readSession(jar.get(SESSION_COOKIE)?.value);
  const idToken = jar.get(ID_TOKEN_COOKIE)?.value;
  jar.delete(SESSION_COOKIE);
  jar.delete(ID_TOKEN_COOKIE);
  const cfg = oidcConfig();
  let target: string | null = null;
  if (user?.via === 'oidc' && cfg) {
    try {
      const base = publicBaseUrl(await headers());
      target = endSessionUrl(cfg, await discover(cfg), `${base}/login`, idToken);
    } catch {
      target = null; // signed out here; the Person Service session ends on its own
    }
  }
  redirect(target ?? '/login');
}

function id(form: FormData, field = 'id'): number {
  const n = Number(form.get(field));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${field}`);
  return n;
}

function clean(value: FormDataEntryValue | null, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** Assigns an installation to an existing client, a new client (typed name) or none, and saves its notes. */
export async function saveInstallation(form: FormData): Promise<void> {
  await requireAuth();
  const installationId = id(form);
  const choice = String(form.get('client') ?? '');
  const newName = clean(form.get('new_client'), 200);
  let clientId: number | null = null;
  if (newName) clientId = await store.ensureClient(newName);
  else if (choice && choice !== 'none') clientId = id(form, 'client');
  await store.updateInstallation(installationId, clientId, clean(form.get('notes'), 5000));
  revalidatePath('/', 'layout');
  redirect(`/installations/${installationId}?saved=1`);
}

export async function removeInstallation(form: FormData): Promise<void> {
  await requireAuth();
  await store.deleteInstallation(id(form));
  revalidatePath('/', 'layout');
  redirect('/');
}

export async function createClient(form: FormData): Promise<void> {
  await requireAuth();
  const name = clean(form.get('name'), 200);
  if (!name) redirect('/clients');
  const clientId = await store.ensureClient(name);
  revalidatePath('/clients');
  redirect(`/clients/${clientId}`);
}

export async function saveClient(form: FormData): Promise<void> {
  await requireAuth();
  const clientId = id(form);
  const name = clean(form.get('name'), 200);
  if (name) {
    try {
      await store.updateClient(clientId, name, clean(form.get('notes'), 5000));
    } catch {
      redirect(`/clients/${clientId}?error=duplicate`);
    }
  }
  revalidatePath('/', 'layout');
  redirect(`/clients/${clientId}?saved=1`);
}

export async function removeClient(form: FormData): Promise<void> {
  await requireAuth();
  await store.deleteClient(id(form));
  revalidatePath('/', 'layout');
  redirect('/clients');
}

/** Staff pressed Ping now on an installation page. */
export async function pingNow(form: FormData): Promise<void> {
  await requireAuth();
  const installationId = id(form);
  const outcome = await pingInstallation(installationId, 'manual');
  revalidatePath(`/installations/${installationId}`);
  redirect(`/installations/${installationId}?${outcome.pinged ? 'pinged=1' : `ping_skipped=${encodeURIComponent(outcome.reason)}`}#callback`);
}
