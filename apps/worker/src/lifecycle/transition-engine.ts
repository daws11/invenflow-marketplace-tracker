// Transition engine — the kanban-card move that the shipped-pass scraper
// drives, isolated from the BullMQ processor envelope so it can be unit
// tested and (eventually) reused by manual-retry endpoints (C5).
//
// Source of truth:
//   * PRD §7.4.2 — Pass B algorithm.
//   * PRD §7.5  — lifecycle state machine, including the
//                 columnOnPaid == columnOnShipped no-op.
//   * INTEGRATION_CONTRACT §3.4 — concurrency rule (200 OK with
//     transitioned=true, 200 OK with transitioned=false, or 409
//     OPERATOR_MOVED).
//
// Responsibilities:
//   * Build the §4.8 transition payload.
//   * Call `client.transitionLine()`.
//   * Map the response (or thrown error) into a flat `TransitionOutcome`
//     that the processor turns into a Prisma update + a digest entry.
//
// NON-responsibilities:
//   * Loading / persisting OrderLineItem rows (processor's job).
//   * Retrying — `InvenflowClient` already burns 3 attempts on 429/5xx
//     before throwing per §3.3.

import {
  InvenflowApiError,
  InvenflowClient,
  isOperatorMoved,
} from '../lib/invenflow-client.js';
import { childLogger } from '../lib/logger.js';
import type { TransitionRequest } from '../types/invenflow-api.js';

const log = childLogger('lifecycle:transition');

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Flat slice of OrderLineItem the engine needs. */
export interface TransitionPlanItem {
  /** Local Prisma OrderLineItem.id (so the caller can target the row). */
  orderLineItemId: string;
  /** Tokopedia/Shopee invoice number — the path component of §4.8. */
  invoiceNumber: string;
  /**
   * The composite line-item id we sent to InvenFlow at ingest time
   * (`<platform>-<invoice-stripped>-line<N>`). Same id used as the path
   * component for §4.8.
   */
  externalLineItemId: string;
}

/** Flat slice of Account the engine needs (column names + kanban id). */
export interface TransitionAccount {
  columnOnPaid: string;
  columnOnShipped: string;
}

/**
 * Result of a single attempted transition. The processor maps each variant
 * to a Prisma update + a digest counter:
 *
 *   * SHIPPED_CONFIRMED          — 200 OK or local no-op (paid==shipped)
 *   * SHIPPED_BUT_OPERATOR_MOVED — 409 OPERATOR_MOVED
 *   * SYNC_FAILED                — anything else after retries exhausted
 */
export type TransitionOutcome =
  | { state: 'SHIPPED_CONFIRMED'; transitioned: boolean }
  | { state: 'SHIPPED_BUT_OPERATOR_MOVED'; currentColumn: string }
  | { state: 'SYNC_FAILED'; error: string };

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------

/**
 * Attempts a single line transition. Never throws; surfaces any failure as
 * `{ state: 'SYNC_FAILED' }` so the caller's loop body stays simple.
 *
 * Special case (PRD §7.5): when `columnOnPaid === columnOnShipped`, the
 * card never needs to move — we short-circuit with a synthetic
 * SHIPPED_CONFIRMED (transitioned=false) and skip the API call entirely.
 */
export async function transitionShippedOrder(
  client: InvenflowClient,
  account: TransitionAccount,
  item: TransitionPlanItem,
  proofScreenshotUploadIds: string[],
): Promise<TransitionOutcome> {
  // PRD §7.5 — same-column collapse, no API call.
  if (account.columnOnPaid === account.columnOnShipped) {
    log.info(
      {
        invoiceNumber: item.invoiceNumber,
        externalLineItemId: item.externalLineItemId,
        column: account.columnOnPaid,
      },
      'transition-engine: paid==shipped column — synthetic confirmation',
    );
    return { state: 'SHIPPED_CONFIRMED', transitioned: false };
  }

  const payload: TransitionRequest = {
    fromColumnStatus: account.columnOnPaid,
    toColumnStatus: account.columnOnShipped,
    screenshotUploadIds: proofScreenshotUploadIds,
    reason: `Order shipped detected at ${new Date().toISOString()}`,
  };

  let response;
  try {
    response = await client.transitionLine(
      item.invoiceNumber,
      item.externalLineItemId,
      payload,
    );
  } catch (err) {
    if (err instanceof InvenflowApiError) {
      const errorMessage = err.code
        ? `InvenFlow ${err.status} ${err.code}: ${err.message}`
        : `InvenFlow ${err.status}: ${err.message}`;
      log.warn(
        {
          invoiceNumber: item.invoiceNumber,
          externalLineItemId: item.externalLineItemId,
          status: err.status,
          code: err.code,
          err: err.message,
        },
        'transition-engine: invenflow API error — marking SYNC_FAILED',
      );
      return { state: 'SYNC_FAILED', error: errorMessage };
    }
    log.warn(
      {
        invoiceNumber: item.invoiceNumber,
        externalLineItemId: item.externalLineItemId,
        err: (err as Error)?.message ?? String(err),
      },
      'transition-engine: unexpected error — marking SYNC_FAILED',
    );
    return {
      state: 'SYNC_FAILED',
      error: (err as Error)?.message ?? String(err),
    };
  }

  if (isOperatorMoved(response)) {
    log.info(
      {
        invoiceNumber: item.invoiceNumber,
        externalLineItemId: item.externalLineItemId,
        currentColumn: response.currentColumn,
      },
      'transition-engine: operator already moved card — respecting',
    );
    return {
      state: 'SHIPPED_BUT_OPERATOR_MOVED',
      currentColumn: response.currentColumn,
    };
  }

  // §3.4 — `transitioned: true` means we moved it, `false` means it was
  // already in the target column (idempotent reapply).
  if (response.transitioned === false) {
    log.info(
      {
        invoiceNumber: item.invoiceNumber,
        externalLineItemId: item.externalLineItemId,
        currentColumn: response.currentColumn,
      },
      'transition-engine: card already in target column — idempotent confirmation',
    );
  } else {
    log.info(
      {
        invoiceNumber: item.invoiceNumber,
        externalLineItemId: item.externalLineItemId,
        currentColumn: response.currentColumn,
      },
      'transition-engine: card transitioned',
    );
  }

  return { state: 'SHIPPED_CONFIRMED', transitioned: response.transitioned };
}
