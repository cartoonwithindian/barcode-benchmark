/**
 * Fastify application factory.
 *
 * Kept separate from `index.ts` so tests can build the app and drive it with
 * `app.inject()` — no socket binding, no process signals.
 */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { VisionServer } from './types/fastify.js';
import type { AppConfig } from './config/index.js';
import { AppError, ErrorCode, isAppError, type ErrorCodeValue } from './core/errors.js';
import { createLogger, type Logger } from './core/logger.js';
import { globalMetrics } from './core/metrics.js';
import { newRequestId, runWithContext, setStage, type RequestContext } from './core/requestContext.js';
import { createAuthHook } from './security/auth.js';
import { VisionService } from './analyze/orchestrator.js';
import { registerAnalyzeRoutes, registerSchemaRoute } from './routes/analyze.js';
import { registerOperationalRoutes } from './routes/operational.js';
import { API_VERSION, SCHEMA_VERSION } from './analyze/schema.js';

export const SERVICE_VERSION = '1.0.0';



export interface BuildServerOptions {
  config: AppConfig;
  /** Override the logger (tests inject a silent logger). */
  logger?: Logger;
  /** Override the OCR worker/lang settings for tests. */
  service?: VisionService;
}

export async function buildServer(options: BuildServerOptions): Promise<VisionServer> {
  const { config } = options;
  const log = options.logger ?? createLogger(config);

  const app = Fastify({
    loggerInstance: log,
    trustProxy: config.server.trustProxy,
    bodyLimit: config.server.bodyLimit,
    // `/v1/analyze` and `/health/` behave identically; matching trailing
    // slashes avoids a confusing 404 on a hand-typed URL.
    routerOptions: { ignoreTrailingSlash: true },
    requestIdHeader: 'x-request-id',
    genReqId: () => newRequestId(),
    // Request bodies are validated by zod inside the handlers (see
    // `parseAnalyzeBody`), so Fastify's AJV is never given a route schema and
    // its options are left at their defaults deliberately.
    // Backstop only. The orchestrator enforces `REQUEST_TIMEOUT_MS` (or the
    // caller's `timeout_ms`) internally and finishes the work, so this normally
    // never fires - it exists so a wedged handler cannot hold a socket open
    // indefinitely. The grace window absorbs the response-serialisation tail.
    requestTimeout: config.server.requestTimeoutMs + 5_000,
    connectionTimeout: 30_000,
    keepAliveTimeout: 15_000,
  });

  const service = options.service ?? new VisionService(config, log);
  app.decorate('visionService', service);

  // ── Security headers ──────────────────────────────────────────────────────
  await app.register(helmet, {
    // This is a JSON API, not a page: no CSP needed, and a strict one would
    // only ever be bypassed by API clients anyway.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    global: true,
  });

  await app.register(cors, {
    origin: config.security.corsOrigins.length > 0 ? config.security.corsOrigins : false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'],
    maxAge: 600,
    credentials: false,
  });

  await app.register(rateLimit, {
    max: config.security.rateLimitMax,
    timeWindow: config.security.rateLimitWindow,
    // Key on the API key when present so limits follow the client identity even
    // behind Render's proxy, otherwise fall back to the request IP.
    keyGenerator: (request) => {
      const apiKey = request.headers['x-api-key'];
      if (typeof apiKey === 'string' && apiKey.length > 0) return `key:${createHashLite(apiKey)}`;
      const auth = request.headers.authorization;
      if (typeof auth === 'string' && auth.length > 0) return `key:${createHashLite(auth)}`;
      return request.ip;
    },
    // Operational endpoints must stay reachable so Render health checks pass
    // even when a caller exhausts the limit.
    // Compare on the path, not the raw URL: `request.url` still carries the
    // query string, so `/health?probe=1` would not match and Render's health
    // check could be rate-limited into reporting the service down. The auth hook
    // below already normalises the same way.
    allowList: (request) => {
      const path = request.url.split('?')[0]!.replace(/\/$/, '') || '/';
      return path === '/health' || path === '/version' || path === '/metrics';
    },
    errorResponseBuilder: (request, context) => {
      globalMetrics.increment('rate_limited_total');
      // Same envelope as every other error. A client should never have to
      // special-case 429 to find the request id or the failing stage.
      return {
        success: false,
        request_id: String(request.id),
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many requests. Retry after the indicated window.',
          retry_after_seconds: Math.ceil(context.ttl / 1000),
        },
        meta: { failure_stage: 'rate_limited' },
      };
    },
  });

  // ── Request context (request id + pipeline stage for error reporting) ─────
  app.addHook('onRequest', async (request) => {
    const ctx: RequestContext = {
      requestId: String(request.id),
      stage: 'received',
      startedAt: process.hrtime.bigint(),
    };
    (request as FastifyRequestWithContext).visionContext = ctx;
    runWithContext(ctx, () => undefined);
    globalMetrics.increment('requests_total');
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', String(request.id));
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHook = createAuthHook(config);
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    const isPublic = url === '/health' || url === '/version' || url === '/metrics' || url === '/';
    if (isPublic) return;
    await authHook(request, reply);
  });

  // ── Error handling ────────────────────────────────────────────────────────
  app.setNotFoundHandler((request, reply) => {
    globalMetrics.increment('requests_failed_total');
    return reply.code(404).send({
      success: false,
      request_id: String(request.id),
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'Unknown endpoint. See GET /version for the available routes.',
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const ctx = (request as FastifyRequestWithContext).visionContext;
    const appError: AppError = isAppError(error)
      ? error
      : normaliseFastifyError(error as Error & FastifyErrorFields);

    globalMetrics.increment('requests_failed_total');

    const logPayload: Record<string, unknown> = {
      request_id: String(request.id),
      code: appError.code,
      status: appError.status,
      method: request.method,
      path: (request.url ?? '').split('?')[0],
      failure_stage: ctx?.stage ?? 'unknown',
      message: appError.message,
    };
    if (appError.details) logPayload.details = appError.details;
    if (appError.stack && appError.status >= 500) logPayload.stack = appError.stack;

    if (appError.status >= 500) request.log.error(logPayload, 'request failed');
    else request.log.info(logPayload, 'request rejected');

    if (appError.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(appError.retryAfterSeconds));
    }

    return reply.code(appError.status).send({
      success: false,
      request_id: String(request.id),
      error: appError.toPublicJSON(),
      // Operator-facing context: which stage failed. No stack, no internals.
      meta: { failure_stage: ctx?.stage ?? 'unknown' },
    });
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  await registerOperationalRoutes(app, { config, service, version: SERVICE_VERSION });

  app.get('/', async (_request, reply) =>
    reply.code(200).send({
      service: 'foodguard-vision-api',
      version: SERVICE_VERSION,
      schema_version: SCHEMA_VERSION,
      endpoints: {
        analyze: `/${API_VERSION}/analyze`,
        schema: `/${API_VERSION}/analyze/schema`,
        status: `/${API_VERSION}/status`,
        health: '/health',
        version: '/version',
        metrics: '/metrics',
      },
    }),
  );

  app.get(`/${API_VERSION}/status`, async () => ({
    service: 'foodguard-vision-api',
    version: SERVICE_VERSION,
    status: 'operational',
    endpoints: [`/${API_VERSION}/analyze`, `/${API_VERSION}/analyze/schema`, '/health', '/version', '/metrics'],
  }));

  await registerSchemaRoute(app, Math.max(config.pipeline.barcode.maxMs, config.pipeline.ocr.timeoutMs));
  await registerAnalyzeRoutes(app, {
    service,
    maxTimeoutMs: Math.max(config.pipeline.barcode.maxMs, config.pipeline.ocr.timeoutMs),
  });

  app.addHook('onResponse', async (_request, reply) => {
    const url = (reply.request.url ?? '').split('?')[0];
    if (url === `/${API_VERSION}/analyze`) {
      globalMetrics.observe('http_analyze', Number(reply.elapsedTime ?? 0));
    }
  });

  return app;
}

interface FastifyRequestWithContext {
  visionContext?: RequestContext;
}

/** The Fastify error fields the normaliser inspects. */
interface FastifyErrorFields {
  statusCode?: number;
  validation?: unknown;
  code?: string;
}

/** Non-2xx Fastify validation errors become the service's error taxonomy. */
function normaliseFastifyError(error: Error & FastifyErrorFields): AppError {
  if (error.validation) {
    return new AppError(ErrorCode.VALIDATION_ERROR, 'The request body is invalid.', {
      details: { reason: 'schema_validation' },
      cause: error,
    });
  }
  if (error.statusCode === 413) {
    return new AppError(ErrorCode.VALIDATION_ERROR, 'The request body is too large.', { cause: error });
  }
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new AppError(ErrorCode.VALIDATION_ERROR, 'The request body is too large.', { cause: error });
  }
  if (error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return new AppError(ErrorCode.VALIDATION_ERROR, 'A JSON request body is required.', { cause: error });
  }
  if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Use Content-Type: application/json.', { cause: error });
  }
  if ((error.statusCode ?? 500) < 500) {
    return new AppError(ErrorCode.VALIDATION_ERROR, error.message, { cause: error });
  }
  return new AppError(ErrorCode.INTERNAL_ERROR, 'Internal processing failure.', {
    cause: error,
    details: { original_message: error.message },
  });
}

/** Cheap stable hash for rate-limit keys (never the raw credential). */
function createHashLite(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export { setStage, globalMetrics };
export type { ErrorCodeValue };
