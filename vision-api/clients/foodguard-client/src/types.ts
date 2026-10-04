/**
 * Hand-written mirror of the FoodGuard Vision API contract.
 *
 * Nothing here is generated: every interface is transcribed from the service
 * source and the originating file is named in the comment above it. That is
 * deliberate — a generated client would hide the day the server and this
 * package drift apart, and drift is exactly what an integration client must not
 * have. If you change a field here, change it in the cited file too.
 *
 * Contract sources:
 *   src/analyze/schema.ts   — the response DTOs (the authority)
 *   src/routes/analyze.ts   — the request body
 *   src/routes/operational.ts — /health, /version, /metrics
 *   src/core/errors.ts      — the error code taxonomy
 */

/** Mirrors `SCHEMA_VERSION` in src/analyze/schema.ts:20. */
export const SCHEMA_VERSION = '1';
/** Mirrors `API_VERSION` in src/analyze/schema.ts:21. */
export const API_VERSION = 'v1';

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * `options` for `POST /v1/analyze`.
 * Mirrors `analyzeBodySchema.options` in src/routes/analyze.ts:25-34 (which is
 * `.strict()`), including the server-side bounds. `timeout_ms` is clamped down
 * to the server maximum by src/routes/analyze.ts:63-65.
 */
export interface AnalyzeOptions {
  /** Preprocessing/aggression plan for the barcode stage. Server default `standard`. */
  plan?: 'fast' | 'standard' | 'deep';
  /** Run the OCR stage. Server default `true`. */
  ocr?: boolean;
  /** Cap on preprocessing variants. Server bound: 1..40. */
  max_variants?: number;
  /** Server-side wall-clock budget for the pipeline, ms. Server bound: 1_000..300_000. */
  timeout_ms?: number;
  /** Run the OCR text-normalisation pass. Server default `true`. */
  normalize_text?: boolean;
  /** Run the barcode stage. Server default `true`; `false` means text extraction only. */
  detect_barcode?: boolean;
}

/**
 * Body of `POST /v1/analyze`. Mirrors `analyzeBodySchema` in
 * src/routes/analyze.ts:22-36.
 *
 * There is deliberately no `image_base64` field: the body schema is `.strict()`,
 * so any extra property is rejected with `VALIDATION_ERROR` (400). To analyse a
 * local file, host it and pass its URL.
 */
export interface AnalyzeRequest {
  /** Publicly reachable image URL. Server bound: 8..2048 characters. */
  image_url: string;
  options?: AnalyzeOptions;
}

/** Mirrors `EngineLifecycleStatus` in src/barcode/types.ts:58-63. */
export type EngineLifecycleStatus =
  | 'available'
  | 'initializing'
  | 'running'
  | 'failed'
  | 'license_required';

/** Mirrors `EngineStatusReport` in src/barcode/registry.ts:24-32. */
export interface EngineStatusReport {
  name: string;
  status: EngineLifecycleStatus;
  reason: string | null;
  formats: string[];
  initialised: boolean;
  last_error: string | null;
}

/** Mirrors `CacheStats` in src/analyze/cache.ts:14-19. */
export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  evictions: number;
}

// ── Error taxonomy ──────────────────────────────────────────────────────────

/**
 * Every `ErrorCode` from src/core/errors.ts:9-26. Kept as a frozen object so
 * callers can `switch` on it, and as a union so a new server code is a compile
 * error here rather than a silent `undefined`.
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

/**
 * The failure envelope. Mirrors the two error shapes in src/server.ts:
 *   - `setErrorHandler` (src/server.ts:165-171): success/request_id/error/meta
 *   - the rate limiter (src/server.ts:88-97): the same minus `request_id`/`meta`
 *
 * `error.details` does **not** exist: `AppError.details` is operator-only and
 * `toPublicJSON()` never emits it (src/core/errors.ts:81-93).
 */
export interface VisionApiErrorEnvelope {
  success: false;
  request_id?: string;
  error: {
    code: ErrorCodeValue;
    message: string;
    /** Seconds to wait before retrying; also sent as the `retry-after` header. */
    retry_after_seconds?: number;
    /** Caller-safe pointers into the caller's own request, e.g. `image_url: Required`. */
    fields?: string[];
  };
  /** Which pipeline stage failed. Present on `setErrorHandler` responses only. */
  meta?: { failure_stage: string };
}

// ── Operational responses ───────────────────────────────────────────────────

