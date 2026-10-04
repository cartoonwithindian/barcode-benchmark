/**
 * Typed helpers over an `AnalysisResponse`.
 *
 * Rules this module follows, in order of importance:
 *
 *  1. Never invent a value. An empty array means "the label did not show it";
 *     `null` means "we cannot say". There is no fallback, no guess, no
 *     normalisation that invents a number.
 *  2. Never launder `confidence_source: 'unknown'` into a detection. The
 *     service is explicit that an unknown score is not a low score, it is *no*
 *     score (src/barcode/fusion.ts:15-17).
 *  3. Mirror the service's own selection rule instead of re-deciding it. If
 *     FoodGuard and the service disagree about which barcode to look up, the bug
 *     belongs in one place.
 */
import type {
  AnalysisResponse,
  BarcodeConfidenceBreakdown,
  BarcodeConfidenceSource,
  ExtractedField,
  IngredientItem,
} from './types.js';

/**
 * Formats the fusion treats as 2D. Mirrors `TWO_D_FORMATS` in
 * src/barcode/types.ts:82-87. A 2D symbol is not automatically a product code:
 * a QR on an Indian pack usually carries a URL, not a GTIN.
 */
const TWO_D_FORMATS: ReadonlySet<string> = new Set(['QR Code', 'Data Matrix', 'Aztec', 'PDF417']);

/**
 * The minimum confidence for "detected". Mirrors the service's default
 * `BARCODE_MIN_CONFIDENCE` of 0.5 (src/config/index.ts:78), so the client does
 * not hold a higher bar than the server that produced the number.
 */
export const DEFAULT_MIN_BARCODE_CONFIDENCE = 0.5;

/** Which branch of `selectPrimaryBarcode` chose the value. */
export type BarcodeSelection =
  /** A retail GTIN (EAN-13/EAN-8/UPC-A/UPC-E) that is not a URL payload. Best case. */
  | 'retail_gtin'
  /** No GTIN; the service's second preference. */
  | 'code_128'
  /** No GTIN and no Code 128; some other 1D code (Code 39, ITF, Codabar…). */
  | 'other_1d'
  /** Nothing above qualified; the highest-ranked candidate wins. */
  | 'fallback_first';

export interface LookupIdentifier {
  /** The value to send to a product database. Use as-is; do not re-parse. */
  value: string;
  format: string;
  /** 0..1 or `null`. `derived` unless a future engine reports its own score. */
  confidence: number | null;
  /** Where `confidence` came from. Read this before quoting the number. */
  confidenceSource: BarcodeConfidenceSource;
  /** Which rule picked this candidate, so a UI can explain the choice. */
  selection: BarcodeSelection;
  isRetailGtin: boolean;
  isIndianGs1: boolean;
  /** True when the payload is a URL rather than a code — a different lookup kind. */
  isUrlPayload: boolean;
  /** `gtin` for a retail code, `url` for a URL payload, `other` otherwise. */
  lookupKeyKind: 'gtin' | 'url' | 'other';
  engines: string[];
  /** How many distinct engines produced this exact payload. */
  agreement: number;
  /** How many (engine, variant) attempts reproduced it. */
  observations: number;
  /**
   * Whether the value equals the service's own `barcode.primary`. `false` means
   * the client and the service picked different candidates — worth logging, and
   * a reason to trust `response.barcode.primary` over this summary.
   */
  matchesServicePrimary: boolean;
  /** The four observable terms the derived score is built from. */
  confidenceBreakdown: BarcodeConfidenceBreakdown;
}

/**
 * The single best product identifier in the response, or `null`.
 *
 * Mirrors `selectPrimaryBarcode` in src/barcode/fusion.ts:224-233 exactly:
 *   1. a retail GTIN that is not a URL payload,
 *   2. otherwise a Code 128,
 *   3. otherwise any other 1D format,
 *   4. otherwise the first (already rank-ordered) candidate.
 *
 * Returns `null` when nothing was decoded — including when engines ran and
 * found nothing, which is a real answer, not an error.
 *
 * It reads `barcode.results`, not `barcode.primary`, so the rule stays visible
 * and auditable; `matchesServicePrimary` reports whether the two agree.
 */
