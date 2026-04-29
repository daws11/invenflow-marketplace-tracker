// Daily-digest processor (PRD §7.7 — "Daily digest" trigger).
//
// Aggregates trailing-24h shipped-pass runs into a single WhatsApp message
// summary the operator gets at 18:00 Asia/Jakarta. Counts are derived from
// `Run` + `OrderLineItem` so no separate persistence is needed.
//
// The dispatcher is responsible for the toggle check (notify.dailyDigest);
// this processor always builds the summary and hands it off — that way a
// rapid toggle change doesn't require restarting the worker.

import { RunPass, RunStatus } from '@prisma/client';
import type { Job } from 'bullmq';

import { prisma } from '../../lib/db.js';
import { childLogger } from '../../lib/logger.js';
import { dispatcher } from '../../notifications/dispatcher.js';
import { type JobResult, type DailyDigestJobData, QUEUE_DAILY_DIGEST } from '../queues.js';

const log = childLogger(`queue:${QUEUE_DAILY_DIGEST}`);

const TRAILING_WINDOW_HOURS = 24;
const SAMPLE_CASE_LIMIT = 3;

/** Aggregated counts a notification template substitutes into. */
export interface DailyDigestSummary {
  ingested: number;
  shipped: number;
  operatorMoved: number;
  failed: number;
  /**
   * Up to SAMPLE_CASE_LIMIT operator-moved cases for context in the digest
   * message. Caller (dispatcher) decides how to render them.
   */
  operatorMovedSamples: Array<{
    invoiceNumber: string;
    accountName: string;
    lineItemId: string;
  }>;
}

export async function processDailyDigestJob(
  _job: Job<DailyDigestJobData, JobResult>,
): Promise<JobResult> {
  log.info('daily-digest: building summary');

  const since = new Date(Date.now() - TRAILING_WINDOW_HOURS * 60 * 60 * 1000);

  // Aggregate from Run rows for shipped-pass success runs in the window.
  const runs = await prisma.run.findMany({
    where: {
      pass: RunPass.SHIPPED,
      status: RunStatus.SUCCESS,
      completedAt: { gte: since },
    },
    select: {
      transitionCount: true,
      failedSyncs: true,
      completedAt: true,
    },
  });

  const shipped = runs.reduce((acc, r) => acc + (r.transitionCount ?? 0), 0);
  const failed = runs.reduce((acc, r) => acc + (r.failedSyncs ?? 0), 0);

  // Operator-moved isn't on the Run aggregate (we only persist it per
  // OrderLineItem). Count rows whose state flipped to that terminal in the
  // window, plus a small sample for the message body.
  const operatorMovedRows = await prisma.orderLineItem.findMany({
    where: {
      lifecycleState: 'SHIPPED_BUT_OPERATOR_MOVED',
      shippedAt: { gte: since },
    },
    select: {
      lineItemId: true,
      order: {
        select: {
          invoiceNumber: true,
          account: { select: { name: true } },
        },
      },
    },
    orderBy: { shippedAt: 'desc' },
  });

  // Ingested today = paid-pass runs' newOrderCount sum across all PAID runs
  // in the window, regardless of status (a partial failure can still ingest
  // some orders before failing).
  const paidRuns = await prisma.run.findMany({
    where: {
      pass: RunPass.PAID,
      startedAt: { gte: since },
    },
    select: { newOrderCount: true },
  });
  const ingested = paidRuns.reduce(
    (acc, r) => acc + (r.newOrderCount ?? 0),
    0,
  );

  const summary: DailyDigestSummary = {
    ingested,
    shipped,
    operatorMoved: operatorMovedRows.length,
    failed,
    operatorMovedSamples: operatorMovedRows
      .slice(0, SAMPLE_CASE_LIMIT)
      .map((r) => ({
        invoiceNumber: r.order.invoiceNumber,
        accountName: r.order.account.name,
        lineItemId: r.lineItemId,
      })),
  };

  log.info({ summary }, 'daily-digest: dispatching');

  try {
    await dispatcher.notifyDailyDigest(summary);
  } catch (err) {
    log.error(
      { err: (err as Error).message },
      'daily-digest: dispatch failed (non-fatal)',
    );
  }

  return {
    ok: true,
    message: 'daily-digest dispatched',
    data: { ...summary },
  };
}
