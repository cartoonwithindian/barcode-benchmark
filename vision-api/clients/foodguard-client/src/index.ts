/**
 * Public entry point for the FoodGuard reference client.
 *
 * Zero runtime dependencies: everything here is `fetch` plus hand-written types
 * mirroring `src/analyze/schema.ts`.
 *
 * What this package is: a typed way to ask a Vision API what is printed on a
 * photo of an Indian food pack.
 * What it is not: a product database. There is no verdict, no ingredient risk
 * score and no "is this safe" anywhere in this API — see ./README.md.
 */
export {
  VisionApiClient,
  type VisionApiClientOptions,
  type AnalyzeCallOptions,
  type CallOptions,
  type CallResult,
} from './client.js';

export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  normaliseRetry,
  resolveAuthHeader,
  VisionApiTransport,
  type AuthHeaderStyle,
  type ClientLogger,
  type FetchLike,
  type RetryOptions,
  type TransportOptions,
  type TransportRequest,
  type TransportResult,
} from './http.js';

export {
  EVERY_ERROR_CODE_IS_CLASSIFIED,
  FoodGuardClientError,
  isKnownErrorCode,
  isRetryableError,
  isRetryableStatus,
  NON_RETRYABLE_ERROR_CODES,
  parseErrorEnvelope,
  RETRYABLE_ERROR_CODES,
  STATUS_BY_CODE,
  VisionApiError,
  VisionApiTimeoutError,
  VisionApiTransportError,
  type VisionApiErrorInit,
} from './errors.js';

export {
  DEFAULT_MIN_BARCODE_CONFIDENCE,
  describeDetection,
  extractSignals,
  isVegMarkerType,
  summarizeForLookup,
  type AllergenSignals,
  type BarcodeSelection,
  type DescribeDetectionOptions,
  type DetectionDescription,
  type DetectionState,
  type FieldSignal,
  type LookupIdentifier,
  type RetailSignals,
  type VegMarkerType,
} from './helpers.js';

export {
  API_VERSION,
  ErrorCode,
  SCHEMA_VERSION,
  type AllergensDto,
  type AnalysisResponse,
  type AnalyzeOptions,
  type AnalyzeRequest,
  type BarcodeConfidenceBreakdown,
  type BarcodeConfidenceSource,
  type BarcodeDto,
  type BarcodeResultDto,
  type CacheStats,
  type DiagnosticsDto,
  type EngineLifecycleStatus,
  type EngineStatusReport,
  type ErrorCodeValue,
  type ExtractedField,
  type HealthResponse,
  type ImageInfo,
  type IngredientItem,
  type IngredientsDto,
  type MetricsResponse,
  type NutritionDto,
  type NutritionValue,
  type OcrDto,
  type OcrRegionDto,
  type ProductFieldsDto,
  type SignalsDto,
  type TextCorrection,
  type VersionResponse,
  type VisionApiErrorEnvelope,
} from './types.js';