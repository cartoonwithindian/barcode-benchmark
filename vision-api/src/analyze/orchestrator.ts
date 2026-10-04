/**
 * Analysis orchestrator — the request pipeline.
 *
 *   download (SSRF-safe)  ->  decode (bomb-safe, EXIF-normalised)
 *     ->  barcode: tiered preprocessing x multi-engine, early exit
 *     ->  OCR: staged variants, best-of scoring
 *     ->  text: normalisation -> sections -> ingredients / nutrition / product
 *     ->  stable, versioned JSON
 *
 * Invariants:
 *  - nothing is fabricated: a stage that finds nothing reports `detected: false`
 *    / `null` and pushes a warning;
 *  - the raw OCR text is preserved alongside the normalised text;
 *  - the image never touches disk and never leaves the request;
 *  - every stage is time-bounded so a pathological image cannot pin the instance.
 */
import { Semaphore, withTimeout, sinceMs } from '../core/async.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { globalMetrics } from '../core/metrics.js';
import { setStage } from '../core/requestContext.js';
import { decodeImage } from '../ingest/decode.js';
import { downloadImage } from '../ingest/downloader.js';
import type { AppConfig } from '../config/index.js';
import { assessQuality } from '../imaging/raster.js';
import type { Raster } from '../imaging/raster.js';
import { capLongestEdge } from '../imaging/resize.js';
import { CONTRACT_NAME_BY_VARIANT } from '../imaging/preprocessing.js';
import { BarcodePipeline } from '../barcode/pipeline.js';
import { EngineRegistry } from '../barcode/registry.js';
import { OcrEngine } from '../ocr/engine.js';
import { OcrPipeline, type OcrPipelineResult } from '../ocr/pipeline.js';
import { findInsCodes, normalizeOcrText } from '../text/normalize.js';
import { detectAllergensInText, parseIngredientSection, scoreIngredientConfidence } from '../text/ingredients.js';
import { parseNutritionSection } from '../text/nutrition.js';
import { extractProductInfo } from '../text/product.js';
import { findSection, findAllSections, type TextRegion } from '../text/sections.js';
import { AnalysisCache } from './cache.js';
import {
  barcodeResultDto,
  API_VERSION,
  SCHEMA_VERSION,
  type AnalysisResponse,
  type OcrRegionDto,
  type SignalsDto,
} from './schema.js';
import type { PlanName } from '../imaging/variants.js';

export interface AnalyzeOptions {
  /** Preprocessing/aggression plan for the barcode stage. */
  plan?: PlanName;
  /** Run the OCR stage (default true). */
  ocr?: boolean;
  /** Cap on preprocessing variants, overriding `BARCODE_MAX_VARIANTS`. */
  max_variants?: number;
  /** Per-request wall-clock budget in ms, clamped to the server maximum. */
  timeout_ms?: number;
  /** Set false to skip the OCR text normalisation pass. */
  normalize_text?: boolean;
  /**
   * Set false for text extraction only: the barcode stage is skipped and the
   * full budget goes to OCR. Defaults to true.
   */
  detect_barcode?: boolean;
}

export interface AnalyzeRequest {
  image_url: string;
  options?: AnalyzeOptions;
}

export interface AnalyzeContext {
  requestId: string;
  log: Logger;
}

const PLAN_MAX_MS: Record<PlanName, number> = { fast: 4000, standard: 9000, deep: 20_000 };

/** Options that change the output, and therefore the cache key. */
function optionsFingerprint(options: AnalyzeOptions): string {
  return JSON.stringify({
    plan: options.plan ?? 'standard',
    ocr: options.ocr ?? true,
    detect_barcode: options.detect_barcode ?? true,
    max_variants: options.max_variants ?? null,
    normalize_text: options.normalize_text ?? true,
    schema: SCHEMA_VERSION,
  });
}