/** Body of `GET /health`. Mirrors src/routes/operational.ts:30-51. 503 when degraded. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  schema_version: string;
  api_version: string;
  uptime_seconds: number;
  auth_enabled: boolean;
  engines: { total: number; available: number; names: string[] };
}

/** Body of `GET /version`. Mirrors src/routes/operational.ts:53-96. */
export interface VersionResponse {
  service: string;
  version: string;
  build_sha: string | null;
  schema_version: string;
  api_version: string;
  node: string;
  runtime: { environment: string; port: number; uptime_seconds: number };
  engines: EngineStatusReport[];
  effective_config: {
    auth_enabled: boolean;
    api_key_count: number;
    allow_http: boolean;
    allowed_image_hosts: number;
    cors_origins: string[];
    rate_limit_max: number;
    rate_limit_window: string;
    download_max_bytes: number;
    download_timeout_ms: number;
    max_image_dimension: number;
    max_image_pixels: number;
    barcode_max_variants: number;
    barcode_max_ms: number;
    barcode_min_confidence: number;
    ocr_enabled: boolean;
    ocr_max_variants: number;
    ocr_lang: string;
    ocr_worker_limit: number;
    cache_enabled: boolean;
    cache_max_entries: number;
    cache_ttl_seconds: number;
  };
  cache: CacheStats;
  attestation: { fabricates_results: boolean; statement: string };
}

/** Body of `GET /metrics`. Mirrors `MetricsSnapshot` in src/core/metrics.ts:12-18. */
export interface MetricsResponse {
  uptime_seconds: number;
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; sum: number; min: number; max: number; avg: number; p50: number; p95: number }
  >;
  engine: Record<
    string,
    { attempts: number; detections: number; total_ms: number; detections_per_attempt: number; avg_ms: number }
  >;
  preprocess_variants: Record<string, number>;
  rates: Record<string, number>;
  cache: CacheStats;
}

// ── Analysis response ───────────────────────────────────────────────────────

/** Mirrors `ImageInfo` in src/analyze/schema.ts:23-36. */
export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  source_width: number;
  source_height: number;
  orientation_applied: boolean;
  downscaled: boolean;
  megapixels: number;
  /** Redacted source (host + path, no query string, no credentials). */
  source: string;
}

/** Mirrors `BarcodeResultDto` in src/analyze/schema.ts:38-61. */
export interface BarcodeResultDto {
  value: string;
  format: string;
  /** Derived or engine confidence, 0..1. `null` when unknown. */
  confidence: number | null;
  confidence_source: BarcodeConfidenceSource;
  confidence_breakdown: BarcodeConfidenceBreakdown;
  engines: string[];
  agreement: number;
  observations: number;
  variants: string[];
  engine_confidence: Array<{ engine: string; confidence: number | null }>;
  is_retail_gtin: boolean;
  is_indian_gs1: boolean;
  is_url_payload: boolean;
  bounding_box?: { x: number; y: number; width: number; height: number };
  fastest_ms: number;
  formats_reported: string[];
}

/** Mirrors `ConfidenceSource` in src/barcode/fusion.ts:30. */
export type BarcodeConfidenceSource = 'engine' | 'derived' | 'unknown';

/** Mirrors `ConfidenceBreakdown` in src/barcode/fusion.ts:32-43. */
export interface BarcodeConfidenceBreakdown {
  agreement: number;
  consistency: number;
  structural: number;
  format_prior: number;
  engine: number;
}

/** Mirrors `BarcodeDto` in src/analyze/schema.ts:63-75. */
export interface BarcodeDto {
  detected: boolean;
  primary: {
    value: string;
    format: string;
    confidence: number | null;
    confidence_source: BarcodeConfidenceSource;
  } | null;
  results: BarcodeResultDto[];
  engines_attempted: string[];
  engines_unavailable: Array<{ engine: string; reason: string }>;
  preprocessing_variants_used: string[];
  stop_reason: string;
  ms: number;
}

/** Mirrors `TextCorrection` in src/text/normalize.ts:19-29. */
export interface TextCorrection {
  kind: 'ocr_confusion' | 'ins_code' | 'whitespace' | 'punctuation' | 'unicode';
  raw: string;
  corrected: string;
  confidence: number;
  start: number;
  end: number;
  reason: string;
}

/** Mirrors `OcrRegionDto` in src/analyze/schema.ts:77-81. */
export interface OcrRegionDto {
  kind: string;
  text: string | null;
  bbox?: { x: number; y: number; width: number; height: number };
}

/** Mirrors `OcrDto` in src/analyze/schema.ts:83-102. */
export interface OcrDto {
  detected: boolean;
  /** Mean word confidence 0..100 as reported by Tesseract. */
  confidence: number | null;
  confidence_source: 'engine' | 'unknown';
  engine: string;
  raw_text: string;
  normalized_text: string;
  corrections: TextCorrection[];
  normalization_confidence: number;
  regions: OcrRegionDto[];
  variants_attempted: Array<{
    variant: string;
    preprocess: string;
    psm: number;
    confidence: number;
    chars: number;
    ms: number;
    selected: boolean;
  }>;
  best_variant: string | null;
  ms: number;
  failure_reason: string | null;
}

/** Mirrors `IngredientItem` in src/text/ingredients.ts:24-41 (recurses). */
export interface IngredientItem {
  raw: string;
  normalized: string;
  /** Canonical additive code when the item carries one, e.g. `INS 621`. */
  code: string | null;
  ins_reference_name: string | null;
  additive_class: string | null;
  allergens: string[];
  cross_contamination: string | null;
  sub_ingredients: IngredientItem[];
}

