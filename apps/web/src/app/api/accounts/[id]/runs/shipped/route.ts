// POST /api/accounts/[id]/runs/shipped — manually trigger a shipped-pass scrape.
//
// Mirrors /runs/paid — see that file's header for the synchronous-Run-creation
// rationale.

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getScrapeShippedQueue } from '@/lib/queues';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const account = await prisma.account.findUnique({
    where: { id: params.id },
  });
  if (!account) {
    return NextResponse.json(
      { error: 'Account not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }

  const run = await prisma.run.create({
    data: {
      accountId: account.id,
      pass: 'SHIPPED',
      status: 'PENDING',
      triggeredBy: 'MANUAL',
    },
  });

  const queue = getScrapeShippedQueue();
  const job = await queue.add(
    `manual-shipped-${account.id}`,
    {
      accountId: account.id,
      triggeredBy: 'manual',
      runId: run.id,
    },
    {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  return NextResponse.json(
    {
      runId: run.id,
      jobId: job.id,
      queue: 'scrape-shipped',
    },
    { status: 202 },
  );
}
