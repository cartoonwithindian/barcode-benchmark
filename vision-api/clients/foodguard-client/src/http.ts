/**
 * HTTP transport: auth header, deadline, one bounded retry, typed errors.
 *
 * No dependencies. `fetch` only. Everything here is deliberately small and
 * observable, because an integration client is a piece of code FoodGuard will
 * debug from a log line at 2am.
 *
 * Auth: `X-API-Key: <key>` is the service's preferred form (src/security/auth.ts:30-33);
 * `Authorization: Bearer <key>` is the alternative (src/security/auth.ts:34-39).
 * Request id: sent as `x-request-id`, which Fastify adopts as `request.id`
 * (src/server.ts:46) and echoes back on the `x-request-id` response header
 * (src/server.ts:112-114).
 */
import {
  isRetryableError,
  parseErrorEnvelope,
  VisionApiError,
  VisionApiTimeoutError,
  VisionApiTransportError,
} from './errors.js';

/** The slice of `fetch` this client needs, so tests can inject a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Optional structured logging. Every method is optional; missing ones are skipped. */
export interface ClientLogger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/** How a retry is presented. See `resolveAuthHeader` in ../src/http.js for the mapping. */
export type AuthHeaderStyle = 'x-api-key' | 'authorization';

/**
 * Bounded retry policy.
 *
 * `POST /v1/analyze` is a pure read of an image URL with no side effects, so a
 * single retry cannot duplicate work — that is what makes a bounded retry honest
 * here rather than dangerous.
 */
export interface RetryOptions {
  /** Total attempts including the first. `1` disables retrying. Default 2. */
  maxAttempts: number;
  /** First backoff delay; attempt n waits `baseDelayMs * 2^(n-2)` capped by `maxDelayMs`. Default 400. */
  baseDelayMs: number;
  /** Ceiling for a single backoff wait, and for a server-requested `Retry-After`. Default 4_000. */
  maxDelayMs: number;
  /**
   * When true (default) a server `retry-after` / `retry_after_seconds` overrides
   * the computed backoff, clamped to `maxDelayMs`. When false the client's own
   * schedule wins — useful when the caller has its own pacing budget.
   */
  respectRetryAfter: boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 2,
  baseDelayMs: 400,
  maxDelayMs: 4_000,
  respectRetryAfter: true,
};

export const NO_RETRY: RetryOptions = { ...DEFAULT_RETRY, maxAttempts: 1 };

/**
 * Coerces anything into a usable policy.
 *
 * `retry` reaches this module from config, from an env file and from JavaScript
 * callers who never read the type. A malformed value must degrade to the
 * defaults, never to `NaN`: `Math.max(1, NaN)` is `NaN`, a `NaN` attempt bound
 * skips the loop entirely and the caller gets a bare `throw undefined` instead
 * of a typed error. (Found by the retry harness, not by inspection.)
 */
