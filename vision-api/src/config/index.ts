/**
 * Central, typed runtime configuration.
 *
 * Every value is read from the environment; nothing sensitive is hardcoded and
 * no secret has a usable default. `loadConfig()` validates the environment once
 * at boot and fails fast with a readable message.
 */
import { z } from 'zod';

const BOOL_LITERALS = ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'] as const;

const bool = (def: boolean) =>
  z
    .enum(BOOL_LITERALS)
    .default((String(def === true ? 'true' : 'false') as (typeof BOOL_LITERALS)[number]))
    .transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on');

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── HTTP server ───────────────────────────────────────────────────────────
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8000, 1, 65535),
  /** Trust X-Forwarded-For (Render sets this). */
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(false),

  // ── Security ──────────────────────────────────────────────────────────────
  /** Comma separated list of accepted API keys. Empty disables authentication. */
  API_KEYS: csv,
  /** Allow plain http:// downloads. Keep false in production. */
  ALLOW_HTTP: bool(false),
  /** Extra hostnames that may be fetched even over http (e.g. internal storage). */
  HTTP_ALLOWED_HOSTS: csv,
  /** Explicitly allow fetching these hosts even if they resolve to private IPs. */
  PRIVATE_HOST_ALLOWLIST: csv,
  ALLOWED_IMAGE_HOSTS: csv,
  /** Permit non-standard ports in image_url. */
  ALLOWED_URL_PORTS: csv,
  CORS_ORIGINS: csv,
  RATE_LIMIT_MAX: int(60, 1, 100_000),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  BODY_LIMIT_BYTES: int(16_384, 256, 1_048_576),
  /** Hard wall-clock cap for a whole /analyze request; the client gets 504 past it. */
  REQUEST_TIMEOUT_MS: int(90_000, 1_000, 600_000),

  // ── Ingestion limits ──────────────────────────────────────────────────────
  DOWNLOAD_TIMEOUT_MS: int(12_000, 500, 120_000),
  DOWNLOAD_MAX_BYTES: int(8 * 1024 * 1024, 10_000, 64 * 1024 * 1024),
  MAX_REDIRECTS: int(3, 0, 10),
  MAX_IMAGE_DIMENSION: int(6000, 64, 20_000),
  MAX_IMAGE_PIXELS: int(40_000_000, 10_000, 500_000_000),

  // ── Pipeline ──────────────────────────────────────────────────────────────
  BARCODE_MAX_VARIANTS: int(6, 1, 40),
  BARCODE_MAX_MS: int(9000, 200, 120_000),
  BARCODE_MIN_CONFIDENCE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 0.5 : Number(v)))
    .pipe(z.number().min(0).max(1)),
  /**
   * How many /v1/analyze requests may run through decode + pipeline at once.
   * 1 keeps peak RSS flat on small instances (Render free tier, 512 MB); each
   * extra permit can add hundreds of MB of concurrent rasters. Queued requests
   * still consume their overall deadline while they wait.
   */
  MAX_CONCURRENT_ANALYSES: int(1, 1, 16),
  OCR_ENABLED: bool(true),
  OCR_MAX_VARIANTS: int(3, 0, 12),
  OCR_TIMEOUT_MS: int(45_000, 1_000, 300_000),
  OCR_LANG_PATH: z.string().default('assets/tessdata'),
  OCR_LANG: z.string().default('eng'),
  OCR_WORKER_LIMIT: int(1, 1, 8),
  OCR_CACHE: bool(false),
  /**
   * Longest edge handed to Tesseract, in pixels. The barcode working raster is
   * allowed to be larger because a barcode needs the pixels; text does not.
   *
   * Measured on the synthetic Indian label, Tesseract memory tracks pixel count
   * almost linearly and accuracy does not: 1400 px gave the highest mean
   * confidence (93) of everything tested, while 4400 px - which is what the
   * `gray_upscale2x` OCR variant produced from a 2200 px working raster - cost
   * 465 MB against 207 MB and scored *worse* (90). On a 512 MB instance that
   * single variant was the difference between fitting and being OOM-killed.
   */
  OCR_MAX_DIMENSION: int(1400, 400, 4000),
  /**
   * Smallest longest edge OCR will work at; smaller images are enlarged to it.
   * `0` disables enlarging entirely.
   *
   * Small panels read badly at native size (a 400x392 nutrition table yields
   * fragments), but Tesseract's cost is linear in pixels and on a throttled
   * 0.1-CPU instance 400x392 -> 1400 px turned a 10 s OCR pass into one that
   * blew the 25 s budget. Lower this on slow hardware: 1400 on a normal
   * server, ~600 on Render's free tier, 0 to disable.
   */
  OCR_MIN_DIMENSION: int(1400, 0, 4000),
  /**
   * Longest edge of the raster handed to the barcode engines and to the
   * preprocessing variants.
   *
   * This is the dominant multiplier on both memory and latency: every variant is
   * a full RGBA copy, so 2200px is 19.4 MB each versus 10.2 MB at 1600px, and
   * ZXing-C++ measured 858 ms at 2200px against 189 ms at 1600px. Lower it on a
   * small-RAM host; raise it only if you have measured that small barcodes need
   * the resolution, because the cost is quadratic.
   */
  WORKING_MAX_DIMENSION: int(2200, 320, 6000),

  // ── Cache ─────────────────────────────────────────────────────────────────
  CACHE_ENABLED: bool(true),
  CACHE_MAX_ENTRIES: int(128, 0, 10_000),
  CACHE_TTL_SECONDS: int(900, 1, 86_400),

  // ── Diagnostics ───────────────────────────────────────────────────────────
  EXPOSE_METRICS: bool(true),
  /** Include the OCR raw text in logs. */
  LOG_OCR_TEXT: bool(false),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  server: {
    host: string;
    port: number;
    trustProxy: boolean;
    logLevel: string;
    logPretty: boolean;
    bodyLimit: number;
    requestTimeoutMs: number;
  };
  security: {
    apiKeys: string[];
    authRequired: boolean;
    allowHttp: boolean;
    httpAllowedHosts: string[];
    privateHostAllowlist: string[];
    allowedImageHosts: string[];
    allowedPorts: number[];
    corsOrigins: string[];
    rateLimitMax: number;
    rateLimitWindow: string;
  };
  ingest: {
    downloadTimeoutMs: number;
    downloadMaxBytes: number;
    maxRedirects: number;
    maxImageDimension: number;
    maxImagePixels: number;
    /** Longest edge of the working raster; see `WORKING_MAX_DIMENSION`. */
    workingMaxDimension: number;
  };
  pipeline: {
    barcode: { maxVariants: number; maxMs: number; minConfidence: number };
    ocr: {
      enabled: boolean;
      maxVariants: number;
      timeoutMs: number;
      langPath: string;
      lang: string;
      workerLimit: number;
      cache: boolean;
      /** Longest edge fed to Tesseract; see `OCR_MAX_DIMENSION`. */
      maxDimension: number;
      /** Smallest edge fed to Tesseract; see `OCR_MIN_DIMENSION`. 0 = no enlarging. */
      minDimension: number;
    };
    /** Simultaneous analyses allowed through the decode+pipeline gate. */
    maxConcurrentAnalyses: number;
  };
  cache: { enabled: boolean; maxEntries: number; ttlSeconds: number };
  diagnostics: { exposeMetrics: boolean; logOcrText: boolean };
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  const allowedPorts = e.ALLOWED_URL_PORTS.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    server: {
      host: e.HOST,
      port: e.PORT,
      trustProxy: e.TRUST_PROXY,
      logLevel: e.LOG_LEVEL,
      logPretty: e.LOG_PRETTY,
      bodyLimit: e.BODY_LIMIT_BYTES,
      requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    },
    security: {
      apiKeys: e.API_KEYS,
      authRequired: e.API_KEYS.length > 0,
      allowHttp: e.ALLOW_HTTP,
      httpAllowedHosts: e.HTTP_ALLOWED_HOSTS.map((h) => h.toLowerCase()),
      privateHostAllowlist: e.PRIVATE_HOST_ALLOWLIST.map((h) => h.toLowerCase()),
      allowedImageHosts: e.ALLOWED_IMAGE_HOSTS.map((h) => h.toLowerCase()),
      allowedPorts,
      corsOrigins: e.CORS_ORIGINS,
      rateLimitMax: e.RATE_LIMIT_MAX,
      rateLimitWindow: e.RATE_LIMIT_WINDOW,
    },
    ingest: {
      downloadTimeoutMs: e.DOWNLOAD_TIMEOUT_MS,
      downloadMaxBytes: e.DOWNLOAD_MAX_BYTES,
      maxRedirects: e.MAX_REDIRECTS,
      maxImageDimension: e.MAX_IMAGE_DIMENSION,
      workingMaxDimension: e.WORKING_MAX_DIMENSION,
      maxImagePixels: e.MAX_IMAGE_PIXELS,
    },
    pipeline: {
      barcode: { maxVariants: e.BARCODE_MAX_VARIANTS, maxMs: e.BARCODE_MAX_MS, minConfidence: e.BARCODE_MIN_CONFIDENCE },
      ocr: {
        enabled: e.OCR_ENABLED,
        maxVariants: e.OCR_MAX_VARIANTS,
        timeoutMs: e.OCR_TIMEOUT_MS,
        langPath: e.OCR_LANG_PATH,
        lang: e.OCR_LANG,
        workerLimit: e.OCR_WORKER_LIMIT,
        cache: e.OCR_CACHE,
        maxDimension: e.OCR_MAX_DIMENSION,
        minDimension: e.OCR_MIN_DIMENSION,
      },
      maxConcurrentAnalyses: e.MAX_CONCURRENT_ANALYSES,
    },
    cache: { enabled: e.CACHE_ENABLED, maxEntries: e.CACHE_MAX_ENTRIES, ttlSeconds: e.CACHE_TTL_SECONDS },
    diagnostics: { exposeMetrics: e.EXPOSE_METRICS, logOcrText: e.LOG_OCR_TEXT },
  };
}