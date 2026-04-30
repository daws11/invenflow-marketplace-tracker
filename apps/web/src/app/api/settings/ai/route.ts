// GET / PATCH /api/settings/ai — manage the active AiSettings row.
//
// Reads return the active row with `apiKey` masked as '***'. Writes upsert:
// they update the existing active row's fields if one exists, otherwise
// insert a new active row. Submitting `'***'` or empty string for the API
// key leaves the existing key untouched (so the operator can edit other
// fields without re-typing the secret).
//
// PRD §7.9 reminder: NO hardcoded model strings. The frontend posts the
// `model` value as free-text and we store it verbatim.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { encrypt } from '@/lib/encryption';

export const dynamic = 'force-dynamic';

const AiPatchSchema = z
  .object({
    provider: z.enum([
      'anthropic',
      'openai',
      'google',
      'openai_compatible',
      'openrouter',
    ]),
    model: z.string().min(1),
    apiKey: z.string().optional(),
    baseUrl: z
      .union([z.string().url(), z.literal('')])
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
    temperature: z.number().min(0).max(2).optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
  })
  .strict();

function isMaskedOrEmpty(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  return t.length === 0 || t === '***';
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const row = await prisma.aiSettings.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' },
  });

  if (!row) {
    return NextResponse.json({
      configured: false,
      provider: null,
      model: null,
      apiKey: null,
      baseUrl: null,
      temperature: null,
      maxRetries: null,
    });
  }

  return NextResponse.json({
    configured: true,
    id: row.id,
    provider: row.provider,
    model: row.model,
    apiKey: '***',
    apiKeySet: true,
    baseUrl: row.baseUrl,
    temperature: row.temperature,
    maxRetries: row.maxRetries,
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
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

  const parsed = AiPatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // Find current active row to decide insert-vs-update.
  const existing = await prisma.aiSettings.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' },
  });

  // If no API key was provided AND no existing row exists, that's an error —
  // we can't store a row without a key on first write.
  if (!existing && isMaskedOrEmpty(data.apiKey)) {
    return NextResponse.json(
      { error: 'apiKey is required when creating the first AiSettings row' },
      { status: 400 },
    );
  }

  const apiKeyEnc = isMaskedOrEmpty(data.apiKey)
    ? null
    : encrypt(data.apiKey!.trim());

  // Wrap in a transaction so we never leave more than one isActive row.
  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.aiSettings.update({
        where: { id: existing.id },
        data: {
          provider: data.provider,
          model: data.model,
          ...(apiKeyEnc ? { apiKey: apiKeyEnc } : {}),
          baseUrl: data.baseUrl ?? null,
          ...(data.temperature !== undefined
            ? { temperature: data.temperature }
            : {}),
          ...(data.maxRetries !== undefined
            ? { maxRetries: data.maxRetries }
            : {}),
          isActive: true,
        },
      });
    } else {
      // First-time insert. Deactivate any stale rows just in case.
      await tx.aiSettings.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
      await tx.aiSettings.create({
        data: {
          provider: data.provider,
          model: data.model,
          apiKey: apiKeyEnc!,
          baseUrl: data.baseUrl ?? null,
          temperature: data.temperature ?? 0,
          maxRetries: data.maxRetries ?? 3,
          isActive: true,
        },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
