/**
 * Process entrypoint.
 *
 * Binds `0.0.0.0:$PORT` (Render injects PORT; locally it defaults to 8000) and
 * shuts down cleanly on SIGTERM/SIGINT so Render's rolling deploys do not cut a
 * request off mid-flight. Graceful shutdown waits for in-flight requests, then
 * terminates the OCR workers (Tesseract keeps native handles open, so they must
 * be closed explicitly or the process hangs).
 */
import { buildServer, SERVICE_VERSION } from './server.js';
import { loadConfig } from './config/index.js';
import { createLogger } from './core/logger.js';
import { globalMetrics } from './core/metrics.js';

/**
 * Render sends SIGTERM and then waits out its own grace period before SIGKILL.
 * Stay under that budget so in-flight work finishes rather than being severed.
 *
 * Clamped rather than trusted: this is read straight from the environment
 * instead of the validated schema because it governs the shutdown path itself,
 * and a bad value here must not be able to hang or instantly kill the process.
 */
const SHUTDOWN_GRACE_MS = Math.min(
  120_000,
  Math.max(0, Number(process.env.SHUTDOWN_GRACE_MS) || 10_000),
);

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);

  const app = await buildServer({ config });

  // Warm the barcode engines in the background so the port opens immediately:
  // Render's health check must succeed fast even on a cold WASM init.
  void app.visionService
    .warmUp()
    .then(() => log.info({ engines: app.visionService.engineStatusReport().filter((e) => e.status === 'available').map((e) => e.name) }, 'barcode engines warmed'))
    .catch((err) => log.error({ reason: String(err) }, 'engine warm-up failed; the service will still serve requests'));

  await app.listen({ port: config.server.port, host: config.server.host });
  log.info(
    {
      version: SERVICE_VERSION,
      port: config.server.port,
      host: config.server.host,
      env: config.env,
      auth_enabled: config.security.authRequired,
      ocr_enabled: config.pipeline.ocr.enabled,
      rate_limit_max: config.security.rateLimitMax,
      request_timeout_ms: config.server.requestTimeoutMs,
    },
    'foodguard-vision-api listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown requested');
    const force = setTimeout(() => {
      log.warn('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    try {
      await app.close();
      await app.visionService.close();
      log.info({ metrics: globalMetrics.snapshot() }, 'shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ reason: String(err) }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ reason: err.message, stack: err.stack }, 'uncaught exception; exiting');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  // Logger may not exist yet if config loading itself failed.
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`fatal: failed to start foodguard-vision-api: ${message}\n`);
  process.exit(1);
});