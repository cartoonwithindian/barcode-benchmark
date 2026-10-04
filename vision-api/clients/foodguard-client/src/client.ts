/**
 * `VisionApiClient` — the reference integration surface for FoodGuard.
 *
 * Thin on purpose. It sends, it types, it classifies failures, and it never
 * interprets a product. The interpretation helpers live in ./helpers.js so a
 * caller can use the raw response without inheriting our opinion of it.
 */
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  VisionApiTransport,
  type AuthHeaderStyle,
  type ClientLogger,
  type FetchLike,
  type RetryOptions,
  type TransportResult,
} from './http.js';
import {
  API_VERSION,
  ErrorCode,
  SCHEMA_VERSION,
  type AnalysisResponse,
  type AnalyzeOptions,
  type AnalyzeRequest,
  type HealthResponse,
  type MetricsResponse,
  type VersionResponse,
} from './types.js';
import { VisionApiError } from './errors.js';

export interface VisionApiClientOptions {
  /** Service origin. `/v1/...` is appended for you. */
  baseUrl: string;
  /** Sent as `X-API-Key` by default. Omit only for a deliberately open deployment. */
  apiKey?: string;
  /** `'x-api-key'` (default) or `'authorization'`, which sends `Authorization: Bearer <key>`. */
  authHeader?: AuthHeaderStyle;
  /** Per-request deadline in ms. Defaults to DEFAULT_TIMEOUT_MS (60s, OCR-sized). */
  timeoutMs?: number;
  /** Inject for tests. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  logger?: ClientLogger;
  retry?: RetryOptions;
  userAgent?: string;
}

export interface AnalyzeCallOptions {
  /** Overrides the client deadline for this call. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Forwarded as `x-request-id`; the service echoes it back on the response. */
  requestId?: string;
  retry?: RetryOptions | false;
  /**
   * Sent as `options.timeout_ms` so the *service* also gives up. The route
   * clamps this to its own maximum (src/routes/analyze.ts:63-65), so setting a
   * huge value is not a way to buy more time — it silently becomes the cap.
   * Leave it unset and use `timeoutMs` (client-side) unless you want the server
   * to stop early too.
   */
  serverTimeoutMs?: number;
}

/** Response plus the transport facts a caller sometimes needs (retries, ids). */
export interface CallResult<T> {
  data: T;
  httpStatus: number;
  /** `x-request-id` response header, falling back to the id that was sent. */
  requestId: string | null;
  attempts: number;
  /**
   * Set when the service answered with a `schema_version` this client was not
   * written against (it understands `'1'`). Additive fields are fine, a
   * different version is worth surfacing to an operator — it is deliberately not
   * thrown, because breaking a product scan over a version string is worse.
   */
  schemaVersionMismatch?: string;
}

export class VisionApiClient {
  private readonly transport: VisionApiTransport;

  constructor(options: VisionApiClientOptions) {
    this.transport = new VisionApiTransport(options);
  }

  /**
   * Builds a client from the environment. FoodGuard's backend sets:
   *   FOODGUARD_VISION_API_URL   service origin (default http://127.0.0.1:8080)
   *   FOODGUARD_VISION_API_KEY   the key that matches the service's `API_KEYS`
   *   FOODGUARD_VISION_TIMEOUT_MS  optional deadline override
   *
   * These names are the client's own; the *service* reads `API_KEYS`
   * (src/config/index.ts:48). The key never touches a log line or an error
   * message — `VisionApiError.message` only ever carries server text.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<VisionApiClientOptions> = {}): VisionApiClient {
    const timeoutRaw = env.FOODGUARD_VISION_TIMEOUT_MS;
    const parsedTimeout = timeoutRaw === undefined || timeoutRaw.trim() === '' ? undefined : Number(timeoutRaw);
    if (parsedTimeout !== undefined && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
      throw new Error('FOODGUARD_VISION_TIMEOUT_MS must be a positive number of milliseconds.');
    }
    return new VisionApiClient({
      baseUrl: env.FOODGUARD_VISION_API_URL ?? 'http://127.0.0.1:8080',
      apiKey: env.FOODGUARD_VISION_API_KEY,
      ...(parsedTimeout !== undefined ? { timeoutMs: parsedTimeout } : {}),
      ...overrides,
    });
  }

  /** The configured service origin, without a trailing slash. */
  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /** The configured per-request deadline in ms. */
  get timeoutMs(): number {
    return this.transport.timeoutMs;
  }

  /**
   * `POST /v1/analyze` — barcodes, OCR text, ingredients, nutrition and the
   * Indian retail fields, read off one photo of a pack.
   *
   * Throws `VisionApiError` for any non-2xx response, `VisionApiTransportError`
   * when the network fails and `VisionApiTimeoutError` on the client deadline.
   * A successful call that found nothing still resolves: "no barcode" and "no
   * barcode because nothing ran" are reported inside the response, never as an
   * exception.
   */
  async analyze(request: AnalyzeRequest, options: AnalyzeCallOptions = {}): Promise<AnalysisResponse> {
    const { data } = await this.analyzeWithMeta(request, options);
    return data;
  }