export class VisionService {
  private readonly registry: EngineRegistry;
  private readonly barcodePipeline: BarcodePipeline;
  private readonly ocrEngine: OcrEngine;
  private readonly ocrPipeline: OcrPipeline;
  private readonly cache: AnalysisCache<AnalysisResponse>;
  /**
   * Bounds how many analyses decode/run at once. Each concurrent analysis can
   * hold hundreds of MB of rasters; on small instances (Render free tier is
   * 512 MB) the default of 1 keeps peak RSS flat at the cost of queueing.
   */
  private readonly analysisGate: Semaphore;
  private ocrClosed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {
    this.registry = new EngineRegistry(log);
    this.barcodePipeline = new BarcodePipeline(this.registry, log);
    this.ocrEngine = new OcrEngine({
      langPath: config.pipeline.ocr.langPath,
      lang: config.pipeline.ocr.lang,
      workerLimit: config.pipeline.ocr.workerLimit,
      timeoutMs: config.pipeline.ocr.timeoutMs,
      cache: config.pipeline.ocr.cache,
      logger: log,
    });
    this.ocrPipeline = new OcrPipeline(this.ocrEngine, log);
    this.cache = new AnalysisCache<AnalysisResponse>(
      config.cache.enabled ? config.cache.maxEntries : 0,
      config.cache.ttlSeconds * 1000,
    );
    this.analysisGate = new Semaphore(config.pipeline.maxConcurrentAnalyses);
  }

  /** Warms the barcode engines and OCR pool so the first real request is not slowed by WASM init or worker spawn. */
  async warmUp(): Promise<void> {
    await Promise.all([this.barcodePipeline.warmUp(), this.ocrEngine.warmUp()]);
  }

  async close(): Promise<void> {
    if (this.ocrClosed) return;
    this.ocrClosed = true;
    await this.ocrEngine.close();
  }

  get cacheStats() {
    return this.cache.stats();
  }

  engineStatusReport() {
    return this.registry.statusReport();
  }

  /**
   * Runs the full pipeline. Throws `AppError` for anything the caller must fix
   * (bad URL, blocked host, unreadable image); soft failures are reported inside
   * the response instead.
   */
  async analyze(request: AnalyzeRequest, ctx: AnalyzeContext): Promise<AnalysisResponse> {
    return this.analysisGate.run(() => this.analyzeGuarded(request, ctx));
  }

