// GET /api/accounts — list all marketplace accounts (newest first).
// POST /api/accounts — create a new marketplace account.
//
// PRD §7.2.2 "Add Account" wizard maps to the POST handler. The Open-Browser
// step (login) is *not* triggered here — that's a separate action covered in
// C2b. Per-account InvenFlow auth-token overrides are not exposed yet, so
// `invenflowAuthTokenRef` is left null and the account uses the global
// service token from Settings at run time.
//
// Errors follow the contract envelope `{ error, code, details? }` so the UI
// can render them uniformly.

import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { SETTING_KEYS, getSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

// Defaults used when the operator doesn't override the schedule on create.
// We try the Settings-configured defaults first, then fall back to the same
// hard-coded constants the Prisma schema uses so behaviour is predictable
// even on a fresh install where Settings have never been touched.
const FALLBACK_CRON_DIBAYAR = '0 10 * * 1-5';
const FALLBACK_CRON_DIKIRIM = '0 14 * * 1-5';

const PlatformSchema = z.enum(['TOKOPEDIA', 'SHOPEE']);

const CreateAccountSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    platform: PlatformSchema,
    invenflowKanbanId: z.string().min(1, 'invenflowKanbanId is required'),
    invenflowKanbanName: z.string().min(1, 'invenflowKanbanName is required'),
    columnOnPaid: z.string().min(1, 'columnOnPaid is required'),
    columnOnShipped: z.string().min(1, 'columnOnShipped is required'),
    cronEnabled: z.boolean().optional(),
    cronScheduleDibayar: z.string().min(1).optional(),
    cronScheduleDikirim: z.string().min(1).optional(),
    paidUrlOverride: z.string().url().optional(),
    shippedUrlOverride: z.string().url().optional(),
    notes: z.string().optional(),
  })
  .strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const accounts = await prisma.account.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'INVALID_PAYLOAD' },
      { status: 400 },
    );
  }

  const parsed = CreateAccountSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Invalid payload',
        code: 'INVALID_PAYLOAD',
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // Resolve cron defaults from Settings if the caller didn't supply them.
  // The defaults are stored as JSON strings in the Setting table; if reading
  // fails we still fall back to the hard-coded constants so a one-off
  // settings outage doesn't block account creation.
  let dibayarDefault = FALLBACK_CRON_DIBAYAR;
  let dikirimDefault = FALLBACK_CRON_DIKIRIM;
  try {
    const [d, k] = await Promise.all([
      getSetting<string>(SETTING_KEYS.defaultCronDibayar),
      getSetting<string>(SETTING_KEYS.defaultCronDikirim),
    ]);
    if (typeof d === 'string' && d.length > 0) dibayarDefault = d;
    if (typeof k === 'string' && k.length > 0) dikirimDefault = k;
  } catch {
    // intentionally swallow — fall back to constants above
  }

  try {
    const account = await prisma.account.create({
      data: {
        name: data.name,
        platform: data.platform,
        invenflowKanbanId: data.invenflowKanbanId,
        invenflowKanbanName: data.invenflowKanbanName,
        columnOnPaid: data.columnOnPaid,
        columnOnShipped: data.columnOnShipped,
        cronEnabled: data.cronEnabled ?? true,
        cronScheduleDibayar: data.cronScheduleDibayar ?? dibayarDefault,
        cronScheduleDikirim: data.cronScheduleDikirim ?? dikirimDefault,
        paidUrlOverride: data.paidUrlOverride ?? null,
        shippedUrlOverride: data.shippedUrlOverride ?? null,
        notes: data.notes ?? null,
        // v1 has no per-account override UI; leave null so the run-time
        // resolver picks up the global service token from Settings.
        invenflowAuthTokenRef: null,
      },
    });
    return NextResponse.json(account, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json(
        {
          error: 'Database error',
          code: err.code,
          details: { message: err.message },
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      {
        error: 'Failed to create account',
        code: 'INTERNAL_ERROR',
        details: { message: (err as Error).message },
      },
      { status: 500 },
    );
  }
}
