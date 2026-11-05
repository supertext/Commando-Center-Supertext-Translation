import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, passwordConfigured, readSession, type SessionUser } from './auth';

/** The signed-in user, or null. Password sessions stop counting when COMMANDO_PASSWORD is removed. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const user = readSession(jar.get(SESSION_COOKIE)?.value);
  if (user?.via === 'password' && !passwordConfigured()) return null;
  return user;
}

/** For pages and server actions: sends signed-out visitors to the login page. */
export async function requireAuth(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

export async function isSignedIn(): Promise<boolean> {
  return (await currentUser()) !== null;
}
