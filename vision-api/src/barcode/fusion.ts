/**
 * Barcode result fusion.
 *
 * Engines disagree: one finds a value another misses, formats differ, the same
 * payload shows up on several variants. This module collapses the raw attempts
 * into ranked, deduplicated candidates and produces a *derived* confidence that
 * is fully explainable.
 *
 * Confidence policy (deliberately conservative, no invented engine scores):
 *  - `engine_confidence` is copied from the engine and stays `null` for every
 *    engine currently wired up, because none of them expose a per-result score.
 *  - `confidence` is `derived`: it is computed here from four observable facts
 *    and is always accompanied by `confidence_source: "derived"` plus the
 *    breakdown, so a caller can see exactly where the number came from.
 *  - when a fused entry has no supporting evidence at all (should not happen),
 *    `confidence_source` is `"unknown"` and the value is reported as `null`
 *    rather than a fabricated number.
 *
 * Why `consistency` exists: measured on the upstream photo set, a misread first
 * digit can still pass the GTIN check digit by chance, so the checksum alone
 * cannot separate a true reading from a corrupt one. What *does* separate them
 * is how many independent (engine, variant) attempts reproduce the same payload:
 * on `real-amul-pouch.jpeg` the true GTIN was read 10 times across variants
 * while the checksum-valid misread appeared once. Repeatability is therefore a
 * first-class term, not a footnote.
 */
import { isIndianGs1, isProbablyUrl, reconcileFormats, validatePayload } from './formats.js';
import { RETAIL_FORMATS, TWO_D_FORMATS, type BarcodeFormatName, type BarcodeResult } from './types.js';

export type ConfidenceSource = 'engine' | 'derived' | 'unknown';

export interface ConfidenceBreakdown {
  /** 0..1 — did independent engines agree on this exact payload? */
  agreement: number;
  /** 0..1 — how many independent (engine, variant) attempts reproduced it? */
  consistency: number;
  /** 0..1 — is the payload structurally valid for its format (GTIN check digit etc.)? */
  structural: number;
  /** 0..1 — how relevant the format is for retail packaged food. */
  format_prior: number;
  /** 0..1 — engine-reported score, when one exists. Always 0 for current engines. */
  engine: number;
}

export interface FusedBarcode {
  value: string;
  format: BarcodeFormatName;
  confidence: number | null;
  confidence_source: ConfidenceSource;
  confidence_breakdown: ConfidenceBreakdown;
  engines: string[];
  /** Number of distinct engines that produced this payload. */
  agreement: number;
  /** Number of (engine, variant) attempts that produced this payload. */
  observations: number;
  variants: string[];
  engine_confidence: Array<{ engine: string; confidence: number | null }>;
  bounding_box?: { x: number; y: number; width: number; height: number };
  points?: Array<{ x: number; y: number }>;
  is_retail_gtin: boolean;
  /** The payload carries the Indian GS1 (890) prefix. A hint, not a filter. */
  is_indian_gs1: boolean;
  is_url_payload: boolean;
  /** Fastest decode observed for this payload, in ms. */
  fastest_ms: number;
  formats_reported: BarcodeFormatName[];
}

const FORMAT_PRIOR: Record<BarcodeFormatName, number> = {
  'EAN-13': 1.0,
  'EAN-8': 0.9,
  'UPC-A': 0.85,
  'UPC-E': 0.7,
  'Code 128': 0.8,
  'Code 39': 0.55,
  'Code 93': 0.45,
  ITF: 0.35,
  Codabar: 0.25,
  'QR Code': 0.5,
  'Data Matrix': 0.35,
  PDF417: 0.35,
  Aztec: 0.3,
  UNKNOWN: 0.1,
};

function agreementScore(distinctEngines: number): number {
  // 1 engine => 0.45, 2 => 0.8, 3+ => 1.0. Never 0 for a real detection.
  if (distinctEngines >= 3) return 1;
  if (distinctEngines === 2) return 0.8;
  return 0.45;
}

/**
 * Repeatability across independent attempts. Log-shaped: the jump from one
 * observation to two is the meaningful one, and saturation around 8 keeps a
 * long variant sweep from dominating the score.
 */
function consistencyScore(observations: number): number {
  if (observations <= 1) return 0;
  if (observations >= 8) return 1;
  return Number((Math.log2(observations) / 3).toFixed(3));
}

function structuralScore(value: string, format: BarcodeFormatName): number {
  const validation = validatePayload(value, format);
  // A GTIN whose check digit fails is almost certainly a misread, so it is
  // scored near zero rather than merely discounted.
  if (validation.kind === 'gtin') return validation.valid ? 1 : 0.05;
  return validation.valid ? 0.8 : 0.2;
}

/** Weights sum to 1; each term is documented on `ConfidenceBreakdown`. */
const CONFIDENCE_WEIGHTS = {
  agreement: 0.35,
  consistency: 0.25,
  structural: 0.25,
  format_prior: 0.12,
  engine: 0.03,
} as const;

