'use client';

// Tab switcher for the Settings page. Each tab is a self-contained client
// component that owns its own form state and submit handler — keeps the
// blast radius of any one form small and avoids a giant shared reducer.

import { useState } from 'react';

import { AccountTab } from './tabs/account-tab';
import { AiTab } from './tabs/ai-tab';
import { ExtensionTab } from './tabs/extension-tab';
import { GeneralTab } from './tabs/general-tab';
import { InvenflowTab } from './tabs/invenflow-tab';
import { NotificationsTab } from './tabs/notifications-tab';
import { ProxyTab } from './tabs/proxy-tab';

type TabKey =
  | 'general'
  | 'ai'
  | 'invenflow'
  | 'extension'
  | 'notifications'
  | 'proxy'
  | 'account';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'ai', label: 'AI Model' },
  { key: 'invenflow', label: 'InvenFlow' },
  { key: 'extension', label: 'Extension' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'proxy', label: 'Proxy' },
  { key: 'account', label: 'Account' },
];

export function SettingsTabs() {
  const [active, setActive] = useState<TabKey>('general');

  return (
    <div>
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex flex-wrap gap-2 border-b border-neutral-200"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            onClick={() => setActive(t.key)}
            className={`rounded-t-md px-4 py-2 text-sm font-medium transition ${
              active === t.key
                ? 'border border-b-0 border-neutral-300 bg-white text-neutral-900'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        {active === 'general' && <GeneralTab />}
        {active === 'ai' && <AiTab />}
        {active === 'invenflow' && <InvenflowTab />}
        {active === 'extension' && <ExtensionTab />}
        {active === 'notifications' && <NotificationsTab />}
        {active === 'proxy' && <ProxyTab />}
        {active === 'account' && <AccountTab />}
      </div>
    </div>
  );
}
