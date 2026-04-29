// Settings page (PRD §7.8 / §11). Server component that mounts the tab
// switcher; each tab is its own client component because they all manage
// form state and call back into the API on submit.

import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';

import { SettingsTabs } from './settings-tabs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings · InvenFlow Marketplace Tracker' };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?callbackUrl=/settings');
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Settings
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Configure the sidecar — AI provider, InvenFlow connection, WhatsApp
          notifications, and your account.
        </p>
      </header>

      <SettingsTabs />
    </main>
  );
}
