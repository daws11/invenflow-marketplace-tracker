// POST /api/ingest — order-ingest endpoint for the home-server Chrome scraper
// extension. The extension scrapes Tokopedia/Shopee buyer purchase lists in a
// real browser (server-side automation is blocked by anti-bot) and POSTs the
// parsed orders here; we forward each to InvenFlow via the existing
// InvenflowClient and record a Run + Order/OrderLineItem rows — the same end
// state as the worker's scrape-paid job. Authenticated with the extension key
// (`x-extension-key` header), not the NextAuth session.
//
// MVP scope: `pass: "paid"` only. `pass: "shipped"` (line transitions to
// `columnOnShipped`) is a follow-up.

import { RunPass, RunStatus, TriggerType } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { requireExtensionKey } from '@/lib/extension-auth';
import {
  persistScrapedOrder,
  type ScrapedOrderInput,
} from '@/lib/ingest-order';
import { InvenflowApiError, InvenflowClient } from '@/lib/invenflow-client';
import { SETTING_KEYS, getSetting } from '@/lib/settings';
import type { Platform as WirePlatform } from '@/types/invenflow-api';

export const dynamic = 'force-dynamic';

const intNonNeg = z.number().int().min(0);

const LineItemSchema = z.object({
  marketplaceProductName: z.string().min(1),
  marketplaceProductUrl: z.string().nullable().optional(),
  quantity: z.number().int().min(1),
  unitPrice: intNonNeg,
  subtotal: intNonNeg,
});

const OrderSchema = z.object({
  invoiceNumber: z.string().min(1),
  orderDate: z.string().min(1),
  sellerName: z.string().nullable().optional(),
  lineItems: z.array(LineItemSchema).min(1),
  shippingFee: z.number().int().nullable().optional(),
  discount: z.number().int().nullable().optional(),
  totalAmount: intNonNeg,
  detailUrl: z.string().nullable().optional(),
  screenshotBase64: z.string().optional(),
});

const BodySchema = z
  .object({
    accountId: z.string().min(1),
    platform: z.enum(['tokopedia', 'shopee']),
    pass: z.enum(['paid', 'shipped']).default('paid'),
    triggeredBy: z.enum(['scheduled', 'manual']).default('scheduled'),
    orders: z.array(OrderSchema).max(500),
  })
  .strict();

function fail(
  status: number,
  error: string,
  code: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { error, code, ...(details !== undefined ? { details } : {}) },
    { status },
  );
}

export async function POST(req: Request) {
  const unauthorized = await requireExtensionKey(req);
  if (unauthorized) return unauthorized;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body', 'INVALID_PAYLOAD');
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return fail(
      400,
      'Invalid payload',
      'INVALID_PAYLOAD',
      parsed.error.flatten(),
    );
  }
  const body = parsed.data;

  if (body.pass === 'shipped') {
    return fail(
      501,
      'Shipped-pass ingest is not implemented yet',
      'NOT_IMPLEMENTED',
    );
  }

  const account = await prisma.account.findUnique({
    where: { id: body.accountId },
  });
  if (!account) {
    return fail(404, `Account ${body.accountId} not found`, 'NOT_FOUND');
  }
  if (account.platform.toLowerCase() !== body.platform) {
    return fail(
      400,
      `Account platform mismatch: account is ${account.platform}, payload says ${body.platform}`,
      'PLATFORM_MISMATCH',
    );
  }

  // Build the InvenFlow client from persisted settings (same pattern as
  // /api/internal/invenflow/kanbans).
  let baseUrl: string | null;
  let serviceToken: string | null;
  try {
    [baseUrl, serviceToken] = await Promise.all([
      getSetting<string>(SETTING_KEYS.invenflowBaseUrl),
      getSetting<string>(SETTING_KEYS.invenflowServiceToken),
    ]);
  } catch (err) {
    return fail(502, 'Failed to read settings', 'SETTINGS_ERROR', {
      message: (err as Error).message,
    });
  }
  if (!baseUrl || !serviceToken) {
    return fail(
      502,
      'InvenFlow base URL and/or service token are not configured. Configure them in Settings → InvenFlow.',
      'INVENFLOW_NOT_CONFIGURED',
    );
  }
  const invenflow = new InvenflowClient({ baseUrl, serviceToken });
  const wirePlatform = body.platform as WirePlatform;

  // Create the Run row up-front so a crash mid-ingest still leaves a record.
  const run = await prisma.run.create({
    data: {
      accountId: account.id,
      pass: RunPass.PAID,
      status: RunStatus.RUNNING,
      triggeredBy:
        body.triggeredBy === 'manual' ? TriggerType.MANUAL : TriggerType.SCHEDULED,
    },
  });

  let orderCount = 0;
  let newOrderCount = 0;
  let failedSyncs = 0;

  try {
    for (const order of body.orders as ScrapedOrderInput[]) {
      orderCount += 1;
      try {
        const { newOrders } = await persistScrapedOrder(order, {
          runId: run.id,
          accountId: account.id,
          invenflowKanbanId: account.invenflowKanbanId,
          columnOnPaid: account.columnOnPaid,
          platform: wirePlatform,
          invenflow,
        });
        newOrderCount += newOrders;
      } catch (err) {
        // A bad single order shouldn't kill the run — but if InvenFlow itself
        // is rejecting us (auth/permission) or unreachable, stop early.
        if (
          err instanceof InvenflowApiError &&
          (err.status === 401 || err.status === 403 || err.status === 0)
        ) {
          throw err;
        }
        failedSyncs += order.lineItems.length;
      }
    }

    const finalized = await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.SUCCESS,
        completedAt: new Date(),
        orderCount,
        newOrderCount,
        failedSyncs,
      },
    });

    return NextResponse.json({
      runId: finalized.id,
      orderCount: finalized.orderCount,
      newOrderCount: finalized.newOrderCount,
      failedSyncs: finalized.failedSyncs,
    });
  } catch (err) {
    const message =
      err instanceof InvenflowApiError
        ? err.code
          ? `InvenFlow ${err.status} ${err.code}: ${err.message}`
          : `InvenFlow ${err.status}: ${err.message}`
        : `Ingest failed: ${(err as Error).message}`;
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.FAILED,
        completedAt: new Date(),
        orderCount,
        newOrderCount,
        failedSyncs,
        errorMessage: message,
      },
    });
    if (err instanceof InvenflowApiError) {
      return fail(502, message, err.code ?? 'INVENFLOW_ERROR', {
        status: err.status,
        runId: run.id,
      });
    }
    return fail(500, message, 'INTERNAL_ERROR', { runId: run.id });
  }
}