  /** `analyze` plus the transport metadata. Use it when a retry actually happened. */
  async analyzeWithMeta(
    request: AnalyzeRequest,
    options: AnalyzeCallOptions = {},
  ): Promise<CallResult<AnalysisResponse>> {
    assertAnalyzeRequest(request);
    // `serverTimeoutMs` is merged last so a per-call override always wins over
    // the request's own `options.timeout_ms`.
    const mergedOptions: AnalyzeOptions = { ...request.options };
    if (options.serverTimeoutMs !== undefined) mergedOptions.timeout_ms = options.serverTimeoutMs;
    const body: AnalyzeRequest = {
      image_url: request.image_url,
      // An empty `options: {}` is legal but pointless; omit it entirely.
      ...(Object.keys(mergedOptions).length > 0 ? { options: mergedOptions } : {}),
    };

    const result = await this.transport.send<AnalysisResponse>({
      path: `/${API_VERSION}/analyze`,
      method: 'POST',
      body,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
    });

    const schemaVersionMismatch = assertAnalysisResponse(result.data);
    return {
      data: result.data,
      httpStatus: result.httpStatus,
      requestId: result.requestId,
      attempts: result.attempts,
      ...(schemaVersionMismatch !== null ? { schemaVersionMismatch } : {}),
    };
  }

  /**
   * `GET /health`. Resolves with `status: 'degraded'` and an HTTP 503 when the
   * service is up but no barcode engine loaded, so read the field rather than
   * relying on the exception.
   */
  async health(options: CallOptions = {}): Promise<CallResult<HealthResponse>> {
    const result = await this.transport.send<HealthResponse>({
      path: '/health',
      method: 'GET',
      ...passThrough(options),
    });
    return toCallResult(result);
  }

  /** `GET /version` — build identity, engine status, effective config. Never authenticated. */
  async version(options: CallOptions = {}): Promise<CallResult<VersionResponse>> {
    const result = await this.transport.send<VersionResponse>({
      path: '/version',
      method: 'GET',
      ...passThrough(options),
    });
    return toCallResult(result);
  }

  /**
   * `GET /metrics`. Returns HTTP 404 when the service runs with
   * `EXPOSE_METRICS=false` (src/routes/operational.ts:99-102), which surfaces as
   * a `VisionApiError` with `code: 'NOT_FOUND'`.
   */
  async metrics(options: CallOptions = {}): Promise<CallResult<MetricsResponse>> {
    const result = await this.transport.send<MetricsResponse>({
      path: '/metrics',
      method: 'GET',
      ...passThrough(options),
    });
    return toCallResult(result);
  }
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  requestId?: string;
  retry?: RetryOptions | false;
}

function passThrough(options: CallOptions): {
  timeoutMs?: number;
  signal?: AbortSignal;
  requestId?: string;
  retry?: RetryOptions | false;
} {
  return {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  };
}

function toCallResult<T>(result: TransportResult<T>): CallResult<T> {
  return { data: result.data, httpStatus: result.httpStatus, requestId: result.requestId, attempts: result.attempts };
}

// ── Local pre-flight checks ─────────────────────────────────────────────────

/**
 * Mirrors the server's zod bounds so an obviously bad call fails locally
 * instead of spending a round trip (src/routes/analyze.ts:24-34). The client
 * never *widens* what the server accepts: it only rejects earlier.
 */
function assertAnalyzeRequest(request: AnalyzeRequest): void {
  const url = request.image_url;
  if (typeof url !== 'string' || url.length < 8 || url.length > 2048) {
    throw localValidation('image_url must be a string of 8..2048 characters.', 'image_url');
  }
  const options = request.options;
  if (options === undefined) return;
  if (options.plan !== undefined && !['fast', 'standard', 'deep'].includes(options.plan)) {
    throw localValidation('options.plan must be one of fast, standard, deep.', 'options.plan');
  }
  if (options.max_variants !== undefined && (!Number.isInteger(options.max_variants) || options.max_variants < 1 || options.max_variants > 40)) {
    throw localValidation('options.max_variants must be an integer of 1..40.', 'options.max_variants');
  }
  if (options.timeout_ms !== undefined && (!Number.isInteger(options.timeout_ms) || options.timeout_ms < 1_000 || options.timeout_ms > 300_000)) {
    throw localValidation('options.timeout_ms must be an integer of 1000..300000.', 'options.timeout_ms');
  }
  for (const key of ['ocr', 'normalize_text'] as const) {
    const value = options[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw localValidation(`options.${key} must be a boolean.`, `options.${key}`);
    }
  }
}

function localValidation(message: string, field: string): VisionApiError {
  return new VisionApiError({
    code: ErrorCode.VALIDATION_ERROR,
    httpStatus: 400,
    message,
    requestId: null,
    fields: [field],
    details: { fields: [field], note: 'Rejected by the client before sending; the service would answer VALIDATION_ERROR too.' },
    attempts: 0,
  });
}

/**
 * A 200 with no `barcode` object is not this service's analysis response — most
 * likely a proxy or a different app on the port. Fail loudly instead of handing
 * FoodGuard `undefined.barcode`. Returns a mismatch notice when the schema
 * version is not the one this client mirrors.
 */
function assertAnalysisResponse(data: AnalysisResponse): string | null {
  if (typeof data !== 'object' || data === null || typeof data.barcode !== 'object' || data.barcode === null) {
    throw new VisionApiError({
      code: null,
      httpStatus: 200,
      message: 'The Vision API returned 200 but the body is not an analysis response (missing `barcode`).',
      requestId: null,
      details: data,
      attempts: 0,
    });
  }
  return data.schema_version === SCHEMA_VERSION ? null : `expected schema_version ${SCHEMA_VERSION}, service sent ${String(data.schema_version)}`;
}

export { DEFAULT_RETRY, DEFAULT_TIMEOUT_MS };
export type { AuthHeaderStyle, ClientLogger, FetchLike, RetryOptions };