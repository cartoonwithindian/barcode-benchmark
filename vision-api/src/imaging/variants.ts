/**
 * Preprocessing variant planning.
 *
 * The benchmark app could afford to run 38 variants across 6 engines; a
 * request/response service on a Render instance cannot. This module turns the
 * full catalogue into an ordered, budgeted plan:
 *
 *   plan.fast()  -> Tier 1 (cheap, high hit rate)
 *   plan.standard() -> Tier 1 + a slice of Tier 2
 *   plan.deep()  -> Tier 1 + Tier 2 + Tier 3 (geometry/ROI attempts)
 *
 * The barcode pipeline consumes the plan lazily and stops as soon as the
 * confidence target is met (see `barcode/pipeline.ts`).
 */
import { TIER_MAP, type PreprocessVariant } from './preprocessing.js';

export type PlanName = 'fast' | 'standard' | 'deep';

export interface VariantPlan {
  name: PlanName;
  /** Ordered; the first entry is always `original`. */
  variants: PreprocessVariant[];
}

const FAST: PreprocessVariant[] = ['original', 'grayscale', 'clahe', 'sharpen'];
const STANDARD: PreprocessVariant[] = ['original', 'grayscale', 'clahe', 'sharpen', 'otsu', 'auto_polarity', 'adaptive_threshold', 'denoise', 'upscale2x'];
const DEEP: PreprocessVariant[] = [
  ...STANDARD,
  'auto_roi',
  'barcode_crop',
  'deskew',
  'rotate_90',
  'rotate_neg90',
  'sauvola',
  'horiz_morphology',
  'roi_otsu',
  'upscale3x',
  'perspective_correction',
  'full_auto',
];

const BY_NAME: Record<PlanName, readonly PreprocessVariant[]> = {
  fast: FAST,
  standard: STANDARD,
  deep: DEEP,
};

export function buildVariantPlan(name: PlanName, maxVariants: number): VariantPlan {
  const source = BY_NAME[name] ?? TIER_MAP.all;
  const variants = source.slice(0, Math.max(1, maxVariants));
  if (!variants.includes('original')) variants.unshift('original');
  return { name, variants: [...new Set(variants)] };
}

/** OCR variants: text needs different treatment than barcodes. */
export type OcrVariant = 'gray' | 'gray_upscale2x' | 'clahe' | 'adaptive' | 'original' | 'denoise';

export interface OcrPlan {
  /** Ordered variants to attempt. */
  variants: OcrVariant[];
  /** Page segmentation modes to try per variant. */
  psm: number[];
}

export function buildOcrPlan(maxVariants: number): OcrPlan {
  const ordered: OcrVariant[] = ['gray_upscale2x', 'gray', 'clahe', 'adaptive', 'original'];
  const variants = ordered.slice(0, Math.max(1, maxVariants));
  // PSM 3 = fully automatic page segmentation (whole label),
  // PSM 6 = uniform block of text (dense panels such as ingredients).
  const psm = variants.length > 1 ? [3, 6] : [3];
  return { variants, psm };
}