/** Mirrors `IngredientsDto` in src/analyze/schema.ts:104-114. */
export interface IngredientsDto {
  detected: boolean;
  confidence: number | null;
  confidence_source: 'derived' | 'unknown';
  confidence_breakdown: Record<string, number>;
  raw_section: string;
  items: IngredientItem[];
  heading: string | null;
}

/** Mirrors `NutritionValue` in src/text/nutrition.ts:17-33. */
export interface NutritionValue {
  nutrient: string;
  label: string;
  raw: string;
  value: number | null;
  unit: string;
  normalized_value: number | null;
  normalized_unit: string;
  daily_value_percent: number | null;
  trace: boolean;
}

/** Mirrors `NutritionDto` in src/analyze/schema.ts:116-127. */
export interface NutritionDto {
  detected: boolean;
  raw_section: string;
  basis: string | null;
  serving_size: string | null;
  values: NutritionValue[];
  undeciphered_lines: string[];
  confidence: number | null;
  confidence_source: 'derived' | 'unknown';
  confidence_breakdown: Record<string, number>;
}

/** Mirrors `AllergensDto` in src/analyze/schema.ts:129-138. */
export interface AllergensDto {
  from_ingredients: string[];
  declared: string[];
  cross_contamination: string[];
  declared_in_section: boolean;
}

/** Mirrors `SignalsDto` in src/analyze/schema.ts:140-151. */
export interface SignalsDto {
  ingredient_list_found: boolean;
  barcode_found: boolean;
  nutrition_panel_found: boolean;
  image_quality: 'good' | 'fair' | 'poor';
  image_quality_score: number;
  /** Additive codes found anywhere in the OCR text, canonicalised to `INS <n>`. */
  ins_codes: string[];
  /**
   * Names of the Indian label categories that were found — a coarse list, not a
   * set of values. Built from truthy `product.*.value` checks
   * (src/analyze/orchestrator.ts:310-316), so a name here does imply a value
   * exists; `claims` is the one entry with no matching `product` field, because
   * it names a section rather than an extracted field. Read `product.*` for the
   * values themselves.
   */
  indian_label_signals: string[];
}

/** Mirrors `DiagnosticsDto` in src/analyze/schema.ts:153-163. */
export interface DiagnosticsDto {
  processing_time_ms: number;
  barcode_engines_attempted: string[];
  preprocessing_variants_used: string[];
  timings_ms: Record<string, number>;
  plan: string;
  cache_hit: boolean;
  quality: { brightness: number; sharpness: number; overexposure: number; reasons: string[] };
  engines: Array<{
    engine: string;
    status: string;
    variants_tried: number;
    detections: number;
    total_ms: number;
    error: string | null;
  }>;
  ocr_attempts: Array<{
    variant: string;
    preprocess: string;
    psm: number;
    confidence: number;
    chars: number;
    ms: number;
    selected: boolean;
  }>;
}

/** Mirrors `ExtractedField<T>` in src/text/product.ts:18-24. */
export interface ExtractedField<T> {
  value: T | null;
  /** Derived, 0..1. `null` means "nothing plausible was found". */
  confidence: number | null;
  confidence_source: 'derived' | 'unknown';
  /** Exact OCR text the value was read from. */
  evidence: string | null;
}

/**
 * `AnalysisResponse['product']`, mirroring src/analyze/schema.ts:174-185.
 *
 * `veg_marker.value` is typed `string` because the DTO widens the service's
 * `VegMarker['type']` union (src/text/sections.ts:323) to a plain string. Use
 * `isVegMarkerType()` from ./helpers.js to narrow it back down.
 */
export interface ProductFieldsDto {
  name: ExtractedField<string>;
  brand: ExtractedField<string>;
  variant_or_flavour: ExtractedField<string>;
  net_quantity: ExtractedField<string>;
  mrp: ExtractedField<{ amount: number; currency: string }>;
  fssai_license: ExtractedField<string>;
  veg_marker: ExtractedField<string>;
  manufacturer: ExtractedField<string>;
  best_before: ExtractedField<string>;
  country_of_origin: ExtractedField<string>;
}

/** Mirrors `AnalysisResponse` in src/analyze/schema.ts:165-193. */
export interface AnalysisResponse {
  success: boolean;
  request_id: string;
  schema_version: string;
  /** Declared in the DTO but never populated by the current orchestrator. */
  analysis_id?: string;
  image: ImageInfo;
  barcode: BarcodeDto;
  ocr: OcrDto;
  product: ProductFieldsDto;
  ingredients: IngredientsDto;
  nutrition: NutritionDto;
  allergens: AllergensDto;
  signals: SignalsDto;
  diagnostics: DiagnosticsDto;
  warnings: string[];
}