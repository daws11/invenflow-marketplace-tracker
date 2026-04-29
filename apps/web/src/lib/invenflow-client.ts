// Typed HTTP wrapper around the InvenFlow integration API.
//
// Source of truth: `INTEGRATION_CONTRACT.md` §2 endpoint catalog and §4.1–§4.8
// per-endpoint specs. Implements the retry policy from §3.3 (3 attempts on
// 429/5xx with 2s/8s/32s backoff, honoring `Retry-After` on 429) and parses
// 409 OPERATOR_MOVED bodies as a non-throwing return value (see §3.4).
//
// One typed method per contract endpoint. Every call carries
// `Authorization: Bearer <serviceToken>`. Response bodies are validated by
// shape only (TypeScript types) — runtime validation can be layered on later
// if needed.

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';

import type {
  HealthResponse,
  IngestOrderRequest,
  IngestOrderResponse,
  InvenflowErrorBody,
  KanbanColumnsResponse,
  KanbanListResponse,
  OperatorMovedResponse,
  OrderState,
  Platform,
  ResolveSkuResponse,
  TransitionRequest,
  TransitionResponse,
  UploadResponse,
} from '@/types/invenflow-api';

// -----------------------------------------------------------------------------
// Retry configuration (per contract §3.3)
// -----------------------------------------------------------------------------

const RETRY_BACKOFFS_MS = [2_000, 8_000, 32_000] as const;
const MAX_ATTEMPTS = RETRY_BACKOFFS_MS.length;

const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function parseRetryAfterMs(headerVal: unknown): number | null {
  if (typeof headerVal !== 'string' || headerVal.length === 0) return null;
  // Spec: integer seconds OR HTTP-date. We support seconds only (sufficient
  // for the contract — server returns integer seconds).
  const asInt = Number(headerVal.trim());
  if (Number.isFinite(asInt) && asInt >= 0) return Math.round(asInt * 1000);
  // HTTP-date fallback: best-effort parse.
  const asDate = Date.parse(headerVal);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Thrown when the InvenFlow API returns a non-2xx response that the client
 * has decided not to surface as a domain return value (i.e. anything other
 * than `transitionLine` returning `OperatorMovedResponse` for 409s).
 */
export class InvenflowApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly responseBody: unknown;

  constructor(opts: {
    status: number;
    message: string;
    code?: string;
    details?: unknown;
    responseBody?: unknown;
  }) {
    super(opts.message);
    this.name = 'InvenflowApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.responseBody = opts.responseBody;
  }
}

function errorFromAxios(err: AxiosError): InvenflowApiError {
  const status = err.response?.status ?? 0;
  const data = err.response?.data;
  let code: string | undefined;
  let message = err.message;
  if (data && typeof data === 'object') {
    const body = data as Partial<InvenflowErrorBody>;
    if (typeof body.error === 'string') message = body.error;
    if (typeof body.code === 'string') code = body.code;
  }
  return new InvenflowApiError({
    status,
    message,
    code,
    details:
      data && typeof data === 'object'
        ? (data as { details?: unknown }).details
        : undefined,
    responseBody: data,
  });
}

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

export interface InvenflowClientOptions {
  baseUrl: string;
  serviceToken: string;
  /**
   * Per-request timeout in ms (applies to each attempt, not the whole retry
   * envelope). Defaults to 30s.
   */
  timeoutMs?: number;
}

export class InvenflowClient {
  private readonly http: AxiosInstance;

