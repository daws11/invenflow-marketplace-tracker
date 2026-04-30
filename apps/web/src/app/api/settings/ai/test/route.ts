// POST /api/settings/ai/test — fire a minimal "Reply OK" prompt at the
// configured (or override-supplied) AI model. Does NOT persist anything.
//
// Body shape (all fields optional):
//   {
//     provider?: 'anthropic' | 'openai' | 'google' | 'openai_compatible',
//     model?: string,
//     apiKey?: string,
//     baseUrl?: string,
//     temperature?: number,
//     maxRetries?: number
//   }
//
// When fields are omitted the route falls through to the active AiSettings
// row, allowing the Settings UI to test the saved configuration without
// re-typing the API key.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { type AiSettingsInput, testAiConnection } from '@/lib/ai-config';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const TestSchema = z
  .object({
    provider: z
      .enum([
        'anthropic',
        'openai',
        'google',
        'openai_compatible',
        'openrouter',
      ])
      .optional(),
    model: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    baseUrl: z
      .union([z.string().url(), z.literal('')])
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
    temperature: z.number().min(0).max(2).optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
  })
  .strict();

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let json: unknown = {};
  // An empty body is allowed — means "test the saved config".
  try {
    const text = await req.text();
    if (text && text.trim().length > 0) json = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = TestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const overrides: Partial<AiSettingsInput> = {};
  if (parsed.data.provider) overrides.provider = parsed.data.provider;
  if (parsed.data.model) overrides.model = parsed.data.model;
  if (parsed.data.apiKey) overrides.apiKey = parsed.data.apiKey;
  if (parsed.data.baseUrl) overrides.baseUrl = parsed.data.baseUrl;
  if (parsed.data.temperature !== undefined)
    overrides.temperature = parsed.data.temperature;
  if (parsed.data.maxRetries !== undefined)
    overrides.maxRetries = parsed.data.maxRetries;

  const result = await testAiConnection(
    Object.keys(overrides).length > 0 ? overrides : undefined,
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
