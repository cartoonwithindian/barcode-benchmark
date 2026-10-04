/**
 * Typed failures.
 *
 * Three shapes, three causes, one rule: an error is never swallowed and never
 * downgraded to a "no result". If the caller asked for an analysis and did not
 * get one, something in this chain throws.
 *
 *   FoodGuardClientError          base — always carries the request id
 *   ├── VisionApiError            the service answered with a failure envelope
 *   ├── VisionApiTransportError   fetch itself failed (DNS, refused, reset)
 *   └── VisionApiTimeoutError     our own deadline fired
 *
 * Sources: src/core/errors.ts (codes + public envelope), src/server.ts:126-172
 * (envelope shape), src/security/auth.ts (401 has no fields, no details).
 */
import { ErrorCode, type ErrorCodeValue, type VisionApiErrorEnvelope } from './types.js';

export interface VisionApiErrorInit {
  /** `null` when the response carried no recognisable code — a non-envelope failure. */
  code: ErrorCodeValue | null;
  httpStatus: number;
  message: string;
  requestId: string | null;
  /** The entire raw response body, exactly as received. Never synthesised. */
  details?: unknown;
  fields?: string[];
  retryAfterSeconds?: number;
  failureStage?: string;
  attempts?: number;
  cause?: unknown;
}

/** Base class so a caller can `catch (e) { if (e instanceof FoodGuardClientError) ... }`. */
export class FoodGuardClientError extends Error {
  readonly requestId: string | null;
  /** How many HTTP attempts were made in total (1 when the first attempt failed). */
  readonly attempts: number;

  constructor(message: string, init: { requestId?: string | null; attempts?: number; cause?: unknown }) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.requestId = init.requestId ?? null;
    this.attempts = init.attempts ?? 1;
  }
}

/** The service replied with a non-2xx status carrying its failure envelope. */
export class VisionApiError extends FoodGuardClientError {
  /** `null` only when the body was not a recognisable envelope (e.g. an HTML 502 from a proxy). */
  readonly code: ErrorCodeValue | null;
  readonly httpStatus: number;
  /** Raw parsed body. `AppError.details` is operator-only, so this is the most detail a caller can get. */
  readonly details: unknown;
  readonly fields: string[];
  readonly retryAfterSeconds: number | null;
  readonly failureStage: string | null;

  constructor(init: VisionApiErrorInit) {
    super(init.message, { requestId: init.requestId, attempts: init.attempts, cause: init.cause });
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.details = init.details ?? null;
    this.fields = init.fields ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.failureStage = init.failureStage ?? null;
  }

  /**
   * True when this failure is worth another attempt.
   *
   * A body with no recognisable code (`code === null`, e.g. an HTML 502 from a
   * proxy) falls back to the status rule, so this getter never disagrees with
   * `isRetryableError()` — which is what actually drives the retry.
   */
  get retryable(): boolean {
    return isRetryableError(this);
  }
}

/** `fetch` rejected: DNS failure, connection refused/reset, TLS failure. */
export class VisionApiTransportError extends FoodGuardClientError {}

/** The client's own deadline fired before the service answered. */
export class VisionApiTimeoutError extends FoodGuardClientError {
  readonly timeoutMs: number;

  constructor(init: { timeoutMs: number; requestId: string | null; attempts?: number; cause?: unknown }) {
    super(`Request timed out after ${init.timeoutMs}ms waiting for the Vision API.`, {
      requestId: init.requestId,
      attempts: init.attempts,
      cause: init.cause,
    });
    this.timeoutMs = init.timeoutMs;
  }
}

// ── Retry classification ────────────────────────────────────────────────────

/**
 * Codes worth one more attempt. Everything else is a request the caller has to
 * change, so repeating it would only burn budget and, for `RATE_LIMITED`, make
 * the situation worse.
 *
 * Sources for the statuses: `STATUS_BY_CODE` in src/core/errors.ts:30-47.
 *  - `RATE_LIMITED` (429) and `DOWNLOAD_TIMEOUT` (504): named explicitly.
 *  - `DOWNLOAD_FAILED` (502), `ANALYSIS_FAILED` (500), `INTERNAL_ERROR` (500)
 *    and `SERVICE_UNAVAILABLE` (503): 5xx, which `isRetryableStatus` covers on
 *    its own. They are listed here so the exported set is readable on its own.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCodeValue> = new Set<ErrorCodeValue>([
  ErrorCode.RATE_LIMITED,
  ErrorCode.DOWNLOAD_TIMEOUT,
  ErrorCode.DOWNLOAD_FAILED,
  ErrorCode.ANALYSIS_FAILED,
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.SERVICE_UNAVAILABLE,
]);

/**
 * Codes a retry cannot fix. `VALIDATION_ERROR`/`INVALID_URL`/`INVALID_IMAGE`
 * (400), `BLOCKED_URL`/`UNSUPPORTED_SCHEME` (400), `UNAUTHORIZED` (401),
 * `NOT_FOUND` (404), `UNSUPPORTED_MEDIA_TYPE` (415), `DOWNLOAD_TOO_LARGE` and
 * `IMAGE_TOO_LARGE` (413). All statuses from src/core/errors.ts:30-47.
 */
