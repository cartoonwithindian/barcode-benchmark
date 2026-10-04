/**
 * Operational endpoints.
 *
 *  `GET /health`  — liveness/readiness. Deliberately does no image work and no
 *                   engine initialisation, so it stays fast enough for a Render
 *                   health check. Returns `503` when a required engine could not
 *                   be loaded at all.
 *  `GET /version`  — service identity, engine registry with honest statuses,
 *                   effective configuration summary (secrets never included).
 *  `GET /metrics`  — in-process counters/histograms (JSON).
 */
import type { VisionServer } from '../types/fastify.js';
import { derivedRates, globalMetrics } from '../core/metrics.js';
import type { AppConfig } from '../config/index.js';
import type { VisionService } from '../analyze/orchestrator.js';
import { API_VERSION, SCHEMA_VERSION } from '../analyze/schema.js';

const STARTED_AT = Date.now();

export interface OperationalDeps {
  config: AppConfig;
  service: VisionService;
  version: string;
  buildSha?: string;
}

export async function registerOperationalRoutes(app: VisionServer, deps: OperationalDeps): Promise<void> {
  const { config, service, version } = deps;

  app.get('/health', async (_request, reply) => {
    const engines = service.engineStatusReport();
    const usable = engines.filter((e) => e.status === 'available');
    const healthy = usable.length > 0;

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'foodguard-vision-api',
      version,
      schema_version: SCHEMA_VERSION,
      api_version: API_VERSION,
      uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
      auth_enabled: config.security.authRequired,
      engines: {
        total: engines.length,
        available: usable.length,
        names: usable.map((e) => e.name),
      },
      // Intentionally free of secrets and host-specific detail: this endpoint is
      // often reachable without authentication on Render.
    });
  });

  app.get('/version', async () => ({
    service: 'foodguard-vision-api',
    version,
    build_sha: deps.buildSha ?? process.env.RENDER_GIT_COMMIT ?? null,
    schema_version: SCHEMA_VERSION,
    api_version: API_VERSION,
    node: process.version,
    runtime: {
      environment: config.env,
      port: config.server.port,
      uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
    },
    engines: service.engineStatusReport(),
    effective_config: {
      // Values only — no keys, no hosts, no URLs with credentials.
      auth_enabled: config.security.authRequired,
      api_key_count: config.security.apiKeys.length,
      allow_http: config.security.allowHttp,
      allowed_image_hosts: config.security.allowedImageHosts.length,
      cors_origins: config.security.corsOrigins,
      rate_limit_max: config.security.rateLimitMax,
      rate_limit_window: config.security.rateLimitWindow,
      download_max_bytes: config.ingest.downloadMaxBytes,
      download_timeout_ms: config.ingest.downloadTimeoutMs,
      max_image_dimension: config.ingest.maxImageDimension,
      max_image_pixels: config.ingest.maxImagePixels,
      barcode_max_variants: config.pipeline.barcode.maxVariants,
      barcode_max_ms: config.pipeline.barcode.maxMs,
      barcode_min_confidence: config.pipeline.barcode.minConfidence,
      ocr_enabled: config.pipeline.ocr.enabled,
      ocr_max_variants: config.pipeline.ocr.maxVariants,
      ocr_lang: config.pipeline.ocr.lang,
      ocr_worker_limit: config.pipeline.ocr.workerLimit,
      cache_enabled: config.cache.enabled,
      cache_max_entries: config.cache.maxEntries,
      cache_ttl_seconds: config.cache.ttlSeconds,
    },
    cache: service.cacheStats,
    attestation: {
      fabricates_results: false,
      statement:
        'Detection failures are reported as detected:false / null. Barcode confidences are derived (no engine in this build exposes a per-result score).',
    },
  }));

  app.get('/metrics', async (_request, reply) => {
    if (!config.diagnostics.exposeMetrics) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Metrics are disabled.' } });
    }
    const snapshot = globalMetrics.snapshot();
    return reply.code(200).send({ ...snapshot, rates: derivedRates(snapshot), cache: service.cacheStats });
  });
}
