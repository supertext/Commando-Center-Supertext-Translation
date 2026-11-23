'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Installations', match: (p: string) => p === '/' || p.startsWith('/installations') },
  { href: '/clients', label: 'Clients', match: (p: string) => p.startsWith('/clients') },
  { href: '/proxy', label: 'Translation proxy', match: (p: string) => p.startsWith('/proxy') },
];

/** The header's tabs; the current section is the mint pill. */
export default function MainNav() {
  const path = usePathname() ?? '/';
  return (
    <nav className="tabs" aria-label="Main">
      {TABS.map((t) => {
        const active = t.match(path);
        return (
          <Link key={t.href} href={t.href} className={active ? 'tab active' : 'tab'} aria-current={active ? 'page' : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