export function normaliseRetry(value: unknown): RetryOptions {
  if (typeof value !== 'object' || value === null) return DEFAULT_RETRY;
  const candidate = value as Partial<RetryOptions>;
  return {
    maxAttempts: positiveInt(candidate.maxAttempts, DEFAULT_RETRY.maxAttempts),
    baseDelayMs: nonNegative(candidate.baseDelayMs, DEFAULT_RETRY.baseDelayMs),
    maxDelayMs: nonNegative(candidate.maxDelayMs, DEFAULT_RETRY.maxDelayMs),
    respectRetryAfter:
      typeof candidate.respectRetryAfter === 'boolean'
        ? candidate.respectRetryAfter
        : DEFAULT_RETRY.respectRetryAfter,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Default per-request deadline.
 *
 * Derived from the service's own budget rather than picked by feel
 * (src/config/index.ts:66, 74, 82, 63):
 *   download  ≤ 12_000 ms  (DOWNLOAD_TIMEOUT_MS)
 * + pipeline  ≤ 45_000 ms  (OCR_TIMEOUT_MS; the route clamps `timeout_ms` to
 *                          max(BARCODE_MAX_MS, OCR_TIMEOUT_MS), src/routes/analyze.ts:63)
 *   ≈ 57_000 ms worst case
 *
 * 60s therefore clears a legitimately slow full-label OCR while staying under
 * `REQUEST_TIMEOUT_MS` (90s) — so when this deadline fires, the service has
 * genuinely given up rather than still working. Barcode-only requests (`ocr:false`)
 * finish in single-digit seconds; use ~15s there.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface TransportOptions {
  /** Service origin, e.g. `https://foodguard-vision-api.onrender.com`. */
  baseUrl: string;
  apiKey?: string;
  authHeader?: AuthHeaderStyle;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  logger?: ClientLogger;
  retry?: RetryOptions;
  /** Sent as `user-agent`. Node's undici sets its own; override if you need to. */
  userAgent?: string;
}

export interface TransportRequest {
  /** Path relative to `baseUrl`, e.g. `/v1/analyze`. */
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  /** Composed with the internal deadline; aborting it cancels the call. */
  signal?: AbortSignal;
  /** Forwarded as `x-request-id`. The service echoes it back verbatim. */
  requestId?: string;
  /** Overrides the client-level retry policy; `false` disables retrying. */
  retry?: RetryOptions | false;
}

export interface TransportResult<T> {
  data: T;
  httpStatus: number;
  /** `x-request-id` from the response, else the id we sent, else null. */
  requestId: string | null;
  attempts: number;
}

export class VisionApiTransport {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly authHeader: AuthHeaderStyle;
  private readonly fetchImpl: FetchLike;
  private readonly logger: ClientLogger | undefined;
  private readonly retry: RetryOptions;
  private readonly userAgent: string | undefined;

  constructor(options: TransportOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    // X-API-Key is the form src/security/auth.ts documents first; the service
    // rate-limits on that header too (src/server.ts:78-79).
    this.authHeader = options.authHeader ?? 'x-api-key';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
    this.retry = normaliseRetry(options.retry);
    this.userAgent = options.userAgent;

    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new Error(
        'No global fetch available. Use Node 18+ or pass `fetch` in the client options.',
      );
    }
    this.fetchImpl = fetchImpl;
  }

  async send<T>(request: TransportRequest): Promise<TransportResult<T>> {
    const retry = request.retry === false ? NO_RETRY : normaliseRetry(request.retry ?? this.retry);
    const maxAttempts = positiveInt(retry.maxAttempts, 1);

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.attempt<T>(request, attempt);
      } catch (error) {
        lastError = error;
        const canRetry = attempt < maxAttempts && isRetryableError(error);
        if (!canRetry) break;
        const waitMs = this.backoffMs(retry, attempt, error);
        this.logger?.warn?.('vision-api: retrying', {
          attempt,
          max_attempts: maxAttempts,
          wait_ms: waitMs,
          reason: error instanceof Error ? error.message : String(error),
          code: error instanceof VisionApiError ? error.code : null,
          http_status: error instanceof VisionApiError ? error.httpStatus : null,
        });
        await sleep(waitMs, request.signal);
      }
    }

    // Belt and braces: the loop above always assigns on its last iteration, but
    // re-throwing `undefined` would be the one way this client could swallow an
    // error, so it is made impossible rather than merely unlikely.
    if (lastError === undefined) {
      throw new VisionApiTransportError('The Vision API request produced no result and no error.', {
        requestId: request.requestId ?? null,
        attempts: maxAttempts,
      });
    }
    // Each error is constructed inside `attempt()` with its own attempt number,
    // so the caller always learns how many HTTP attempts were really made.
    throw lastError;
  }

  private async attempt<T>(request: TransportRequest, attempt: number): Promise<TransportResult<T>> {
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const { signal, dispose, timedOut } = deadlineSignal(timeoutMs, request.signal);

    try {
      const headers = this.buildHeaders(request);
      const init: RequestInit = {
        method: request.method,
        headers,
        signal,
      };
      if (request.body !== undefined) {
        init.body = JSON.stringify(request.body);
      }

      this.logger?.debug?.('vision-api: request', {
        method: request.method,
        url: `${this.baseUrl}${request.path}`,
        attempt,
        timeout_ms: timeoutMs,
      });

      const response = await this.fetchImpl(`${this.baseUrl}${request.path}`, init);
      const requestId =
        response.headers.get('x-request-id') ?? request.requestId ?? null;

      if (!response.ok) {
        throw await this.toApiError(response, requestId, attempt);
      }

      const text = await response.text();
      const data = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
      return { data, httpStatus: response.status, requestId, attempts: attempt };
    } catch (error) {
      // Checked before the generic transport branch: an abort caused by *our*
      // deadline is a timeout, not a network fault, and is not retried.
      if (timedOut()) {
        throw new VisionApiTimeoutError({
          timeoutMs,
          requestId: request.requestId ?? null,
          attempts: attempt,
          cause: error,
        });
      }
      // The caller cancelled. Surface their reason rather than inventing one.
      if (request.signal?.aborted) {
        throw error;
      }
      if (error instanceof VisionApiError || error instanceof VisionApiTransportError) {
        throw error;
      }
      throw new VisionApiTransportError(
        `Could not reach the Vision API at ${this.baseUrl}${request.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { requestId: request.requestId ?? null, attempts: attempt, cause: error },
      );
    } finally {
      dispose();
    }
  }

  private buildHeaders(request: TransportRequest): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.method === 'POST') headers['content-type'] = 'application/json';
    if (this.apiKey) {
      const auth = resolveAuthHeader(this.authHeader, this.apiKey);
      headers[auth.name] = auth.value;
    }
    if (request.requestId) headers['x-request-id'] = request.requestId;
    if (this.userAgent) headers['user-agent'] = this.userAgent;
    return headers;
  }

  /**
   * Turns a non-2xx response into a typed error. An unparseable body still
   * produces a `VisionApiError` with `code: null` rather than being swallowed —
   * the status and the raw text are kept so the caller can report them.
   */
  private async toApiError(
    response: Response,
    requestId: string | null,
    attempts: number,
  ): Promise<VisionApiError> {
    const raw = await response.text();
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        // Non-JSON body (proxy HTML, empty 502). Keep the text for diagnostics.
        body = raw;
      }
    }

    const parsed = parseErrorEnvelope(body);
    if (parsed) {
      const headerRetryAfter = parseRetryAfterHeader(response.headers.get('retry-after'));
      return new VisionApiError({
        code: parsed.error.code,
        httpStatus: response.status,
        message: parsed.error.message,
        requestId: parsed.envelope.request_id ?? requestId,
        details: body,
        ...(parsed.error.fields ? { fields: parsed.error.fields } : {}),
        ...(headerRetryAfter !== null
          ? { retryAfterSeconds: headerRetryAfter }
          : parsed.error.retry_after_seconds !== undefined
            ? { retryAfterSeconds: parsed.error.retry_after_seconds }
            : {}),
        ...(parsed.envelope.meta ? { failureStage: parsed.envelope.meta.failure_stage } : {}),
        attempts,
      });
    }

    return new VisionApiError({
      code: null,
      httpStatus: response.status,
      message: `The Vision API returned HTTP ${response.status} without a recognisable error envelope.`,
      requestId,
      details: body,
      attempts,
    });
  }

  /**
   * Full-jitter exponential backoff. The jitter is the point: without it, every
   * FoodGuard replica that hits a cold service retries on the same millisecond.
   */
  private backoffMs(retry: RetryOptions, attempt: number, error: unknown): number {
    if (retry.respectRetryAfter && error instanceof VisionApiError && error.retryAfterSeconds !== null) {
      return Math.min(retry.maxDelayMs, Math.max(0, error.retryAfterSeconds * 1000));
    }
    const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(Math.random() * ceiling);
  }
}

/**
 * Builds the credential header for the chosen style.
 *
 * `Authorization` must carry the `Bearer ` scheme or the service will not match
 * the key: `extractApiKey` only accepts `/^Bearer\s+(.+)$/i` (src/security/auth.ts:36).
 */
export function resolveAuthHeader(
  style: AuthHeaderStyle,
  apiKey: string,
): { name: 'x-api-key' | 'authorization'; value: string } {
  return style === 'x-api-key'
    ? { name: 'x-api-key', value: apiKey }
    : { name: 'authorization', value: `Bearer ${apiKey}` };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.replace(/\/+$/, '') : url;
}

/** `retry-after` is emitted in seconds by src/server.ts:161-163. */
function parseRetryAfterHeader(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Combines the caller's signal with our own deadline.
 *
 * Hand-rolled rather than `AbortSignal.any` so the package keeps working on
 * Node 18, and so listeners are always detached — a leaked `abort` listener per
 * request is a slow memory leak in a long-lived backend.
 */
function deadlineSignal(
  timeoutMs: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;

  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(`Vision API request exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  // Do not hold the event loop open for a deadline on a request nobody awaits.
  timer.unref?.();

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Sleep that resolves early when the caller's signal aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}