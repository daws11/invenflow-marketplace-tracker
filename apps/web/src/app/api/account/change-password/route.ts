// POST /api/account/change-password — let the logged-in user rotate their
// password. Verifies the current password with bcrypt.compare, then re-hashes
// the new one with cost 12 (matching the seed and credentials provider).

import { compare, hash } from 'bcryptjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const BCRYPT_COST = 12;

const Schema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(200),
  })
  .strict()
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'New password must differ from the current password.',
    path: ['newPassword'],
  });

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = Schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const ok = await compare(parsed.data.currentPassword, user.password);
  if (!ok) {
    return NextResponse.json(
      { error: 'Current password is incorrect.' },
      { status: 400 },
    );
  }

  const newHash = await hash(parsed.data.newPassword, BCRYPT_COST);
  await prisma.user.update({
    where: { id: user.id },
    data: { password: newHash },
  });

  return NextResponse.json({ ok: true });
}
