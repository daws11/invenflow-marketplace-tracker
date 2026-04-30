'use client';

import { signOut } from 'next-auth/react';

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: '/login' })}
      className="mt-3 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs font-medium text-neutral-700 transition hover:bg-neutral-50 hover:text-neutral-900"
    >
      Sign out
    </button>
  );
}
