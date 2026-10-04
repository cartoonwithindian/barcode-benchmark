/**
 * Public response contract for `POST /v1/analyze`.
 *
 * This file is the single source of truth for the JSON shape. Every field is
 * either:
 *  - an observation of what the pipeline actually decoded/OCR'd, or
 *  - a *derived* score, always accompanied by `confidence_source`, or
 *  - `null` / `false` when nothing was found.
 *
 * Fields are never filled with plausible-looking defaults. Adding a field is a
 * minor version bump; renaming or removing one is a breaking change, which is
 * why `SCHEMA_VERSION` is part of every response.
 */
import type { FusedBarcode } from '../barcode/fusion.js';
import type { TextCorrection } from '../text/normalize.js';
import type { IngredientItem } from '../text/ingredients.js';
import type { NutritionValue } from '../text/nutrition.js';
import type { ExtractedField } from '../text/product.js';

export const SCHEMA_VERSION = '1';
export const API_VERSION = 'v1';

export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  /** Dimensions as stored in the file (before EXIF orientation). */
  source_width: number;
  source_height: number;
  orientation_applied: boolean;
  /** True when the source was downscaled to the engine working resolution. */
  downscaled: boolean;
  megapixels: number;
  /** Redacted source (host + path, no query string, no credentials). */
  source: string;
}

export interface BarcodeResultDto {
  value: string;
  format: string;
  /** Derived or engine confidence, 0..1. `null` when unknown. */
  confidence: number | null;
  confidence_source: 'engine' | 'derived' | 'unknown';
  confidence_breakdown: Record<string, number>;
  /** Engines that produced this exact payload. */
  engines: string[];
  /** Number of independent engines that agreed. */
  agreement: number;
  /** (engine, variant) observations behind this value. */
  observations: number;
  variants: string[];
  /** Per-engine scores, empty for engines that expose none. */
  engine_confidence: Array<{ engine: string; confidence: number | null }>;
  is_retail_gtin: boolean;
  /** The payload carries the Indian GS1 (890) prefix. A hint, not a filter. */
  is_indian_gs1: boolean;
  is_url_payload: boolean;
  bounding_box?: { x: number; y: number; width: number; height: number };
  fastest_ms: number;
  formats_reported: string[];
}

export interface BarcodeDto {
  detected: boolean;
  /** Best candidate for a product lookup; a retail GTIN when one was found. */
  primary: { value: string; format: string; confidence: number | null; confidence_source: 'engine' | 'derived' | 'unknown' } | null;
  results: BarcodeResultDto[];
  engines_attempted: string[];
  /** Engines that reported themselves unavailable, with the reason. */
  engines_unavailable: Array<{ engine: string; reason: string }>;
  preprocessing_variants_used: string[];
  /** Why the barcode stage stopped: `confidence_target_reached`, etc. */
  stop_reason: string;
  ms: number;
}

export interface OcrRegionDto {
  kind: string;
  text: string | null;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface OcrDto {
  detected: boolean;
  /** Mean word confidence 0..100 as reported by Tesseract. */
  confidence: number | null;
  confidence_source: 'engine' | 'unknown';
  engine: string;
  /** Untouched OCR output. */
  raw_text: string;
  /** Corrected text; every change is listed in `corrections`. */
  normalized_text: string;
  corrections: TextCorrection[];
  /** Confidence of the correction pass, 1 when nothing changed. */
  normalization_confidence: number;
  regions: OcrRegionDto[];
  variants_attempted: Array<{ variant: string; preprocess: string; psm: number; confidence: number; chars: number; ms: number; selected: boolean }>;
  /** Best image variant for OCR, useful when tuning the preprocessing stack. */
  best_variant: string | null;
  ms: number;
  failure_reason: string | null;
}

export interface IngredientsDto {
  detected: boolean;
  confidence: number | null;
  confidence_source: 'derived' | 'unknown';
  confidence_breakdown: Record<string, number>;
  /** The section exactly as OCR produced it. */
  raw_section: string;
  items: IngredientItem[];
  /** Heading that opened the section. */
  heading: string | null;
}

export interface NutritionDto {
  detected: boolean;
  raw_section: string;
  /** e.g. `per 100 ml`. */
  basis: string | null;
  serving_size: string | null;
  values: NutritionValue[];
  undeciphered_lines: string[];
  confidence: number | null;
  confidence_source: 'derived' | 'unknown';
  confidence_breakdown: Record<string, number>;
}

export interface AllergensDto {
  /** Allergens found by the ingredient-section match. */
  from_ingredients: string[];
  /** Allergens named in an explicit allergen/`contains` declaration. */
  declared: string[];
  /** `may contain: ...` statements. */
  cross_contamination: string[];
  /** True when a dedicated allergen heading was present. */
  declared_in_section: boolean;
}

export interface SignalsDto {
  ingredient_list_found: boolean;
  barcode_found: boolean;
  nutrition_panel_found: boolean;
  image_quality: 'good' | 'fair' | 'poor';
  /** 0..1 heuristic quality score with the components it was built from. */
  image_quality_score: number;
  /** Additive codes (INS) found in the ingredient section. */
  ins_codes: string[];
  /** Indian regulatory text found (FSSAI licence, veg mark, MRP, net qty). */
  indian_label_signals: string[];
}

export interface DiagnosticsDto {
  processing_time_ms: number;
  barcode_engines_attempted: string[];
  preprocessing_variants_used: string[];
  timings_ms: Record<string, number>;
  plan: string;
  cache_hit: boolean;
  quality: { brightness: number; sharpness: number; overexposure: number; reasons: string[] };
  engines: Array<{ engine: string; status: string; variants_tried: number; detections: number; total_ms: number; error: string | null }>;
  ocr_attempts: Array<{ variant: string; preprocess: string; psm: number; confidence: number; chars: number; ms: number; selected: boolean }>;
}

export interface AnalysisResponse {
  success: boolean;
  request_id: string;
  schema_version: string;
  /** URL path prefix of this API major version (e.g. `v1`). */
  api_version: string;
  image: ImageInfo;
  barcode: BarcodeDto;
  ocr: OcrDto;
  product: {
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
  };
  ingredients: IngredientsDto;
  nutrition: NutritionDto;
  allergens: AllergensDto;
  signals: SignalsDto;
  diagnostics: DiagnosticsDto;
  /** Non-fatal problems worth surfacing to the caller/operator. */
  warnings: string[];
}

export function barcodeResultDto(fused: FusedBarcode): BarcodeResultDto {
  return {
    value: fused.value,
    format: fused.format,
    confidence: fused.confidence,
    confidence_source: fused.confidence_source,
    confidence_breakdown: {
      agreement: fused.confidence_breakdown.agreement,
      consistency: fused.confidence_breakdown.consistency,
      structural: fused.confidence_breakdown.structural,
      format_prior: fused.confidence_breakdown.format_prior,
      engine: fused.confidence_breakdown.engine,
    },
    engines: fused.engines,
    agreement: fused.agreement,
    observations: fused.observations,
    variants: fused.variants,
    engine_confidence: fused.engines.map((engine) => ({
      engine,
      confidence: fused.engine_confidence.find((e) => e.engine === engine)?.confidence ?? null,
    })),
    is_retail_gtin: fused.is_retail_gtin,
    is_indian_gs1: fused.is_indian_gs1,
    is_url_payload: fused.is_url_payload,
    ...(fused.bounding_box ? { bounding_box: fused.bounding_box } : {}),
    fastest_ms: fused.fastest_ms,
    formats_reported: fused.formats_reported,
  };
}
