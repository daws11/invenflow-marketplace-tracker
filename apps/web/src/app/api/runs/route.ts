// GET /api/runs — paginated list of Run rows (PRD §7.10 + §10.6).
//
// Filters (all optional):
//   - account=<accountId>
//   - pass=PAID|SHIPPED|LOGIN
//   - status=PENDING|RUNNING|SUCCESS|FAILED|CANCELED
//   - from=<ISO date>          (inclusive lower bound on startedAt)
//   - to=<ISO date>            (inclusive upper bound on startedAt)
//   - page=<1-based>           (default 1)
//   - pageSize=<1..100>        (default 20)
//
// Returns `{ runs: [...], total }`. The list page uses `total` to render
// pagination; individual rows include the parent Account so the table
// doesn't N+1.

import { Prisma, RunPass, RunStatus } from '@prisma/client';
import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const search = url.searchParams;

  const accountId = search.get('account') ?? undefined;
  const passParam = search.get('pass') ?? undefined;
  const statusParam = search.get('status') ?? undefined;
  const fromParam = search.get('from') ?? undefined;
  const toParam = search.get('to') ?? undefined;
  const pageParam = search.get('page');
  const pageSizeParam = search.get('pageSize');

  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(pageSizeParam ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
  );

  const where: Prisma.RunWhereInput = {};
  if (accountId) where.accountId = accountId;
  if (passParam && (passParam in RunPass)) {
    where.pass = passParam as RunPass;
  }
  if (statusParam && (statusParam in RunStatus)) {
    where.status = statusParam as RunStatus;
  }
  if (fromParam || toParam) {
    where.startedAt = {};
    if (fromParam) {
      const d = new Date(fromParam);
      if (!Number.isNaN(d.valueOf())) {
        (where.startedAt as Prisma.DateTimeFilter).gte = d;
      }
    }
    if (toParam) {
      const d = new Date(toParam);
      if (!Number.isNaN(d.valueOf())) {
        (where.startedAt as Prisma.DateTimeFilter).lte = d;
      }
    }
  }

  const [total, runs] = await Promise.all([
    prisma.run.count({ where }),
    prisma.run.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        account: {
          select: { id: true, name: true, platform: true },
        },
      },
    }),
  ]);

  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      account: r.account,
      pass: r.pass,
      status: r.status,
      triggeredBy: r.triggeredBy,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      errorMessage: r.errorMessage,
      modelUsed: r.modelUsed,
      orderCount: r.orderCount,
      newOrderCount: r.newOrderCount,
      transitionCount: r.transitionCount,
      failedSyncs: r.failedSyncs,
    })),
    total,
    page,
    pageSize,
  });
}
