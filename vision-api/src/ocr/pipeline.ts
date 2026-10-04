/**
 * Staged OCR pipeline.
 *
 * Strategy (mirrors the barcode pipeline's "cheap first, widen on failure"):
 *
 *   variant 1: grayscale + 2x upscale, PSM 3 (automatic layout)
 *       -> ingredient heading found?  stop.
 *       -> otherwise variant 2: plain grayscale, PSM 3
 *       -> otherwise variant 3: CLAHE (low-contrast packaging), PSM 6 (block)
 *
 * The winning variant is chosen by a *quality score*, not by the first result:
 * heading recall dominates, then character count, then Tesseract confidence.
 * That avoids the classic failure mode of keeping a high-confidence but
 * content-free pass (e.g. a clean render of the barcode area only).
 *
 * Every variant's text is preserved so `raw_text` is never overwritten by a later
 * pass; `variants` reports what was attempted and which one won.
 */
import { sinceMs } from '../core/async.js';
import sharp from 'sharp';
import type { Logger } from '../core/logger.js';
import { globalMetrics } from '../core/metrics.js';
import { applyVariant, type PreprocessVariant } from '../imaging/preprocessing.js';
import { cloneRaster, type Raster } from '../imaging/raster.js';
import { buildOcrPlan } from '../imaging/variants.js';
import { hasIngredientHeading, hasNutritionHeading } from '../text/sections.js';
import type { OcrEngine, OcrResult } from './engine.js';

const OCR_VARIANT_TO_PREPROCESS: Record<string, PreprocessVariant> = {
  original: 'original',
  gray: 'grayscale',
  gray_upscale2x: 'gray_upscale2x',
  clahe: 'clahe',
  adaptive: 'adaptive_threshold',
  denoise: 'denoise',
};

export interface OcrAttemptReport {
  variant: string;
  preprocess: PreprocessVariant;
  psm: number;
  confidence: number;
  chars: number;
  ms: number;
  ingredient_heading: boolean;
  nutrition_heading: boolean;
  selected: boolean;
}

export interface OcrPipelineResult {
  detected: boolean;
  best: OcrResult | null;
  attempts: OcrAttemptReport[];
  stoppedEarly: boolean;
  totalMs: number;
  /** Set when OCR was disabled or every variant failed. */
  failureReason: string | null;
}

export interface OcrPipelineOptions {
  maxVariants: number;
  timeoutMs: number;
}

export class OcrPipeline {
  constructor(
    private readonly engine: OcrEngine,
    private readonly log: Logger,
  ) {}

  async run(image: Raster, options: OcrPipelineOptions): Promise<OcrPipelineResult> {
    const startedAt = process.hrtime.bigint();
    const plan = buildOcrPlan(options.maxVariants);
    const attempts: OcrAttemptReport[] = [];
    let best: OcrResult | null = null;
    let bestScore = -1;
    let stoppedEarly = false;

    // Cap the number of (variant, psm) passes so a bad image cannot blow the budget.
    const maxPasses = Math.max(1, Math.min(options.maxVariants, 4));
    let passCount = 0;

    outer: for (const variant of plan.variants) {
      const preprocess = OCR_VARIANT_TO_PREPROCESS[variant] ?? 'grayscale';
      let raster: Raster;
      try {
        raster = await applyVariant(image, preprocess);
      } catch (err) {
        this.log.debug({ variant, preprocess, reason: String(err) }, 'ocr preprocessing failed');
        continue;
      }

      // Binarised variants are poor for OCR; keep them grayscale and let
      // Tesseract's own thresholding handle it.
      if (variant === 'adaptive' || variant === 'denoise') raster = cloneRaster(raster);

      const encoded = await encodeForOcr(raster);
      if (!encoded) continue;

      for (const psm of plan.psm) {
        if (passCount >= maxPasses) break outer;
        if (sinceMs(startedAt) > options.timeoutMs) break outer;
        passCount += 1;

        const result = await this.engine.recognise(encoded, variant, psm);
        if (!result) {
          attempts.push({ variant, preprocess, psm, confidence: 0, chars: 0, ms: 0, ingredient_heading: false, nutrition_heading: false, selected: false });
          continue;
        }

        const text = result.text.trim();
        const ingredientHeading = hasIngredientHeading(text);
        const nutritionHeading = hasNutritionHeading(text);
        const score = scoreOcrResult(text, result.confidence, ingredientHeading, nutritionHeading);
        const selected = score > bestScore;

        attempts.push({
          variant,
          preprocess,
          psm,
          confidence: result.confidence,
          chars: text.length,
          ms: result.elapsedMs,
          ingredient_heading: ingredientHeading,
          nutrition_heading: nutritionHeading,
          selected,
        });

        globalMetrics.observe('ocr_recognize', result.elapsedMs);

        if (selected) {
          bestScore = score;
          best = result;
        }

        // Early exit once a pass has both text and the heading we care most about.
        if (ingredientHeading && text.length > 120) {
          stoppedEarly = true;
          break outer;
        }
      }
    }

    const totalMs = sinceMs(startedAt);
    globalMetrics.observe('ocr_pipeline', totalMs);

    const detected = Boolean(best && best.text.trim().length > 0);
    return {
      detected,
      best: detected ? best : null,
      attempts,
      stoppedEarly,
      totalMs,
      failureReason: detected ? null : attempts.length === 0 ? 'no_variant_processed' : 'no_text_recognised',
    };
  }
}

/**
 * Encodes a raster as a grayscale PNG for Tesseract.
 *
 * `compressionLevel: 1` keeps the deflate pass cheap; OCR dominates the cost of
 * this stage, not the encode. Grayscale also shrinks the payload ~3x versus
 * RGBA, which matters when several variants are tried per request.
 */
async function encodeForOcr(raster: Raster): Promise<Buffer | null> {
  try {
    return await sharp(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength), {
      raw: { width: raster.width, height: raster.height, channels: 4 },
    })
      .flatten({ background: '#ffffff' })
      .greyscale()
      .png({ compressionLevel: 1 })
      .toBuffer();
  } catch (err) {
    return null;
  }
}

function scoreOcrResult(text: string, confidence: number, ingredientHeading: boolean, nutritionHeading: boolean): number {
  const lengthScore = Math.min(1, text.length / 1200);
  const headingScore = (ingredientHeading ? 1 : 0) + (nutritionHeading ? 0.3 : 0);
  const confidenceScore = Math.max(0, Math.min(1, confidence / 100));
  // Character-rich results matter more than raw confidence: Tesseract is
  // confidently wrong on glare and curved foil.
  return Number((headingScore * 2 + lengthScore + confidenceScore).toFixed(4));
}