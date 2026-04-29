// POST /api/accounts/[id]/runs/paid — manually trigger a paid-pass scrape.
//
// PRD §7.10 + the C5 brief: the endpoint creates the `Run` row synchronously
// (status PENDING) and returns its id immediately so the UI can navigate to
// `/runs/[runId]` and poll for status. The worker then picks up the job,
// flips the run to RUNNING, and finalizes it on completion.
//
// Auth: NextAuth session cookie (admin only — same gate as the rest of /api).

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getScrapePaidQueue } from '@/lib/queues';

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

  // Pre-create the Run row in PENDING so the UI can navigate immediately.
  const run = await prisma.run.create({
    data: {
      accountId: account.id,
      pass: 'PAID',
      status: 'PENDING',
      triggeredBy: 'MANUAL',
    },
  });

  const queue = getScrapePaidQueue();
  const job = await queue.add(
    `manual-paid-${account.id}`,
    {
      accountId: account.id,
      triggeredBy: 'manual',
      runId: run.id,
    },
    {
      // No retries — a manual trigger that fails is reported via the run
      // detail page; auto-retry would muddy the audit trail.
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  return NextResponse.json(
    {
      runId: run.id,
      jobId: job.id,
      queue: 'scrape-paid',
    },
    { status: 202 },
  );
}
