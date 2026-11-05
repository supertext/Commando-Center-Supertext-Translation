import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import MainNav from '@/components/main-nav';
import { currentUser } from '@/lib/session';
import { APP_REPO, APP_VERSION, appReleaseUrl } from '@/lib/version';
import { logout } from './actions';

export const metadata: Metadata = {
  title: 'Plugin Health | Supertext',
  description: 'Which Supertext plugin and system versions each installation runs.',
  robots: { index: false, follow: false },
  icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } },
};

export const viewport: Viewport = { themeColor: '#003230' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const signedIn = user !== null;
  const release = appReleaseUrl();
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body>
        <header className="top">
          <Link href="/" className="brand" aria-label="Supertext Plugin Health">
            <img src="/supertext-logo.svg" alt="Supertext" width={122} height={22} />
            <span className="for">Plugin Health</span>
          </Link>
          {signedIn && <MainNav />}
          <span className="spacer" />
          {user && (user.name || user.email) && (
            <span className="who" title={user.email}>
              {user.name ?? user.email}
            </span>
          )}
          {signedIn && (
            <form action={logout}>
              <button type="submit">Sign out</button>
            </form>
          )}
        </header>
        <main>{children}</main>
        <footer className="bottom">
          Supertext Plugin Health{' '}
          {release ? (
            <a className="link" href={release} target="_blank" rel="noopener">
              v{APP_VERSION}
            </a>
          ) : (
            <span>v{APP_VERSION}</span>
          )}{' '}
          ·{' '}
          <a className="link" href={APP_REPO} target="_blank" rel="noopener">
            GitHub
          </a>
        </footer>
      </body>
    </html>
  );
}