  private async analyzeGuarded(request: AnalyzeRequest, ctx: AnalyzeContext): Promise<AnalysisResponse> {
    const startedAt = process.hrtime.bigint();
    const timings: Record<string, number> = {};
    const warnings: string[] = [];

    const options = request.options ?? {};
    const plan: PlanName = options.plan ?? 'standard';
    const runOcr = (options.ocr ?? true) && this.config.pipeline.ocr.enabled;
    // `detect_barcode: false` turns this into a pure text-extraction service:
    // no barcode engines run, so OCR gets the whole budget. Useful when an
    // upstream AI model handles product identity from the returned text.
    const runBarcode = options.detect_barcode ?? true;
    const maxVariants = Math.min(options.max_variants ?? this.config.pipeline.barcode.maxVariants, this.config.pipeline.barcode.maxVariants);
    if ((options.ocr ?? true) && !this.config.pipeline.ocr.enabled) {
      warnings.push('ocr_disabled_by_configuration');
    }

    /**
     * One deadline for the whole request, not one budget per stage.
     *
     * A caller that asks for `timeout_ms: 25000` must not be made to wait for
     * `barcode budget + OCR budget + 2s` - the stages used to be bounded
     * independently, so the total was close to a minute while the caller had
     * been promised 25 seconds. Each stage below now spends only what is left.
     */
    const overallBudgetMs = options.timeout_ms ?? this.config.server.requestTimeoutMs;
    const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    /** Milliseconds left, floored so a stage can never be given a zero budget. */
    const remainingMs = () => Math.max(0, overallBudgetMs - elapsedMs());

    // ── 1. Download ─────────────────────────────────────────────────────────
    setStage('download');
    const downloadStart = process.hrtime.bigint();
    const downloaded = await downloadImage(request.image_url, this.config);
    timings.download_ms = sinceMs(downloadStart);
    this.log.debug(
      { request_id: ctx.requestId, source: downloaded.sourceTag, bytes: downloaded.bytes, ms: timings.download_ms },
      'image downloaded',
    );

    // ── 2. Cache (keyed on image content, never on the URL) ─────────────────
    const fingerprint = optionsFingerprint(options);
    const cacheKey = AnalysisCache.hash(downloaded.buffer, fingerprint);
    const cached = this.config.cache.enabled ? this.cache.get(cacheKey) : undefined;
    if (cached) {
      globalMetrics.increment('cache_hits_total');
      timings.total_ms = sinceMs(startedAt);
      this.log.info({ request_id: ctx.requestId, total_ms: timings.total_ms }, 'analysis served from cache');
      return {
        ...cached,
        request_id: ctx.requestId,
        diagnostics: { ...cached.diagnostics, cache_hit: true, timings_ms: { ...cached.diagnostics.timings_ms, cache_lookup_ms: timings.download_ms, total_ms: timings.total_ms } },
      };
    }
    globalMetrics.increment('cache_misses_total');

    // ── 3. Decode ───────────────────────────────────────────────────────────
    setStage('decode');
    const decodeStart = process.hrtime.bigint();
    const decoded = await decodeImage(downloaded.buffer, this.config);
    timings.decode_ms = sinceMs(decodeStart);
    if (decoded.downscaled) warnings.push('image_downscaled_for_processing');
    if (decoded.orientationApplied) warnings.push('exif_orientation_applied');

    const quality = assessQuality(decoded.raster);
    if (quality.quality === 'poor') warnings.push('low_image_quality');

    // ── 4. Barcode ──────────────────────────────────────────────────────────
    setStage('barcode');
    const barcodeStart = process.hrtime.bigint();
    // Reserve room for OCR before the barcode stage spends everything: on a
    // throttled 0.1-CPU instance the barcode variants can consume their whole
    // budget, and a `remainingMs() - 500` reservation leaves OCR seconds - not
    // even enough for one Tesseract pass - so the stage reports `ocr_stage_failed`
    // on readable labels. Reserve the configured OCR window when OCR is on.
    const ocrReservation = runOcr ? Math.min(this.config.pipeline.ocr.timeoutMs, Math.max(0, overallBudgetMs - 10_000)) : 0;
    const barcodeBudget = Math.min(
      this.config.pipeline.barcode.maxMs,
      // Never hand the barcode stage more than the request has left minus the
      // OCR reservation and 500 ms for response assembly.
      Math.max(500, remainingMs() - ocrReservation - 500),
      PLAN_MAX_MS[plan] * 2,
    );
    let barcodeResult;
    if (!runBarcode) {
      // Text-only mode: the whole remaining budget goes to OCR. Reported as
      // "not detected" rather than as a failure, because the stage was skipped
      // on request - nothing was guessed and nothing was searched for.
      warnings.push('barcode_skipped_by_request');
      barcodeResult = null;
    } else {
      try {
        barcodeResult = await withTimeout(
          this.barcodePipeline.run(decoded.raster, {
            plan,
            maxVariants,
            maxMs: barcodeBudget,
            minConfidence: this.config.pipeline.barcode.minConfidence,
          }),
          barcodeBudget + 2000,
          () => new AppError(ErrorCode.ANALYSIS_FAILED, 'Barcode analysis exceeded its time budget.'),
        );
      } catch (err) {
        globalMetrics.increment('analysis_failures_total');
        warnings.push('barcode_stage_failed');
        this.log.warn({ request_id: ctx.requestId, reason: String(err) }, 'barcode stage failed');
        barcodeResult = null;
      }
    }
    timings.barcode_ms = sinceMs(barcodeStart);

    if (barcodeResult?.detected) globalMetrics.increment('analysis_barcode_detected_total');
    else globalMetrics.increment('analysis_barcode_missed_total');
    if (!barcodeResult?.detected && barcodeResult !== null) warnings.push('barcode_not_detected');

    // ── 5. OCR ──────────────────────────────────────────────────────────────
    setStage('ocr');
    const ocrStart = process.hrtime.bigint();
    let ocrResult: OcrPipelineResult | null = null;
    // The OCR stage used to ignore `timeout_ms` entirely and use only its own
    // configured cap, which is how a "25 second" request could run for 33.
    const ocrLeft = Math.min(this.config.pipeline.ocr.timeoutMs, remainingMs());
    if (runOcr && ocrLeft < 1000) {
      // No room left in the caller's budget. Report the gap rather than
      // overshooting the deadline the caller asked for.
      warnings.push('ocr_skipped_request_budget_exhausted');
      this.log.info({ request_id: ctx.requestId, remaining_ms: ocrLeft }, 'ocr skipped: request budget exhausted');
    } else if (runOcr) {
      // Barcodes need the full 2200 px working raster; text does not. Hand OCR
      // a capped copy so no OCR variant can blow the memory budget by upscaling.
      const ocrRaster = await capLongestEdge(decoded.raster, this.config.pipeline.ocr.maxDimension).catch((err) => {
        warnings.push('ocr_raster_cap_failed');
        this.log.warn({ request_id: ctx.requestId, reason: String(err) }, 'ocr raster cap failed; using full raster');
        return decoded.raster;
      });
      ocrResult = await withTimeout(
        this.ocrPipeline.run(ocrRaster, {
          maxVariants: this.config.pipeline.ocr.maxVariants,
          // Shrink the per-variant budget with the deadline so a long barcode
          // stage cannot push OCR past the caller's timeout.
          timeoutMs: ocrLeft,
        }),
        ocrLeft + 2000,
        () => new AppError(ErrorCode.ANALYSIS_FAILED, 'OCR exceeded its time budget.'),
      ).catch((err) => {
        warnings.push('ocr_stage_failed');
        this.log.warn({ request_id: ctx.requestId, reason: String(err) }, 'ocr stage failed');
        return null;
      });
    }
    timings.ocr_ms = sinceMs(ocrStart);

    // `LOG_OCR_TEXT` is off by default because raw label text can contain
    // customer-specific content (name, address, batch code). Operators opt in
    // to see what the OCR stage actually read, which is the first question when
    // an ingredient list is missing from an otherwise good response.
    if (this.config.diagnostics.logOcrText && ocrResult?.best?.text) {
      this.log.info(
        { request_id: ctx.requestId, variant: ocrResult.best.variant, chars: ocrResult.best.text.length, text: ocrResult.best.text },
        'ocr text (LOG_OCR_TEXT enabled)',
      );
    }

    if (ocrResult?.detected) globalMetrics.increment('analysis_ocr_detected_total');
    else globalMetrics.increment('analysis_ocr_missed_total');

    // ── 6. Text understanding ───────────────────────────────────────────────
    setStage('text');
    const textStart = process.hrtime.bigint();
    const rawText = ocrResult?.best?.text ?? '';
    const normalized = options.normalize_text === false
      ? { rawText, normalizedText: rawText, corrections: [], confidence: 1 }
      : normalizeOcrText(rawText);
    const text = normalized.normalizedText;
    const lines = text.split('\n');
    const rawLines = rawText.split('\n');

    const meanWordConfidence = meanConfidenceInRange(ocrResult, undefined);

    const ingredientRegion = findSection(lines, 'ingredients') ?? findSection(lines, 'ingredients_continued');
    const nutritionRegion = findSection(lines, 'nutrition');
    const allergensRegion = findSection(lines, 'allergens');
    const containsRegion = findSection(lines, 'contains');
    const manufacturerRegion = findSection(lines, 'manufacturer');
    const mrpRegion = findSection(lines, 'mrp');
    const netQuantityRegion = findSection(lines, 'net_quantity');
    const fssaiRegion = findSection(lines, 'fssai');
    const bestBeforeRegion = findSection(lines, 'best_before');
    const claimsRegion = findSection(lines, 'claims');

    // Ingredient parsing runs on the *normalised* text so repaired INS codes are
    // recognised, and the raw section is reported alongside it.
    const ingredientParse = ingredientRegion
      ? parseIngredientSection(normalisedSectionText(lines, ingredientRegion), {
          heading: ingredientRegion.heading,
          startLine: ingredientRegion.startLine,
          endLine: ingredientRegion.endLine,
        })
      : parseIngredientSection('');
    const ingredientScore = scoreIngredientConfidence({
      found: ingredientParse.detected,
      items: ingredientParse.items,
      headingPresent: ingredientRegion !== null,
      meanWordConfidence,
    });
    if (ingredientParse.detected) globalMetrics.increment('analysis_ingredients_found_total');
    else warnings.push('ingredient_list_not_found');

    const nutritionParse = nutritionRegion
      ? parseNutritionSection(normalisedSectionText(lines, nutritionRegion), {
          heading: nutritionRegion.heading,
          startLine: nutritionRegion.startLine,
          endLine: nutritionRegion.endLine,
          meanWordConfidence: meanConfidenceInRange(ocrResult, nutritionRegion),
        })
      : parseNutritionSection('');
    if (nutritionRegion && !nutritionParse.detected) warnings.push('nutrition_section_found_but_unreadable');

    const declaredAllergens = [
      ...(allergensRegion ? detectAllergensInText(allergensRegion.rawSection) : []),
      ...(containsRegion ? detectAllergensInText(containsRegion.rawSection) : []),
    ].filter((a, i, arr) => arr.indexOf(a) === i);

    const product = extractProductInfo({
      text,
      sections: {
        manufacturer: manufacturerRegion ? { rawSection: manufacturerRegion.rawSection } : undefined,
        mrp: mrpRegion ? { rawSection: mrpRegion.rawSection } : undefined,
        net_quantity: netQuantityRegion ? { rawSection: netQuantityRegion.rawSection } : undefined,
        fssai: fssaiRegion ? { rawSection: fssaiRegion.rawSection } : undefined,
        best_before: bestBeforeRegion ? { rawSection: bestBeforeRegion.rawSection } : undefined,
      },
    });

    const insCodes = findInsCodes(text).map((h) => h.code);
    const indianSignals: string[] = [];
    if (product.fssai_license.value) indianSignals.push('fssai_license');
    if (product.veg_marker.value) indianSignals.push('veg_marker');
    if (product.mrp.value) indianSignals.push('mrp');
    if (product.net_quantity.value) indianSignals.push('net_quantity');
    if (product.country_of_origin.value) indianSignals.push('country_of_origin');
    if (claimsRegion) indianSignals.push('claims');

    const regions = buildRegions(ocrResult?.best ?? null, [
      ingredientRegion,
      nutritionRegion,
      allergensRegion,
      containsRegion,
      manufacturerRegion,
      mrpRegion,
      netQuantityRegion,
      fssaiRegion,
      bestBeforeRegion,
      claimsRegion,
    ], rawLines);

    timings.text_ms = sinceMs(textStart);

    // ── 7. Response ─────────────────────────────────────────────────────────
    setStage('respond');
    const totalMs = sinceMs(startedAt);
    timings.total_ms = totalMs;
    globalMetrics.observe('analysis_total', totalMs);

    const allSections = findAllSections(lines);
    const signals: SignalsDto = {
      ingredient_list_found: ingredientParse.detected,
      barcode_found: Boolean(barcodeResult?.detected),
      nutrition_panel_found: nutritionParse.detected,
      image_quality: quality.quality,
      image_quality_score: quality.score,
      ins_codes: [...new Set(insCodes)].sort(),
      indian_label_signals: indianSignals,
    };

    const response: AnalysisResponse = {
      success: true,
      request_id: ctx.requestId,
      schema_version: SCHEMA_VERSION,
      api_version: API_VERSION,
      image: {
        width: decoded.width,
        height: decoded.height,
        format: decoded.format,
        source_width: decoded.sourceWidth,
        source_height: decoded.sourceHeight,
        orientation_applied: decoded.orientationApplied,
        downscaled: decoded.downscaled,
        megapixels: decoded.megapixels,
        source: downloaded.sourceTag,
      },
      barcode: {
        detected: Boolean(barcodeResult?.detected),
        primary: barcodeResult?.primary
          ? {
              value: barcodeResult.primary.value,
              format: barcodeResult.primary.format,
              confidence: barcodeResult.primary.confidence,
              confidence_source: barcodeResult.primary.confidence_source,
            }
          : null,
        results: (barcodeResult?.fused ?? []).map(barcodeResultDto),
        engines_attempted: (barcodeResult?.attempts ?? []).filter((a) => a.variants_tried > 0).map((a) => a.engine),
        engines_unavailable: this.registry
          .statusReport()
          .filter((e) => e.status !== 'available')
          .map((e) => ({ engine: e.name, reason: e.reason ?? 'unavailable' })),
        preprocessing_variants_used: (barcodeResult?.variantsUsed ?? []).map(
          (v) => CONTRACT_NAME_BY_VARIANT[v] ?? v,
        ),
        stop_reason: barcodeResult?.stopReason ?? 'not_run',
        ms: timings.barcode_ms,
      },
      ocr: {
        detected: Boolean(ocrResult?.detected),
        confidence: ocrResult?.best ? ocrResult.best.confidence : null,
        confidence_source: ocrResult?.best ? 'engine' : 'unknown',
        engine: 'tesseract',
        raw_text: rawText,
        normalized_text: text,
        corrections: normalized.corrections,
        normalization_confidence: normalized.confidence,
        regions,
        variants_attempted: (ocrResult?.attempts ?? []).map((a) => ({
          variant: a.variant,
          preprocess: a.preprocess,
          psm: a.psm,
          confidence: a.confidence,
          chars: a.chars,
          ms: a.ms,
          selected: a.selected,
        })),
        best_variant: ocrResult?.best?.variant ?? null,
        ms: timings.ocr_ms,
        failure_reason: ocrResult?.failureReason ?? (runOcr ? null : 'ocr_disabled'),
      },
      product: {
        name: product.name,
        brand: product.brand,
        variant_or_flavour: product.variant_or_flavour,
        net_quantity: product.net_quantity,
        mrp: product.mrp,
        fssai_license: product.fssai_license,
        veg_marker: product.veg_marker,
        manufacturer: product.manufacturer,
        best_before: product.best_before,
        country_of_origin: product.country_of_origin,
      },
      ingredients: {
        detected: ingredientParse.detected,
        confidence: ingredientScore.confidence,
        confidence_source: ingredientScore.confidence_source,
        confidence_breakdown: ingredientScore.breakdown,
        raw_section: ingredientParse.rawSection,
        items: ingredientParse.items,
        heading: ingredientRegion?.heading ?? null,
      },
      nutrition: {
        detected: nutritionParse.detected,
        raw_section: nutritionParse.rawSection,
        basis: nutritionParse.basis,
        serving_size: nutritionParse.servingSize,
        values: nutritionParse.values,
        undeciphered_lines: nutritionParse.undecipheredLines,
        confidence: nutritionParse.confidence,
        confidence_source: nutritionParse.confidence_source,
        confidence_breakdown: nutritionParse.confidence_breakdown,
      },
      allergens: {
        from_ingredients: ingredientParse.allergens,
        declared: declaredAllergens,
        cross_contamination: ingredientParse.cross_contamination_statements,
        declared_in_section: allergensRegion !== null,
      },
      signals,
      diagnostics: {
        processing_time_ms: totalMs,
        barcode_engines_attempted: (barcodeResult?.attempts ?? []).filter((a) => a.variants_tried > 0).map((a) => a.engine),
        preprocessing_variants_used: (barcodeResult?.variantsUsed ?? []).map((v) => CONTRACT_NAME_BY_VARIANT[v] ?? v),
        timings_ms: timings,
        plan,
        cache_hit: false,
        quality: {
          brightness: quality.brightness,
          sharpness: quality.sharpness,
          overexposure: quality.overexposure,
          reasons: quality.reasons,
        },
        engines: (barcodeResult?.attempts ?? []).map((a) => ({
          engine: a.engine,
          status: a.status,
          variants_tried: a.variants_tried,
          detections: a.detections,
          total_ms: a.total_ms,
          error: a.error,
        })),
        ocr_attempts: (ocrResult?.attempts ?? []).map((a) => ({
          variant: a.variant,
          preprocess: a.preprocess,
          psm: a.psm,
          confidence: a.confidence,
          chars: a.chars,
          ms: a.ms,
          selected: a.selected,
        })),
      },
      warnings,
    };

    // Section list is intentionally not returned wholesale (it would duplicate
    // `ocr.regions`); this reference keeps `findAllSections` used and validated.
    void allSections;

    if (this.config.cache.enabled) this.cache.set(cacheKey, response);

    this.log.info(
      {
        request_id: ctx.requestId,
        total_ms: totalMs,
        barcode_detected: response.barcode.detected,
        barcode_value: response.barcode.primary?.value ?? null,
        ocr_detected: response.ocr.detected,
        ingredients_detected: response.ingredients.detected,
        nutrition_detected: response.nutrition.detected,
        quality: quality.quality,
        warnings,
      },
      'analysis complete',
    );

    return response;
  }
}

