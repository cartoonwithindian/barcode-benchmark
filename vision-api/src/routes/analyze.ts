/**
 * `POST /v1/analyze` — the single analysis endpoint.
 *
 * Request body (validated with zod):
 *   { "image_url": "https://.../pack.jpg",
 *     "options": { "plan": "standard", "ocr": true, "max_variants": 6,
 *                  "timeout_ms": 30000, "normalize_text": true } }
 *
 * Authentication: when `API_KEYS` is configured, either `X-API-Key` or
 * `Authorization: Bearer <key>` is required.
 */
import { sinceMs } from '../core/async.js';
import type { VisionServer } from '../types/fastify.js';
import { z } from 'zod';
import { AppError, ErrorCode } from '../core/errors.js';
import { setStage } from '../core/requestContext.js';
import { globalMetrics } from '../core/metrics.js';
import type { Logger } from '../core/logger.js';
import type { VisionService } from '../analyze/orchestrator.js';
import { API_VERSION } from '../analyze/schema.js';

const analyzeBodySchema = z
  .object({
    image_url: z.string().min(8).max(2048),
    options: z
      .object({
        plan: z.enum(['fast', 'standard', 'deep']).optional(),
        ocr: z.boolean().optional(),
        max_variants: z.number().int().min(1).max(40).optional(),
        timeout_ms: z.number().int().min(1000).max(300_000).optional(),
        normalize_text: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface AnalyzeRouteDeps {
  service: VisionService;
  maxTimeoutMs: number;
}

export async function registerAnalyzeRoutes(app: VisionServer, deps: AnalyzeRouteDeps): Promise<void> {
  app.post(`/${API_VERSION}/analyze`, async (request, reply) => {
    setStage('received');
    const log = request.log;
    const requestId = (request.id as string) || 'unknown';

    const parsed = analyzeBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join('.') || 'body'}: ${i.message}`,
      );
      log.info({ request_id: requestId, issues }, 'analysis request rejected by validation');
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'The request body is invalid.', {
        // `fields` echoes only the caller's own input path plus a zod message.
        fields: issues,
        details: { issues },
      });
    }

    const options = parsed.data.options ?? {};
    // A caller asking for more than the server allows gets the server's value,
    // not a silent downgrade: say so in the response rather than returning a
    // result that looks like it honoured the original number.
    let timeoutClamped = false;
    if (options.timeout_ms && options.timeout_ms > deps.maxTimeoutMs) {
      options.timeout_ms = deps.maxTimeoutMs;
      timeoutClamped = true;
    }

    const startedAt = process.hrtime.bigint();
    try {
      const result = await deps.service.analyze(
        { image_url: parsed.data.image_url, options },
        { requestId, log: log as unknown as Logger },
      );
      const ms = sinceMs(startedAt);
      if (timeoutClamped) reply.header('x-timeout-clamped-ms', String(deps.maxTimeoutMs));
      return reply.code(200).header('x-request-id', requestId).send({ ...result, diagnostics: { ...result.diagnostics, processing_time_ms: ms } });
    } catch (err) {
      globalMetrics.increment('analysis_failures_total');
      throw err;
    }
  });
}

/** OPTIONS /analyze convenience endpoint documenting the schema. */
export async function registerSchemaRoute(app: VisionServer, maxTimeoutMs: number): Promise<void> {
  app.get(`/${API_VERSION}/analyze/schema`, async () => ({
    schema_version: '1',
    method: 'POST',
    path: `/${API_VERSION}/analyze`,
    content_type: 'application/json',
    body: {
      image_url: { type: 'string', required: true, description: 'Publicly reachable https URL of a product image.' },
      options: {
        type: 'object',
        required: false,
        properties: {
          plan: { type: 'string', enum: ['fast', 'standard', 'deep'], default: 'standard' },
          ocr: { type: 'boolean', default: true },
          max_variants: { type: 'integer', min: 1, max: 40 },
          // The zod ceiling is 300000, but this deployment will clamp anything
          // above its own budget. Advertise the effective limit so a caller can
          // see it here instead of discovering it from `x-timeout-clamped-ms`.
          timeout_ms: { type: 'integer', min: 1000, max: Math.min(300000, maxTimeoutMs) },
          normalize_text: { type: 'boolean', default: true },
        },
      },
    },
  }));
}