export function summarizeForLookup(response: AnalysisResponse): LookupIdentifier | null {
  const results = response.barcode.results;
  if (results.length === 0) return null;

  const selected =
    results.find((r) => r.is_retail_gtin && !r.is_url_payload) ??
    results.find((r) => r.format === 'Code 128') ??
    results.find((r) => !TWO_D_FORMATS.has(r.format)) ??
    results[0];
  // `results` is non-empty and every branch above yields a member, so this can
  // only be undefined if the array mutates underneath us. Guard rather than
  // assert, because a wrong value here becomes a wrong product lookup.
  if (!selected) return null;

  const isRetailGtin = selected.is_retail_gtin === true;
  const isUrlPayload = selected.is_url_payload === true;
  const selection: BarcodeSelection = isRetailGtin && !isUrlPayload
    ? 'retail_gtin'
    : selected.format === 'Code 128'
      ? 'code_128'
      : !TWO_D_FORMATS.has(selected.format)
        ? 'other_1d'
        : 'fallback_first';

  return {
    value: selected.value,
    format: selected.format,
    confidence: selected.confidence,
    confidenceSource: selected.confidence_source,
    selection,
    isRetailGtin,
    isIndianGs1: selected.is_indian_gs1 === true,
    isUrlPayload,
    lookupKeyKind: isUrlPayload ? 'url' : isRetailGtin ? 'gtin' : 'other',
    engines: selected.engines,
    agreement: selected.agreement,
    observations: selected.observations,
    matchesServicePrimary: (response.barcode.primary?.value ?? null) === selected.value,
    confidenceBreakdown: selected.confidence_breakdown,
  };
}

// ── Indian retail signals ───────────────────────────────────────────────────

/**
 * A field that was actually read off the pack, with its evidence. `null` means
 * "the label did not show it" — not "it is empty" and never a default value.
 */
export interface FieldSignal<T> {
  value: T;
  /** Derived, 0..1. `null` when the service could not score the read. */
  confidence: number | null;
  confidenceSource: 'derived' | 'unknown';
  /** The exact OCR substring the value came from. Show this on a detail screen. */
  evidence: string | null;
}

/** Mirrors `VegMarker['type']` in src/text/sections.ts:322-326. */
export type VegMarkerType = 'vegetarian' | 'non_vegetarian' | 'egg_containing' | 'unknown';

/**
 * Narrows `product.veg_marker.value`, which the DTO types as a plain `string`
 * (src/analyze/schema.ts:181), back to the service's four cases.
 */
export function isVegMarkerType(value: string): value is VegMarkerType {
  return value === 'vegetarian' || value === 'non_vegetarian' || value === 'egg_containing' || value === 'unknown';
}

export interface AllergenSignals {
  /** Allergens implied by named ingredients (FSSAI's 14). */
  fromIngredients: string[];
  /** Allergens named in an explicit allergen / `contains` declaration. */
  declared: string[];
  /** Verbatim `may contain: …` statements. */
  crossContamination: string[];
  /** Union of the two lists above, sorted and de-duplicated. */
  all: string[];
  /**
   * True only when a dedicated allergen heading was printed. Without it, an
   * empty `all` means "no allergen was named", which is *not* the same as
   * "allergen-free" — the pack may simply not declare allergens.
   */
  declaredInSection: boolean;
}

export interface RetailSignals {
  /**
   * Additive codes in the service's canonical `INS <digits>` form. The service
   * normalises `E621`, `E 621` and `INS 621` to the same string
   * (src/text/normalize.ts:395-405), so an E-number and an INS number are one
   * value here — do not present them as two independent confirmations.
   */
  insCodes: string[];
  /** Same codes as attached to a parsed ingredient item, sorted. */
  ingredientCodes: string[];
  allergens: AllergenSignals;
  /**
   * The veg/non-veg mark, or `null`. `null` covers both "no marker on the pack"
   * and "a marker was seen but not classified": the service reports the literal
   * `'unknown'` for the second case (src/text/sections.ts:326) and that is not a
   * dietary answer, so it is not passed on as one.
   */
  vegMarker: FieldSignal<Exclude<VegMarkerType, 'unknown'>> | null;
  /**
   * True when the service sent a veg marker value this client could not classify
   * as one of the four known cases. In the current build this never fires —
   * `extractProductInfo` maps an unresolved marker to `value: null`
   * (src/text/product.ts:221-223) — and it exists because the DTO widens the
   * union to a plain `string` (src/analyze/schema.ts:181), so the client cannot
   * rely on that without checking.
   */
  vegMarkerUnresolved: boolean;
  fssaiLicense: FieldSignal<string> | null;
  mrp: FieldSignal<{ amount: number; currency: string }> | null;
  netQuantity: FieldSignal<string> | null;
  bestBefore: FieldSignal<string> | null;
  manufacturer: FieldSignal<string> | null;
  countryOfOrigin: FieldSignal<string> | null;
  name: FieldSignal<string> | null;
  brand: FieldSignal<string> | null;
  variantOrFlavour: FieldSignal<string> | null;
  /**
   * `signals.indian_label_signals` verbatim. Read it as "the service found
   * *something* in this category"; the values themselves are in the fields
   * above.
   */
  labelSignals: string[];
  /** Anything in `signals.indian_label_signals` that is not one of the fields above. */
  labelSignalsElsewhere: string[];
}