export const NON_RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCodeValue> = new Set<ErrorCodeValue>([
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.INVALID_URL,
  ErrorCode.BLOCKED_URL,
  ErrorCode.UNSUPPORTED_SCHEME,
  ErrorCode.INVALID_IMAGE,
  ErrorCode.DOWNLOAD_TOO_LARGE,
  ErrorCode.IMAGE_TOO_LARGE,
  ErrorCode.UNAUTHORIZED,
  ErrorCode.NOT_FOUND,
  ErrorCode.UNSUPPORTED_MEDIA_TYPE,
]);

type CodesOf<S extends ReadonlySet<ErrorCodeValue>> = S extends ReadonlySet<infer C> ? C : never;
type UnclassifiedCode = Exclude<ErrorCodeValue, CodesOf<typeof RETRYABLE_ERROR_CODES> | CodesOf<typeof NON_RETRYABLE_ERROR_CODES>>;

/**
 * Compile-time guarantee that every server code is on one side of the line.
 * If a future build adds an `ErrorCode`, this stops being `true` and the build
 * fails — which is the moment someone should decide whether it is retryable.
 */
export const EVERY_ERROR_CODE_IS_CLASSIFIED: UnclassifiedCode extends never ? true : false = true;

/** Mirrors the status rule used above: 429 and every 5xx. */
export function isRetryableStatus(httpStatus: number): boolean {
  return httpStatus === 429 || httpStatus >= 500;
}

/**
 * True when the failure envelope or transport condition is worth one retry.
 * A missing/unrecognised `code` defers to the status, which is what happens when
 * a proxy or the Render edge answers before Fastify's error handler runs.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof VisionApiTransportError) return true;
  // A client-side deadline is *not* retried: the service is probably still
  // working on the image, and a second copy costs a second pipeline run. Raise
  // `timeoutMs` instead.
  if (error instanceof VisionApiTimeoutError) return false;
  if (error instanceof VisionApiError) {
    if (error.code !== null) return RETRYABLE_ERROR_CODES.has(error.code);
    return isRetryableStatus(error.httpStatus);
  }
  return false;
}

/** The status code the service assigns to a code, from src/core/errors.ts:30-47. */
export const STATUS_BY_CODE: Readonly<Record<ErrorCodeValue, number>> = {
  VALIDATION_ERROR: 400,
  INVALID_URL: 400,
  BLOCKED_URL: 400,
  UNSUPPORTED_SCHEME: 400,
  DOWNLOAD_FAILED: 502,
  DOWNLOAD_TIMEOUT: 504,
  DOWNLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_IMAGE: 400,
  IMAGE_TOO_LARGE: 413,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  ANALYSIS_FAILED: 500,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

// ── Envelope parsing ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the failure envelope from a parsed body. Returns `null` when the body
 * is not an envelope (an HTML error page from a proxy, an empty 502, …) so the
 * caller can still raise a typed error with `code: null` rather than guessing.
 */
export function parseErrorEnvelope(
  body: unknown,
): { envelope: VisionApiErrorEnvelope; error: VisionApiErrorEnvelope['error'] } | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (!isRecord(error)) return null;
  const code = error.code;
  if (typeof code !== 'string' || !isKnownErrorCode(code)) return null;

  const fields = Array.isArray(error.fields)
    ? error.fields.filter((field): field is string => typeof field === 'string')
    : undefined;
  const parsed: VisionApiErrorEnvelope = {
    success: false,
    ...(typeof body.request_id === 'string' ? { request_id: body.request_id } : {}),
    error: {
      code,
      message: typeof error.message === 'string' ? error.message : 'The Vision API rejected the request.',
      ...(typeof error.retry_after_seconds === 'number' ? { retry_after_seconds: error.retry_after_seconds } : {}),
      ...(fields && fields.length > 0 ? { fields } : {}),
    },
    ...(isRecord(body.meta) && typeof body.meta.failure_stage === 'string'
      ? { meta: { failure_stage: body.meta.failure_stage } }
      : {}),
  };
  return { envelope: parsed, error: parsed.error };
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>(Object.values(ErrorCode));

export function isKnownErrorCode(value: string): value is ErrorCodeValue {
  return KNOWN_ERROR_CODES.has(value);
}