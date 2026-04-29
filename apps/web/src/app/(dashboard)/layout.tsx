// Shared dashboard chrome (sidebar nav + main content).
//
// We build something deliberately minimal here: a fixed left rail with the
// app name and a list of section links, and a main content area to the
// right. There's no design system yet — when one lands we'll promote this
// into proper components, but for now plain Tailwind keeps the surface area
// small and the visual style consistent with the existing Settings page.
//
// All routes inside the (dashboard) group are admin-only by virtue of the
// edge middleware redirect; we additionally double-check `getCurrentUser()`
// here so a bug in the matcher can't leak the chrome to anonymous visitors.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { getCurrentUser } from '@/lib/auth';

import { SidebarNav } from './_sidebar-nav';

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-neutral-200 bg-white px-4 py-6 md:block">
        <Link
          href="/"
          className="mb-6 block text-sm font-semibold tracking-tight text-neutral-900"
        >
          InvenFlow
          <span className="ml-1 text-neutral-500">Tracker</span>
        </Link>
        <SidebarNav />
        <div className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
          Signed in as
          <div className="truncate font-medium text-neutral-700">
            {user.email}
          </div>
        </div>
      </aside>
      <div className="flex-1">{children}</div>
    </div>
  );
}