/** Labels the helper maps to a concrete field; anything else lands in `labelSignalsElsewhere`. */
const MAPPED_LABEL_SIGNALS = new Set([
  'fssai_license',
  'veg_marker',
  'mrp',
  'net_quantity',
  'country_of_origin',
]);

/**
 * The Indian-retail signals, already unwrapped.
 *
 * Every list is a copy, and every field is `null` when the pack did not show it.
 * Nothing here is cross-referenced against a database — the service reports what
 * is printed on the label and nothing more.
 */
export function extractSignals(response: AnalysisResponse): RetailSignals {
  const product = response.product;
  const ingredients = response.ingredients;
  const allergens = response.allergens;

  const ingredientCodes = uniqueSorted(
    ingredients.items.flatMap((item) => collectItemCodes(item)),
  );

  const allAllergens = uniqueSorted([...allergens.from_ingredients, ...allergens.declared]);

  const rawVeg = product.veg_marker.value;
  const vegUnresolved = rawVeg !== null && (!isVegMarkerType(rawVeg) || rawVeg === 'unknown');

  return {
    insCodes: [...response.signals.ins_codes],
    ingredientCodes,
    allergens: {
      fromIngredients: [...allergens.from_ingredients],
      declared: [...allergens.declared],
      crossContamination: [...allergens.cross_contamination],
      all: allAllergens,
      declaredInSection: allergens.declared_in_section,
    },
    vegMarker: toSignal(product.veg_marker, (value) => {
      if (isVegMarkerType(value) && value !== 'unknown') return value;
      return null;
    }),
    vegMarkerUnresolved: vegUnresolved,
    fssaiLicense: toSignal(product.fssai_license),
    mrp: toSignal(product.mrp),
    netQuantity: toSignal(product.net_quantity),
    bestBefore: toSignal(product.best_before),
    manufacturer: toSignal(product.manufacturer),
    countryOfOrigin: toSignal(product.country_of_origin),
    name: toSignal(product.name),
    brand: toSignal(product.brand),
    variantOrFlavour: toSignal(product.variant_or_flavour),
    labelSignals: [...response.signals.indian_label_signals],
    labelSignalsElsewhere: response.signals.indian_label_signals.filter((s) => !MAPPED_LABEL_SIGNALS.has(s)),
  };
}

/** An additive code found anywhere in an ingredient tree, parents included. */
function collectItemCodes(item: IngredientItem): string[] {
  const codes: string[] = [];
  if (item.code) codes.push(item.code);
  for (const sub of item.sub_ingredients) {
    // Sub-ingredients are one level deep by construction, but recursing costs
    // nothing and keeps this correct if the service ever nests further.
    codes.push(...collectItemCodes(sub));
  }
  return codes;
}

/**
 * Unwraps an `ExtractedField`, returning `null` when the service reported no
 * value. A `null` `value` is authoritative — the service does not fill fields
 * with plausible defaults (src/analyze/schema.ts:5-8) — so this never falls back
 * to the evidence text.
 */
function toSignal<T>(field: ExtractedField<T>): FieldSignal<T> | null;
/**
 * `project` lets a caller drop a value that is present but meaningless, which is
 * how the `'unknown'` veg marker stops being reported as a dietary answer.
 */
function toSignal<T, R>(field: ExtractedField<T>, project: (value: T) => R | null): FieldSignal<R> | null;
function toSignal<T, R>(field: ExtractedField<T>, project?: (value: T) => R | null): FieldSignal<R> | null {
  const { value } = field;
  if (value === null) return null;
  const projected = project ? project(value) : (value as unknown as R);
  if (projected === null || projected === undefined) return null;
  return { value: projected, confidence: field.confidence, confidenceSource: field.confidence_source, evidence: field.evidence };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))].sort();
}

// ── Honest detection state ──────────────────────────────────────────────────

/**
 * What the service can actually tell FoodGuard about the barcode.
 * `not_attempted` and `no_barcode` are different failures to a user, so they are
 * different states here.
 */
export type DetectionState =
  /** No engine ran — the stage was skipped, disabled, or short-circuited. */
  | 'not_attempted'
  /** Engines ran and nothing decoded. A real answer: there is no readable code. */
  | 'no_barcode'
  /** Something decoded but the score is missing, unscored, or below the bar. */
  | 'low_confidence'
  /** A scored, above-bar detection. The only state a UI may call a success. */
  | 'detected';

