'use client';

// Sidebar nav — a thin client wrapper so we can highlight the currently
// active section using `usePathname`. Kept in the dashboard group folder
// (with a leading underscore) so Next.js doesn't try to treat it as a
// route segment.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/runs', label: 'Runs' },
  { href: '/settings', label: 'Settings' },
] as const;

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="space-y-1" aria-label="Primary">
      {ITEMS.map((item) => {
        // For `/`, only highlight on exact match — otherwise the prefix
        // check would light it up on every page in the dashboard.
        const active =
          item.href === '/'
            ? pathname === '/'
            : pathname === item.href || pathname?.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`block rounded-md px-3 py-2 text-sm font-medium transition ${
              active
                ? 'bg-neutral-900 text-white'
                : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
