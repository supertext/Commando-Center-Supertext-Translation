import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, readSession, type SessionUser } from './auth';

/** The signed-in user, or null. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return readSession(jar.get(SESSION_COOKIE)?.value);
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