export interface DetectionDescription {
  state: DetectionState;
  /** One sentence a UI can show verbatim. Never claims more than `state` allows. */
  message: string;
  value: string | null;
  format: string | null;
  confidence: number | null;
  /** `'unknown'` or `null` can never accompany `state: 'detected'`. */
  confidenceSource: 'engine' | 'derived' | 'unknown' | null;
  /**
   * Safe to send to a GTIN-keyed product database. False for `url` payloads,
   * `other` codes and every non-detected state.
   */
  isUsableForLookup: boolean;
  /** Every reason behind the state, for a "why?" panel and for logs. */
  reasons: string[];
}

export interface DescribeDetectionOptions {
  /** Overrides DEFAULT_MIN_BARCODE_CONFIDENCE (0.5). */
  minConfidence?: number;
}

/**
 * Turns the barcode block into one explicit state.
 *
 * `confidence_source: 'unknown'` is never treated as success — not as a high
 * score, not as a low score. The service produces it when a candidate has no
 * supporting evidence at all (src/barcode/fusion.ts:15-17), which is a gap in
 * what we know, and a product lookup built on it would be a guess.
 */
export function describeDetection(
  response: AnalysisResponse,
  options: DescribeDetectionOptions = {},
): DetectionDescription {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_BARCODE_CONFIDENCE;
  const barcode = response.barcode;
  const reasons: string[] = [];

  const attempted = barcode.engines_attempted.length > 0;
  if (!attempted) reasons.push(`no barcode engine ran (stop_reason: ${barcode.stop_reason})`);
  if (barcode.engines_unavailable.length > 0) {
    reasons.push(
      `${barcode.engines_unavailable.length} engine(s) unavailable: ${barcode.engines_unavailable
        .map((e) => e.engine)
        .join(', ')}`,
    );
  }

  if (!attempted) {
    return finish('not_attempted', 'No barcode engine ran for this image, so nothing was looked for.', reasons);
  }
  if (!barcode.detected) {
    reasons.push('engines ran and decoded no symbol');
    return finish('no_barcode', 'No barcode could be read from this photo.', reasons);
  }

  const summary = summarizeForLookup(response);
  if (!summary) {
    reasons.push('detection reported but no candidate is available to describe');
    return finish('low_confidence', 'Something was detected but the reading could not be scored.', reasons);
  }
  reasons.push(`format ${summary.format} from ${summary.engines.length} engine(s)`);

  if (summary.confidence === null || summary.confidenceSource === 'unknown') {
    reasons.push(
      summary.confidence === null
        ? 'no confidence was produced for this reading'
        : 'confidence_source is "unknown": the service has no evidence for this value',
    );
    return finish('low_confidence', 'A code was read but FoodGuard cannot say how sure it is, so it will not be looked up.', [
      ...reasons,
    ]);
  }
  if (summary.confidence < minConfidence) {
    reasons.push(`derived confidence ${summary.confidence} is below the ${minConfidence} bar`);
    return finish('low_confidence', 'A code was read, but the reading is too uncertain to look up.', reasons);
  }
  if (summary.isUrlPayload) {
    // A real detection, but not a product code: say so instead of pretending.
    reasons.push('the payload is a URL, not a GTIN; a GTIN lookup will not match it');
  }
  if (!summary.matchesServicePrimary) {
    reasons.push('this candidate differs from the service\'s own barcode.primary');
  }
  reasons.push(`derived confidence ${summary.confidence} (${summary.confidenceSource}), ${summary.observations} observation(s)`);

  return finish(
    'detected',
    summary.isUrlPayload
      ? `Read ${summary.format} ${summary.value}, which is a URL rather than a product code.`
      : `Read ${summary.format} ${summary.value} with derived confidence ${summary.confidence}.`,
    reasons,
    summary,
  );

  function finish(
    state: DetectionState,
    message: string,
    allReasons: string[],
    summaryArg?: LookupIdentifier,
  ): DetectionDescription {
    return {
      state,
      message,
      value: summaryArg?.value ?? null,
      format: summaryArg?.format ?? null,
      confidence: summaryArg?.confidence ?? null,
      confidenceSource: summaryArg?.confidenceSource ?? null,
      // Only a retail GTIN reaches a GTIN-keyed database; a URL payload needs a
      // different lookup and a UI that offers it.
      isUsableForLookup: state === 'detected' && summaryArg?.lookupKeyKind === 'gtin',
      reasons: allReasons,
    };
  }
}