  constructor(opts: InvenflowClientOptions) {
    if (!opts.baseUrl) throw new Error('InvenflowClient: baseUrl is required');
    if (!opts.serviceToken)
      throw new Error('InvenflowClient: serviceToken is required');

    // Strip a trailing slash so callers can pass either form.
    const base = opts.baseUrl.replace(/\/+$/, '');

    this.http = axios.create({
      baseURL: base,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${opts.serviceToken}`,
        Accept: 'application/json',
      },
      // We handle non-2xx ourselves so we can distinguish 409 OPERATOR_MOVED.
      validateStatus: () => true,
    });
  }

  // ---------------------------------------------------------------------------
  // Core request helper with §3.3 retry policy
  // ---------------------------------------------------------------------------

  private async request<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: AxiosResponse<T>;
      try {
        response = await this.http.request<T>(config);
      } catch (err) {
        // Network/timeout error — treat like a 5xx for retry purposes.
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BACKOFFS_MS[attempt - 1] ?? 0);
          continue;
        }
        // No more attempts.
        if (err instanceof AxiosError) throw errorFromAxios(err);
        throw err;
      }

      const { status } = response;
      if (status >= 200 && status < 300) {
        return response;
      }

      if (shouldRetry(status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = parseRetryAfterMs(response.headers['retry-after']);
        const backoff = retryAfter ?? RETRY_BACKOFFS_MS[attempt - 1] ?? 0;
        await sleep(backoff);
        continue;
      }

      // Non-retryable, or out of attempts on a retryable status.
      // Synthesize an AxiosError-shaped object so errorFromAxios can extract
      // the contract envelope.
      const synthetic = new AxiosError(
        `Request failed with status ${status}`,
        undefined,
        // axios v1 narrowed the constructor's config type to
        // InternalAxiosRequestConfig; the public AxiosRequestConfig we hold
        // is structurally compatible at runtime.
        config as never,
        undefined,
        response,
      );
      throw errorFromAxios(synthetic);
    }

    // Should be unreachable — every iteration either returns or throws.
    if (lastError instanceof AxiosError) throw errorFromAxios(lastError);
    throw new Error('InvenflowClient: exhausted retry attempts');
  }

  // ---------------------------------------------------------------------------
  // §4.1 GET /api/health
  // ---------------------------------------------------------------------------

  async health(): Promise<HealthResponse> {
    const res = await this.request<HealthResponse>({
      method: 'GET',
      url: '/api/health',
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // §4.2 GET /api/kanbans?type=order
  // ---------------------------------------------------------------------------

  async listKanbans(type: 'order' | 'receive'): Promise<KanbanListResponse> {
    const res = await this.request<KanbanListResponse>({
      method: 'GET',
      url: '/api/kanbans',
      params: { type },
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // §4.3 GET /api/kanbans/{kanbanId}/columns
  // ---------------------------------------------------------------------------

  async listKanbanColumns(kanbanId: string): Promise<KanbanColumnsResponse> {
    const res = await this.request<KanbanColumnsResponse>({
      method: 'GET',
      url: `/api/kanbans/${encodeURIComponent(kanbanId)}/columns`,
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // §4.4 POST /api/upload (multipart)
  // ---------------------------------------------------------------------------

  async uploadFile(
    file: Buffer | Blob,
    filename: string,
    mimeType: string,
  ): Promise<UploadResponse> {
    // Use a Web FormData (available in Node 18+ and the browser) so we don't
    // have to depend on the `form-data` package. Convert Buffer → Blob if
    // necessary; both are accepted by FormData.append.
    const form = new FormData();
    let payload: Blob;
    if (typeof Blob !== 'undefined' && file instanceof Blob) {
      payload = file;
    } else {
      // Buffer path. Cast to ArrayBufferLike for the Blob constructor.
      const arr = new Uint8Array(file as Buffer);
      payload = new Blob([arr], { type: mimeType });
    }
    form.append('image', payload, filename);

    // axios will set the multipart boundary automatically when given FormData.
    const res = await this.request<UploadResponse>({
      method: 'POST',
      url: '/api/upload',
      data: form,
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // §4.5 POST /api/marketplace/sku-mappings/resolve
  // ---------------------------------------------------------------------------

  async resolveSkuMapping(
    platform: Platform,
    marketplaceProductName: string,
  ): Promise<ResolveSkuResponse> {
    const res = await this.request<ResolveSkuResponse>({
      method: 'POST',
      url: '/api/marketplace/sku-mappings/resolve',
      data: { platform, marketplaceProductName },
      headers: { 'Content-Type': 'application/json' },
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // §4.6 POST /api/marketplace/orders
  // ---------------------------------------------------------------------------

  async ingestOrder(payload: IngestOrderRequest): Promise<IngestOrderResponse> {
    const res = await this.request<IngestOrderResponse>({
      method: 'POST',
      url: '/api/marketplace/orders',
      data: payload,
      headers: { 'Content-Type': 'application/json' },
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // §4.7 GET /api/marketplace/orders/{invoiceNumber}
  // ---------------------------------------------------------------------------

  async getOrder(invoiceNumber: string): Promise<OrderState> {
    const res = await this.request<OrderState>({
      method: 'GET',
      url: `/api/marketplace/orders/${encodeURIComponent(invoiceNumber)}`,
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // §4.8 PATCH .../transition
  //
  // Returns OperatorMovedResponse on 409 (per §3.4); throws InvenflowApiError
  // on any other non-2xx.
  // ---------------------------------------------------------------------------

  async transitionLine(
    invoiceNumber: string,
    lineItemId: string,
    payload: TransitionRequest,
  ): Promise<TransitionResponse | OperatorMovedResponse> {
    // We bypass the shared request helper for this one because we need to
    // inspect 409 bodies and short-circuit retries on them.
    let lastError: unknown;
    const url = `/api/marketplace/orders/${encodeURIComponent(invoiceNumber)}/lines/${encodeURIComponent(lineItemId)}/transition`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: AxiosResponse<unknown>;
      try {
        response = await this.http.request<unknown>({
          method: 'PATCH',
          url,
          data: payload,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BACKOFFS_MS[attempt - 1] ?? 0);
          continue;
        }
        if (err instanceof AxiosError) throw errorFromAxios(err);
        throw err;
      }

      const { status, data } = response;

      if (status >= 200 && status < 300) {
        return data as TransitionResponse;
      }

      if (status === 409) {
        // Expected outcome: operator already moved the card.
        if (
          data &&
          typeof data === 'object' &&
          (data as { code?: unknown }).code === 'OPERATOR_MOVED'
        ) {
          return data as OperatorMovedResponse;
        }
        // Some other 409 — surface as an error.
        const synthetic = new AxiosError(
          `Request failed with status 409`,
          undefined,
          undefined,
          undefined,
          response,
        );
        throw errorFromAxios(synthetic);
      }

      if (shouldRetry(status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = parseRetryAfterMs(response.headers['retry-after']);
        const backoff = retryAfter ?? RETRY_BACKOFFS_MS[attempt - 1] ?? 0;
        await sleep(backoff);
        continue;
      }

      const synthetic = new AxiosError(
        `Request failed with status ${status}`,
        undefined,
        undefined,
        undefined,
        response,
      );
      throw errorFromAxios(synthetic);
    }

    if (lastError instanceof AxiosError) throw errorFromAxios(lastError);
    throw new Error('InvenflowClient: exhausted retry attempts');
  }
}

/**
 * Convenience: detect an OPERATOR_MOVED 409 result vs a normal transition.
 * Lets the caller branch without poking at `code` directly.
 */
export function isOperatorMoved(
  res: TransitionResponse | OperatorMovedResponse,
): res is OperatorMovedResponse {
  return (
    (res as OperatorMovedResponse).code === 'OPERATOR_MOVED' &&
    (res as OperatorMovedResponse).noop === true
  );
}
