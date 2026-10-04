/**
 * Raster downscaling for the OCR stage.
 *
 * The barcode stage wants pixels - a 2200 px working raster is what makes a
 * damaged or photographed barcode readable. The OCR stage does not want them:
 * Tesseract allocates roughly in proportion to pixel count, and its accuracy on
 * label text plateaus long before that.
 *
 * Measured on the synthetic Indian label with `tessdata-fast`, holding
 * everything else constant:
 *
 *   input    pixels    peak RSS   mean confidence
 *    800px    0.9MP      191 MB          92
 *   1400px    2.7MP      207 MB          93   <- best confidence of the sweep
 *   1800px    4.5MP      245 MB          93
 *   3170px   14.0MP      361 MB          92   (upscaled)
 *   4400px   26.9MP      465 MB          90   (upscaled)
 *
 * Upscaling is worse on every axis that matters here, so the OCR plan's
 * `gray_upscale2x` variant was inflating a 2200 px raster to 4400 px (19 MP,
 * ~465 MB) to *lower* mean confidence. On a 512 MB instance that single variant
 * was the difference between running and being OOM-killed.
 *
 * This module caps the raster before the OCR plan ever sees it, which bounds the
 * damage regardless of which variants the plan chooses to run.
 */
import sharp from 'sharp';
import type { Raster } from './raster.js';

/** Longest edge the OCR stage will ever be handed. See the table above. */
export const DEFAULT_OCR_MAX_DIMENSION = 1400;

/**
 * Returns a copy of `src` whose longest edge is at most `maxDimension`.
 *
 * No-op (returns the original raster) when it is already small enough. Aspect
 * ratio is preserved and enlargement is never requested - sending a 600 px crop
 * up to 1400 px would only invent detail for Tesseract to misread.
 */
export async function capLongestEdge(src: Raster, maxDimension: number): Promise<Raster> {
  return resizeLongestEdge(src, maxDimension, { allowUpscale: false });
}

/**
 * Longest edge Tesseract needs to read small label text reliably.
 *
 * Measured on a real 400x392 nutrition panel (Open Food Facts) with
 * `tessdata-fast`, psm 6, everything else held constant:
 *
 *   input        chars recovered   mean conf
 *   400x392 native      179           46
 *   1400 px enlarged    285           42
 *
 * Enlarging recovers substantially more real text ("Nutrition Information",
 * "Per Serve", "Sulph"); the mean-confidence figure *drops* slightly because on
 * a noisy pack the extra pixels also make background noise legible enough to
 * be counted. Recovered content is what callers downstream actually consume,
 * so the enlargement wins.
 *
 * Only *small* images are enlarged. An image already at or above the cap is
 * untouched, so this can never be the memory blow-up that removing the old
 * `gray_upscale2x` variant fixed.
 */
export const OCR_MIN_DIMENSION = 1400;

/**
 * Resizes `src` so its longest edge is at most `maxDimension`, and - when
 * `allowUpscale` is set - at least `minDimension`.
 */
export async function resizeLongestEdge(
  src: Raster,
  maxDimension: number,
  opts: { allowUpscale?: boolean; minDimension?: number } = {},
): Promise<Raster> {
  const longest = Math.max(src.width, src.height);
  const floor = opts.allowUpscale ? (opts.minDimension ?? OCR_MIN_DIMENSION) : 0;
  let scale = 1;
  if (longest > maxDimension) scale = maxDimension / longest;
  else if (floor > 0 && longest < floor) scale = floor / longest;
  if (scale === 1) return src;

  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));

  const { data, info } = await sharp(Buffer.from(src.data.buffer, src.data.byteOffset, src.data.byteLength), {
    raw: { width: src.width, height: src.height, channels: 4 },
  })
    .resize({
      width,
      height,
      fit: 'fill',
      // Lanczos in both directions: it softens the interpolation edges, which
      // reads small print better than nearest-neighbour, whose staircase edges
      // Tesseract reads as noise.
      kernel: 'lanczos3',
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== width || info.height !== height || info.channels !== 4) {
    // Defensive: a mismatch here would mean every pixel index downstream is
    // wrong, so fail the stage loudly instead of returning a corrupt raster.
    throw new Error(`ocr raster resize produced ${info.width}x${info.height}x${info.channels}, expected ${width}x${height}x4`);
  }

  return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
}