/** Section body text taken from the *normalised* lines (for parsed fields). */
function normalisedSectionText(lines: string[], region: TextRegion): string {
  return lines.slice(region.startLine, region.endLine + 1).join('\n').trim();
}

/**
 * Mean OCR word confidence, optionally restricted to the vertical band of a
 * section so nutrition scoring reflects the panel rather than the whole photo.
 */
function meanConfidenceInRange(result: OcrPipelineResult | null, region: TextRegion | undefined): number | null {
  const words = result?.best?.words ?? [];
  if (words.length === 0) return result?.best?.confidence ?? null;
  let relevant = words;
  if (region) {
    // Section line ranges are line indices in the text; the OCR block gives
    // pixel y ranges. Use the mean over the whole page when a mapping would be
    // a guess — `region.bbox` is populated when a pixel mapping is available.
    const bbox = region.bbox;
    if (bbox) {
      const inBand = words.filter((w) => w.bbox.y0 >= bbox.y && w.bbox.y1 <= bbox.y + bbox.height);
      if (inBand.length >= 3) relevant = inBand;
    }
  }
  const sum = relevant.reduce((acc, w) => acc + (Number.isFinite(w.confidence) ? w.confidence : 0), 0);
  return Number((sum / relevant.length).toFixed(2));
}

