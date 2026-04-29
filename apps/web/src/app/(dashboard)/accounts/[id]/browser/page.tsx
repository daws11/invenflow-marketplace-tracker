// /accounts/[id]/browser — interactive browser session page.
//
// Server component that loads the Account, then hands off to a client
// component (`BrowserSessionClient`) that owns the full state machine
// (POST /browser → poll status → render iframe → save/close → redirect).
//
// PRD §7.3 — the iframe is full-bleed; admin uses the remote Chromium as
// their own browser. The header strip stays small so the noVNC viewport
// gets as much vertical space as the layout allows.

import { notFound } from 'next/navigation';

import { prisma } from '@/lib/db';

import { BrowserSessionClient } from './_browser-client';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Browser Session · InvenFlow Marketplace Tracker',
};

export default async function BrowserSessionPage({
  params,
}: {
  params: { id: string };
}) {
  const account = await prisma.account.findUnique({
    where: { id: params.id },
  });
  if (!account) {
    notFound();
  }

  return (
    <BrowserSessionClient
      account={{
        id: account.id,
        name: account.name,
        platform: account.platform,
        status: account.status,
      }}
    />
  );
}
