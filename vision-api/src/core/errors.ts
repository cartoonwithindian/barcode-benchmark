/**
 * Error taxonomy for the public API.
 *
 * Every failure surfaces as an `AppError` with a stable machine readable
 * `code`, an HTTP status and a message that is safe to return to a public
 * caller (no stack traces, no internal URLs, no host details).
 */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_URL: 'INVALID_URL',
  BLOCKED_URL: 'BLOCKED_URL',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  DOWNLOAD_TIMEOUT: 'DOWNLOAD_TIMEOUT',
  DOWNLOAD_TOO_LARGE: 'DOWNLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  INVALID_IMAGE: 'INVALID_IMAGE',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCodeValue, number> = {
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

export interface AppErrorOptions {
  /** Detailed operator-only context. Logged, never returned to the caller. */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Override the derived HTTP status. */
  status?: number;
  /** Hint returned to the client, e.g. a retry-after seconds value. */
  retryAfterSeconds?: number;
  /**
   * Caller-safe pointers to what was wrong (e.g. `["image_url: Required"]`).
   * Only ever populated from the caller's own request, so it is safe to return.
   */
  fields?: string[];
}

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
  readonly fields?: string[];

  constructor(code: ErrorCodeValue, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fields = options.fields;
  }

  toPublicJSON(): {
    code: ErrorCodeValue;
    message: string;
    retry_after_seconds?: number;
    fields?: string[];
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAfterSeconds !== undefined ? { retry_after_seconds: this.retryAfterSeconds } : {}),
      ...(this.fields && this.fields.length > 0 ? { fields: this.fields } : {}),
    };
  }
}

export const badRequest = (code: ErrorCodeValue, message: string, fields?: string[]) =>
  new AppError(code, message, { fields });

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;

/** Wraps an unknown throwable into an AppError without leaking internals. */
export function toAppError(err: unknown, fallbackCode: ErrorCodeValue = ErrorCode.INTERNAL_ERROR): AppError {
  if (isAppError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(fallbackCode, 'Internal processing failure.', {
    cause: err,
    details: { original_message: message },
  });
}