function deriveConfidence(breakdown: ConfidenceBreakdown): number {
  const score =
    breakdown.agreement * CONFIDENCE_WEIGHTS.agreement +
    breakdown.consistency * CONFIDENCE_WEIGHTS.consistency +
    breakdown.structural * CONFIDENCE_WEIGHTS.structural +
    breakdown.format_prior * CONFIDENCE_WEIGHTS.format_prior +
    breakdown.engine * CONFIDENCE_WEIGHTS.engine;
  return Number(Math.max(0, Math.min(1, score)).toFixed(3));
}

/**
 * Rank: retail GTINs first, then by confidence, then by raw observation count
 * (a stable tie-break for payloads that score identically).
 */
function rankOf(entry: FusedBarcode): number {
  const retail = RETAIL_FORMATS.has(entry.format) ? 1 : 0;
  const urlPenalty = entry.is_url_payload ? 0.4 : 0;
  const observationBoost = Math.min(entry.observations, 12) / 100;
  return retail * 10 + (entry.confidence ?? 0) + observationBoost - urlPenalty;
}

export interface FusionOptions {
  /** Results below this confidence are dropped when other candidates exist. */
  minConfidence: number;
  /** Cap on returned candidates. */
  maxResults: number;
}

export function fuseBarcodeResults(results: BarcodeResult[], options: FusionOptions): FusedBarcode[] {
  const groups = new Map<string, BarcodeResult[]>();
  for (const result of results) {
    const value = result.value.trim();
    if (!value) continue;
    // Key on the payload only: format disagreements are resolved later.
    const key = `${result.format === 'QR Code' || result.format === 'Data Matrix' || result.format === 'Aztec' ? '2D' : '1D'}:${value}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(result);
    else groups.set(key, [result]);
  }

  const fused: FusedBarcode[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0]!;
    const format = reconcileFormats(bucket.map((r) => ({ value: r.value, format: r.format })));
    const engines = [...new Set(bucket.map((r) => r.engine))].sort();
    const variants = [...new Set(bucket.map((r) => r.variant).filter((v) => v.length > 0))].sort();
    const engineScores = bucket.filter((r) => r.engineConfidence !== null).map((r) => ({ engine: r.engine, confidence: r.engineConfidence as number }));
    const engineConfidence = engineScores.length > 0 ? Math.max(...engineScores.map((s) => s.confidence)) : null;

    const breakdown: ConfidenceBreakdown = {
      agreement: agreementScore(engines.length),
      consistency: consistencyScore(bucket.length),
      structural: structuralScore(first.value, format),
      format_prior: FORMAT_PRIOR[format] ?? 0.1,
      engine: engineConfidence ?? 0,
    };

    const hasEvidence = bucket.length > 0;
    const confidence = hasEvidence ? deriveConfidence(breakdown) : null;
    const confidenceSource: ConfidenceSource = engineConfidence !== null ? 'engine' : hasEvidence ? 'derived' : 'unknown';

    const withBox = bucket.find((r) => r.boundingBox)?.boundingBox;
    const withPoints = bucket.find((r) => r.points && r.points.length > 0)?.points;

    fused.push({
      value: first.value,
      format,
      confidence,
      confidence_source: confidenceSource,
      confidence_breakdown: breakdown,
      engines,
      agreement: engines.length,
      observations: bucket.length,
      variants,
      engine_confidence: engineScores,
      bounding_box: withBox,
      points: withPoints,
      is_retail_gtin: RETAIL_FORMATS.has(format),
      is_indian_gs1: isIndianGs1(first.value),
      is_url_payload: isProbablyUrl(first.value, format),
      fastest_ms: Math.min(...bucket.map((r) => r.decodeTimeMs)),
      formats_reported: [...new Set(bucket.map((r) => r.format))],
    });
  }

  fused.sort((a, b) => rankOf(b) - rankOf(a));

  const strongest = fused[0];
  // Keep everything that is competitive with the leader; a single weak extra
  // candidate (usually a misread 2D code) is dropped rather than returned.
  if (strongest && strongest.confidence !== null) {
    const cutoff = strongest.confidence * 0.6;
    const kept = fused.filter((f) => (f.confidence ?? 0) >= cutoff);
    return kept.slice(0, options.maxResults);
  }
  return fused.filter((f) => f.confidence !== null && f.confidence >= options.minConfidence).slice(0, options.maxResults);
}

/**
 * The single value FoodGuard should look up. Prefers a retail GTIN; a QR URL is
 * only returned when nothing better exists (a QR code is not automatically a
 * product barcode).
 */
export function selectPrimaryBarcode(fused: FusedBarcode[]): FusedBarcode | null {
  if (fused.length === 0) return null;
  const gtin = fused.find((f) => f.is_retail_gtin && !f.is_url_payload);
  if (gtin) return gtin;
  const code128 = fused.find((f) => f.format === 'Code 128');
  if (code128) return code128;
  // Any remaining 1D format (EAN-13 that failed its checksum, ITF, Code 39, ...)
  // still beats a 2D symbol: FoodGuard looks products up by GTIN, and a linear
  // retail code is far more likely to be one even when imperfectly formed.
  const linear = fused.find((f) => !TWO_D_FORMATS.has(f.format));
  if (linear) return linear;
  return fused[0]!;
}