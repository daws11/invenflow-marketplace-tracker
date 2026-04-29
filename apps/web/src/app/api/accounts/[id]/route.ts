// GET /api/accounts/[id] — fetch one account.
// PATCH /api/accounts/[id] — partial update.
// DELETE /api/accounts/[id] — delete + best-effort wipe of the on-disk
// browser-profile directory at `data/profiles/<platform>-<id>`.
//
// The patch schema mirrors the create schema with everything optional, plus
// `status` and `lastLoginAt` which the C2b login flow will eventually flip.
// `platform` is intentionally NOT patchable: it is the real-world identity of
// the marketplace login and changing it would invalidate runs/orders/the
// profile directory.

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UpdateAccountSchema = z
  .object({
    name: z.string().min(1).optional(),
    invenflowKanbanId: z.string().min(1).optional(),
    invenflowKanbanName: z.string().min(1).optional(),
    columnOnPaid: z.string().min(1).optional(),
    columnOnShipped: z.string().min(1).optional(),
    cronEnabled: z.boolean().optional(),
    cronScheduleDibayar: z.string().min(1).optional(),
    cronScheduleDikirim: z.string().min(1).optional(),
    paidUrlOverride: z.string().url().nullable().optional(),
    shippedUrlOverride: z.string().url().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export async function GET(
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

  return NextResponse.json(account);
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
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

  const parsed = UpdateAccountSchema.safeParse(json);
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

  const existing = await prisma.account.findUnique({
    where: { id: params.id },
  });
  if (!existing) {
    return NextResponse.json(
      { error: 'Account not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }

  try {
    const updated = await prisma.account.update({
      where: { id: params.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.invenflowKanbanId !== undefined && {
          invenflowKanbanId: data.invenflowKanbanId,
        }),
        ...(data.invenflowKanbanName !== undefined && {
          invenflowKanbanName: data.invenflowKanbanName,
        }),
        ...(data.columnOnPaid !== undefined && {
          columnOnPaid: data.columnOnPaid,
        }),
        ...(data.columnOnShipped !== undefined && {
          columnOnShipped: data.columnOnShipped,
        }),
        ...(data.cronEnabled !== undefined && { cronEnabled: data.cronEnabled }),
        ...(data.cronScheduleDibayar !== undefined && {
          cronScheduleDibayar: data.cronScheduleDibayar,
        }),
        ...(data.cronScheduleDikirim !== undefined && {
          cronScheduleDikirim: data.cronScheduleDikirim,
        }),
        ...(data.paidUrlOverride !== undefined && {
          paidUrlOverride: data.paidUrlOverride,
        }),
        ...(data.shippedUrlOverride !== undefined && {
          shippedUrlOverride: data.shippedUrlOverride,
        }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });
    return NextResponse.json(updated);
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
        error: 'Failed to update account',
        code: 'INTERNAL_ERROR',
        details: { message: (err as Error).message },
      },
      { status: 500 },
    );
  }
}

// `data/profiles/<platform>-<accountId>` lives at the *workspace* root
// (alongside the existing `apps/`, `data/`, `docker/` siblings). The
// resolution below works whether the worker process is run from the repo
// root or from `apps/web`: we anchor on `process.cwd()` and look for a
// `data/` sibling, falling back to `<cwd>/data` if not found.
function resolveProfileDir(platform: string, accountId: string): string {
  const lower = platform.toLowerCase();
  const dirName = `${lower}-${accountId}`;
  const cwd = process.cwd();
  // If we're running from apps/web, jump up two levels to reach the repo root.
  // Otherwise assume cwd is the repo root.
  const candidates = [
    path.join(cwd, 'data', 'profiles', dirName),
    path.join(cwd, '..', '..', 'data', 'profiles', dirName),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export async function DELETE(
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

  const existing = await prisma.account.findUnique({
    where: { id: params.id },
  });
  if (!existing) {
    return NextResponse.json(
      { error: 'Account not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }

  try {
    await prisma.account.delete({ where: { id: params.id } });
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
        error: 'Failed to delete account',
        code: 'INTERNAL_ERROR',
        details: { message: (err as Error).message },
      },
      { status: 500 },
    );
  }

  // Best-effort wipe of the on-disk browser profile. If the worker hasn't
  // ever opened a browser session for this account the directory may not
  // exist, which is fine. We never block the delete on filesystem cleanup.
  const profileDir = resolveProfileDir(existing.platform, existing.id);
  try {
    if (existsSync(profileDir)) {
      await rm(profileDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(
      `[accounts.delete] failed to wipe profile dir ${profileDir}: ${(err as Error).message}`,
    );
  }

  return new NextResponse(null, { status: 204 });
}
