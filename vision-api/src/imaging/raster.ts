/**
 * Raster — the server-side replacement for the browser `ImageData` used by the
 * benchmark application.
 *
 * The benchmark's preprocessing module was written against a structural subset
 * of `ImageData` (`ImageDataLike` in the original repo). Keeping the same shape
 * here means every algorithm ported from `src/app/core/image/preprocessing.ts`
 * operates unchanged, while nothing depends on the DOM or `node-canvas`.
 */

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bit per channel, row-major, no padding. */
  readonly data: Uint8ClampedArray;
}

/** Structural alias mirroring the benchmark repo's `ImageDataLike`. */
export type RasterLike = Raster;

export function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneRaster(src: RasterLike): Raster {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

export function rasterFromRgba(width: number, height: number, data: Uint8ClampedArray): Raster {
  return { width, height, data };
}

/** Grayscale plane (single byte per pixel) extracted with the benchmark's luma weights. */
export function toLuminancePlane(src: RasterLike): Uint8Array {
  const out = new Uint8Array(src.width * src.height);
  const d = src.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    out[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }
  return out;
}

export function grayToRaster(plane: Uint8Array, width: number, height: number): Raster {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const v = plane[p];
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}

export function setGray(data: Uint8ClampedArray, i: number, v: number): void {
  data[i] = v;
  data[i + 1] = v;
  data[i + 2] = v;
  data[i + 3] = 255;
}

/** Mean luminance of the raster, 0..255. Cheap image-quality signal. */
export function meanLuminance(src: RasterLike): number {
  const d = src.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return sum / (d.length / 4);
}

/** Sharpness proxy: mean absolute Laplacian response, 0..255. */
export function laplacianEnergy(src: RasterLike): number {
  const { width: w, height: h } = src;
  if (w < 3 || h < 3) return 0;
  const plane = toLuminancePlane(src);
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const v =
        Math.abs(4 * plane[p] - plane[p - 1] - plane[p + 1] - plane[p - w] - plane[p + w]);
      sum += v;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Fraction of pixels that are (near) saturated white or black. */
export function overexposureRatio(src: RasterLike): number {
  const d = src.data;
  let blown = 0;
  const total = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] >= 250 && d[i + 1] >= 250 && d[i + 2] >= 250) blown++;
  }
  return total > 0 ? blown / total : 0;
}

export type ImageQuality = 'good' | 'fair' | 'poor';

export interface QualityAssessment {
  quality: ImageQuality;
  /** 0..1 heuristic score used for logging / `signals.image_quality`. */
  score: number;
  brightness: number;
  sharpness: number;
  overexposure: number;
  reasons: string[];
}

export function assessQuality(src: RasterLike): QualityAssessment {
  const brightness = meanLuminance(src);
  const sharpness = laplacianEnergy(src);
  const overexposure = overexposureRatio(src);
  const reasons: string[] = [];

  let score = 1;
  if (brightness < 45) {
    score -= 0.35;
    reasons.push('very_dark');
  } else if (brightness < 80) {
    score -= 0.15;
    reasons.push('dark');
  }
  if (brightness > 225) {
    score -= 0.2;
    reasons.push('very_bright');
  }
  if (sharpness < 4) {
    score -= 0.35;
    reasons.push('blurry');
  } else if (sharpness < 12) {
    score -= 0.12;
    reasons.push('soft_focus');
  }
  if (overexposure > 0.25) {
    score -= 0.2;
    reasons.push('glare');
  }
  score = Math.max(0, Math.min(1, Number(score.toFixed(3))));

  return {
    quality: score >= 0.75 ? 'good' : score >= 0.45 ? 'fair' : 'poor',
    score,
    brightness: Number(brightness.toFixed(2)),
    sharpness: Number(sharpness.toFixed(2)),
    overexposure: Number(overexposure.toFixed(4)),
    reasons,
  };
}