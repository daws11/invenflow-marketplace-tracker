// Hand-written types mirroring the InvenFlow integration contract.
//
// Source of truth: `INTEGRATION_CONTRACT.md` §4 and
// `openapi/marketplace-integration.yaml`. We deliberately do NOT generate these
// in B3 (the spec calls for `openapi-typescript` later); when the codegen lands
// it should produce a superset of these names so call-sites do not need to
// change.
//
// Also re-exported from `@invenflow-tracker/shared` so the worker package can
// import the same shapes without re-declaring them.

// -----------------------------------------------------------------------------
// Common
// -----------------------------------------------------------------------------

export type Platform = 'tokopedia' | 'shopee';
export type KanbanType = 'order' | 'receive';

/**
 * Standard non-2xx envelope per contract §3.1.
 */
export interface InvenflowErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export type ErrorCode =
  | 'INVALID_PAYLOAD'
  | 'INVALID_TOKEN'
  | 'INSUFFICIENT_PERMISSION'
  | 'KANBAN_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'OPERATOR_MOVED'
  | 'MAPPING_RESOLUTION_REQUIRED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | string;

// -----------------------------------------------------------------------------
// 4.1 GET /api/health
// -----------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: {
    database: 'ok' | 'fail' | 'skipped';
    redis: 'ok' | 'fail' | 'skipped';
  };
}

// -----------------------------------------------------------------------------
// 4.2 GET /api/kanbans?type=order
// -----------------------------------------------------------------------------

export interface Kanban {
  id: string;
  name: string;
  type: KanbanType;
  description?: string | null;
}

export interface KanbanListResponse {
  kanbans: Kanban[];
}

// -----------------------------------------------------------------------------
// 4.3 GET /api/kanbans/{kanbanId}/columns
// -----------------------------------------------------------------------------

export interface KanbanColumnsResponse {
  kanbanId: string;
  type: KanbanType;
  columns: string[];
}

// -----------------------------------------------------------------------------
// 4.4 POST /api/upload
// -----------------------------------------------------------------------------

export interface UploadFileMeta {
  filename: string;
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
  url: string;
  publicUrl: string;
  authenticatedUrl: string;
}

export interface UploadResponse {
  success: boolean;
  file: UploadFileMeta;
}

// -----------------------------------------------------------------------------
// 4.5 POST /api/marketplace/sku-mappings/resolve
// -----------------------------------------------------------------------------

export interface SkuMapping {
  id: string;
  platform: Platform;
  marketplaceProductName: string;
  invenflowSku: string;
  invenflowProductName: string;
  notes?: string | null;
}

export type ResolveSkuResponse =
  | { found: true; mapping: SkuMapping }
  | { found: false };

// -----------------------------------------------------------------------------
// 4.6 POST /api/marketplace/orders
// -----------------------------------------------------------------------------

export interface IngestLineItem {
  lineItemId: string;
  marketplaceProductName: string;
  marketplaceProductUrl?: string | null;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface IngestRawData {
  extractedBy?: string;
  modelUsed?: string;
  scrapedAt?: string;
  platformOrderId?: string;
  [k: string]: unknown;
}

export interface IngestOrderRequest {
  platform: Platform;
  kanbanId: string;
  targetColumnStatus: string;
  invoiceNumber: string;
  /** ISO 8601 timestamp or `YYYY-MM-DD`. */
  orderDate: string;
  sellerName?: string | null;
  lineItems: IngestLineItem[];
  shippingFee?: number;
  discount?: number;
  totalAmount: number;
  screenshotUploadIds?: string[];
  rawData?: IngestRawData;
}

export interface IngestLineResult {
  lineItemId: string;
  invenflowProductId: string;
  needsSkuMapping: boolean;
  currentColumn: string;
  isNew: boolean;
}

export interface IngestOrderResponse {
  invoiceNumber: string;
  platform: Platform;
  kanbanId: string;
  lineItems: IngestLineResult[];
}

// -----------------------------------------------------------------------------
// 4.7 GET /api/marketplace/orders/{invoiceNumber}
// -----------------------------------------------------------------------------

export interface OrderStateLineItem {
  lineItemId: string;
  invenflowProductId: string;
  currentColumn: string;
  needsSkuMapping: boolean;
}

export interface OrderState {
  invoiceNumber: string;
  platform: Platform;
  kanbanId: string;
  lineItems: OrderStateLineItem[];
}

// -----------------------------------------------------------------------------
// 4.8 PATCH .../transition
// -----------------------------------------------------------------------------

export interface TransitionRequest {
  fromColumnStatus: string;
  toColumnStatus: string;
  screenshotUploadIds?: string[];
  reason?: string;
}

export interface TransitionResponse {
  invenflowProductId: string;
  currentColumn: string;
  transitioned: boolean;
}

/**
 * Returned (parsed from a 409 body) when the operator already moved the card.
 * Treated as success-with-no-op by the sidecar (see contract §3.4).
 */
export interface OperatorMovedResponse {
  error: string;
  code: 'OPERATOR_MOVED';
  noop: true;
  reason: 'operator_moved';
  currentColumn: string;
}