/** Maps located sections onto OCR pixel regions where a block matches. */
function buildRegions(
  ocr: { blocks: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> } | null,
  sections: Array<TextRegion | null | undefined>,
  rawLines: string[],
): OcrRegionDto[] {
  const out: OcrRegionDto[] = [];
  const blocks = ocr?.blocks ?? [];
  for (const section of sections) {
    if (!section) continue;
    const heading = section.heading ?? '';
    // Find the OCR block that overlaps the heading text most closely.
    let best: OcrRegionDto['bbox'];
    if (heading.length > 3 && blocks.length > 0) {
      const needle = heading.slice(0, 24).toLowerCase();
      let bestScore = 0;
      for (const block of blocks) {
        const haystack = block.text.slice(0, 120).toLowerCase();
        if (!haystack.includes(needle.slice(0, 10))) continue;
        let score = 0;
        for (let i = 0; i < needle.length; i++) if (haystack[i] === needle[i]) score++;
        if (score > bestScore) {
          bestScore = score;
          best = {
            x: Math.round(block.bbox.x0),
            y: Math.round(block.bbox.y0),
            width: Math.round(block.bbox.x1 - block.bbox.x0),
            height: Math.round(block.bbox.y1 - block.bbox.y0),
          };
        }
      }
    }
    out.push({
      kind: section.kind,
      text: section.rawSection.length > 0 ? section.rawSection : rawLines[section.startLine] ?? null,
      ...(best ? { bbox: best } : {}),
    });
  }
  return out;
}

/** Wraps unexpected throws so the HTTP layer can render a safe error. */
export function rethrowAsAppError(err: unknown): never {
  throw toAppError(err);
}

export type { AnalysisResponse };
