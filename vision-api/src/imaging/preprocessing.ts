/**
 * Image preprocessing — server-side port of the benchmark pipeline.
 *
 * Provenance: `barcode-benchmark/src/app/core/image/preprocessing.ts`.
 *
 * What was kept from the original (the parts that matter for decoding quality):
 *  - the complete variant catalogue and tier grouping,
 *  - the exact algorithms for grayscale, sharpen, CLAHE, Otsu, mean/adaptive
 *    thresholding, Sauvola, Niblack, morphology (dilate/erode/close), Sobel-X,
 *    black-hat, median denoise, auto polarity, ROI/barcode cropping, nearest
 *    neighbour upscale and the `full_auto` composite pipeline,
 *  - the projection-profile deskew strategy and the auto-ROI band search.
 *
 * What changed for the server (and why):
 *  - `ImageData` -> `Raster` (`src/imaging/raster.ts`), which is the structural
 *    `ImageDataLike` subset the benchmark already used. No DOM, no node-canvas.
 *  - Canvas rotation/cropping -> `sharp`, which gives better resampling and
 *    native performance. `rotate()` in sharp uses the same clockwise convention
 *    as `ctx.rotate()`.
 *  - `deskew` searched 61 candidate angles by fully re-rendering the image
 *    through the canvas each time, which is far too slow for a request/response
 *    service. The search now runs on a downscaled luminance plane with a
 *    nearest-neighbour rotation (same projection-profile scoring, ~1/40 of the
 *    pixel work) and only the winning angle is applied through sharp.
 */
import sharp from 'sharp';
import { cloneRaster, grayToRaster, setGray, toLuminancePlane, type Raster } from './raster.js';

// ─── Variant catalogue (kept identical to the benchmark) ──────────────────────

export type Tier = 'tier1' | 'tier2' | 'tier3' | 'all';

export type PreprocessVariant =
  // Tier 1 — Basic
  | 'original'
  | 'grayscale'
  | 'upscale2x'
  | 'upscale3x'
  | 'clahe'
  | 'sharpen'
  | 'otsu'
  | 'adaptive_threshold'
  // Tier 2 — Geometry
  | 'rotate_15'
  | 'rotate_30'
  | 'rotate_45'
  | 'rotate_90'
  | 'rotate_neg15'
  | 'rotate_neg30'
  | 'rotate_neg45'
  | 'rotate_neg90'
  | 'deskew'
  | 'perspective_correction'
  | 'auto_roi'
  | 'barcode_crop'
  // Tier 3 — Advanced
  | 'morph_close'
  | 'horiz_morphology'
  | 'sobel_x'
  | 'black_hat'
  | 'denoise'
  | 'sauvola'
  | 'niblack'
  | 'auto_polarity'
  // Tier 4 — Combinations
  | 'gray_upscale2x'
  | 'gray_clahe'
  | 'clahe_upscale2x'
  | 'clahe_otsu'
  | 'clahe_adaptive'
  | 'roi_upscale2x'
  | 'roi_clahe'
  | 'roi_otsu'
  | 'roi_perspective'
  // Tier 5 — Full AUTO
  | 'full_auto';

/** Names required by the FoodGuard service contract mapped onto benchmark variants. */
export const CONTRACT_VARIANT_ALIASES: Record<string, PreprocessVariant> = {
  original: 'original',
  resized: 'upscale2x',
  grayscale: 'grayscale',
  'contrast-enhanced': 'clahe',
  sharpened: 'sharpen',
  denoised: 'denoise',
  thresholded: 'otsu',
  'adaptive-threshold': 'adaptive_threshold',
  deskewed: 'deskew',
  'perspective-corrected': 'perspective_correction',
};

export const ALL_VARIANTS: readonly PreprocessVariant[] = [
  'original', 'grayscale', 'upscale2x', 'upscale3x', 'clahe', 'sharpen', 'otsu', 'adaptive_threshold',
  'rotate_15', 'rotate_30', 'rotate_45', 'rotate_90',
  'rotate_neg15', 'rotate_neg30', 'rotate_neg45', 'rotate_neg90',
  'deskew', 'perspective_correction', 'auto_roi', 'barcode_crop',
  'morph_close', 'horiz_morphology', 'sobel_x', 'black_hat',
  'denoise', 'sauvola', 'niblack', 'auto_polarity',
  'gray_upscale2x', 'gray_clahe', 'clahe_upscale2x', 'clahe_otsu',
  'clahe_adaptive', 'roi_upscale2x', 'roi_clahe', 'roi_otsu', 'roi_perspective',
  'full_auto',
] as const;

export const TIER_MAP: Record<Tier, readonly PreprocessVariant[]> = {
  tier1: ['original', 'grayscale', 'clahe', 'sharpen'],
  tier2: ['otsu', 'adaptive_threshold', 'auto_polarity', 'denoise', 'upscale2x'],
  tier3: ['deskew', 'auto_roi', 'barcode_crop', 'perspective_correction', 'rotate_90', 'rotate_neg90', 'full_auto'],
  all: ALL_VARIANTS,
};

export const VARIANT_LABELS: Record<PreprocessVariant, string> = {
  original: 'Original',
  grayscale: 'Grayscale',
  upscale2x: 'Upscale 2x',
  upscale3x: 'Upscale 3x',
  clahe: 'CLAHE (contrast enhancement)',
  sharpen: 'Sharpen',
  otsu: 'Otsu Threshold',
  adaptive_threshold: 'Adaptive Threshold',
  rotate_15: 'Rotate +15 deg',
  rotate_30: 'Rotate +30 deg',
  rotate_45: 'Rotate +45 deg',
  rotate_90: 'Rotate +90 deg',
  rotate_neg15: 'Rotate -15 deg',
  rotate_neg30: 'Rotate -30 deg',
  rotate_neg45: 'Rotate -45 deg',
  rotate_neg90: 'Rotate -90 deg',
  deskew: 'Deskew',
  perspective_correction: 'Perspective Correction',
  auto_roi: 'Auto ROI',
  barcode_crop: 'Barcode Crop',
  morph_close: 'Morphological Close',
  horiz_morphology: 'Horizontal Morphology',
  sobel_x: 'Sobel X',
  black_hat: 'Black Hat',
  denoise: 'Denoise (median)',
  sauvola: 'Sauvola Threshold',
  niblack: 'Niblack Threshold',
  auto_polarity: 'Auto Polarity',
  gray_upscale2x: 'Grayscale + Upscale 2x',
  gray_clahe: 'Grayscale + CLAHE',
  clahe_upscale2x: 'CLAHE + Upscale 2x',
  clahe_otsu: 'CLAHE + Otsu',
  clahe_adaptive: 'CLAHE + Adaptive Threshold',
  roi_upscale2x: 'ROI + Upscale 2x',
  roi_clahe: 'ROI + CLAHE',
  roi_otsu: 'ROI + Otsu',
  roi_perspective: 'ROI + Perspective',
  full_auto: 'Full AUTO Pipeline',
};

/** Reverse lookup: contract name -> canonical variant name used in responses. */
export const CONTRACT_NAME_BY_VARIANT: Partial<Record<PreprocessVariant, string>> = {
  original: 'original',
  upscale2x: 'resized',
  grayscale: 'grayscale',
  clahe: 'contrast-enhanced',
  sharpen: 'sharpened',
  denoise: 'denoised',
  otsu: 'thresholded',
  adaptive_threshold: 'adaptive-threshold',
  deskew: 'deskewed',
  perspective_correction: 'perspective-corrected',
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Applies a preprocessing variant. All operations are pure: the input raster is
 * never mutated, so a single decoded image can feed every stage of the pipeline.
 */
export async function applyVariant(frame: Raster, variant: PreprocessVariant): Promise<Raster> {
  switch (variant) {
    // Tier 1
    case 'original': return cloneRaster(frame);
    case 'grayscale': return grayscale(cloneRaster(frame));
    case 'upscale2x': return upscale(cloneRaster(frame), 2);
    case 'upscale3x': return upscale(cloneRaster(frame), 3);
    case 'clahe': return clahe(cloneRaster(frame));
    case 'sharpen': return sharpen(cloneRaster(frame));
    case 'otsu': return otsuThreshold(cloneRaster(frame));
    case 'adaptive_threshold': return adaptiveThreshold(cloneRaster(frame));
    // Tier 2 (geometry)
    case 'rotate_15': return rotate(frame, 15);
    case 'rotate_30': return rotate(frame, 30);
    case 'rotate_45': return rotate(frame, 45);
    case 'rotate_90': return rotate90(frame, 90);
    case 'rotate_neg15': return rotate(frame, -15);
    case 'rotate_neg30': return rotate(frame, -30);
    case 'rotate_neg45': return rotate(frame, -45);
    case 'rotate_neg90': return rotate90(frame, -90);
    case 'deskew': return deskew(frame);
    case 'perspective_correction': return perspectiveCorrection(frame);
    case 'auto_roi': return autoRoi(frame);
    case 'barcode_crop': return barcodeCrop(frame);
    // Tier 3
    case 'morph_close': return morphClose(cloneRaster(frame));
    case 'horiz_morphology': return horizontalMorphology(cloneRaster(frame));
    case 'sobel_x': return sobelX(cloneRaster(frame));
    case 'black_hat': return blackHat(cloneRaster(frame));
    case 'denoise': return denoise(cloneRaster(frame));
    case 'sauvola': return sauvolaThreshold(cloneRaster(frame));
    case 'niblack': return niblackThreshold(cloneRaster(frame));
    case 'auto_polarity': return autoPolarity(cloneRaster(frame));
    // Tier 4 — combinations
    case 'gray_upscale2x': return upscale(grayscale(cloneRaster(frame)), 2);
    case 'gray_clahe': return clahe(grayscale(cloneRaster(frame)));
    case 'clahe_upscale2x': return upscale(clahe(cloneRaster(frame)), 2);
    case 'clahe_otsu': return otsuThreshold(clahe(cloneRaster(frame)));
    case 'clahe_adaptive': return adaptiveThreshold(clahe(cloneRaster(frame)));
    case 'roi_upscale2x': return upscale(await autoRoi(frame), 2);
    case 'roi_clahe': return clahe(await autoRoi(frame));
    case 'roi_otsu': return otsuThreshold(await autoRoi(frame));
    case 'roi_perspective': return perspectiveCorrection(await autoRoi(frame));
    // Tier 5
    case 'full_auto': return fullAutoPipeline(frame);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function luminance(d: Uint8ClampedArray, i: number): number {
  return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
}

// ─── Tier 1 — Basic (algorithms ported verbatim from the benchmark) ──────────

function grayscale(img: Raster): Raster {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) setGray(d, i, luminance(d, i));
  return img;
}

function sharpen(img: Raster): Raster {
  const { width: w, height: h, data } = img;
  const src = new Uint8ClampedArray(data);
  const k = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        let ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++, ki++) {
            acc += src[((y + dy) * w + (x + dx)) * 4 + c] * k[ki];
          }
        }
        data[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, acc));
      }
    }
  }
  return img;
}

function clahe(img: Raster): Raster {
  // Contrast Limited Adaptive Histogram Equalization (block based), identical
  // structure and parameters to the benchmark implementation.
  const d = img.data;
  const w = img.width;
  const h = img.height;
  for (let i = 0; i < d.length; i += 4) setGray(d, i, luminance(d, i));

  const blockSize = 64;
  const clipLimit = 3.0;
  const hist = new Array<number>(256).fill(0);

  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      const endY = Math.min(by + blockSize, h);
      const endX = Math.min(bx + blockSize, w);
      hist.fill(0);
      let pixelCount = 0;
      for (let y = by; y < endY; y++) {
        for (let x = bx; x < endX; x++) {
          hist[d[(y * w + x) * 4]]++;
          pixelCount++;
        }
      }
      if (pixelCount === 0) continue;
      const limit = Math.floor((clipLimit * pixelCount) / 256);
      let excess = 0;
      for (let t = 0; t < 256; t++) {
        if (hist[t] > limit) {
          excess += hist[t] - limit;
          hist[t] = limit;
        }
      }
      const avgInc = Math.floor(excess / 256);
      for (let t = 0; t < 256; t++) hist[t] += avgInc;
      const lut = new Uint8ClampedArray(256);
      let cumulative = 0;
      for (let t = 0; t < 256; t++) {
        cumulative += hist[t];
        lut[t] = Math.max(0, Math.min(255, Math.round((cumulative / pixelCount) * 255)));
      }
      for (let y = by; y < endY; y++) {
        for (let x = bx; x < endX; x++) {
          const i = (y * w + x) * 4;
          setGray(d, i, lut[d[i]]);
        }
      }
    }
  }
  return img;
}

function otsuThreshold(img: Raster): Raster {
  const d = img.data;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(luminance(d, i))]++;
  const total = d.length / 4;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    setGray(d, i, luminance(d, i) > threshold ? 255 : 0);
  }
  return img;
}

function adaptiveThreshold(img: Raster): Raster {
  const d = img.data;
  const w = img.width;
  const h = img.height;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = luminance(d, i * 4);

  const blockSize = 31;
  const C = 10;
  const half = Math.floor(blockSize / 2);

  const integral = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[y * w + x] = rowSum + (y > 0 ? integral[(y - 1) * w + x] : 0);
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const y1 = Math.max(0, y - half);
      const y2 = Math.min(h - 1, y + half);
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(w - 1, x + half);
      const count = (y2 - y1 + 1) * (x2 - x1 + 1);
      let sum = integral[y2 * w + x2];
      if (y1 > 0) sum -= integral[(y1 - 1) * w + x2];
      if (x1 > 0) sum -= integral[y2 * w + (x1 - 1)];
      if (y1 > 0 && x1 > 0) sum += integral[(y1 - 1) * w + (x1 - 1)];
      const mean = sum / count;
      setGray(d, (y * w + x) * 4, gray[y * w + x] > mean - C ? 255 : 0);
    }
  }
  return img;
}

// ─── Geometry (sharp-backed; same clockwise convention as ctx.rotate) ────────

async function rotate(img: Raster, degrees: number): Promise<Raster> {
  if (degrees === 0) return cloneRaster(img);
  const buf = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .rotate(degrees, { background: { r: 128, g: 128, b: 128, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: buf.info.width,
    height: buf.info.height,
    data: new Uint8ClampedArray(buf.data.buffer, buf.data.byteOffset, buf.data.length),
  };
}

/** 90 degree rotations are exact and cheap — no resampling involved. */
async function rotate90(img: Raster, degrees: 90 | -90): Promise<Raster> {
  const rotated = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .rotate(degrees)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: rotated.info.width,
    height: rotated.info.height,
    data: new Uint8ClampedArray(rotated.data.buffer, rotated.data.byteOffset, rotated.data.length),
  };
}

/** Nearest-neighbour rotation of a single-channel plane (deskew search only). */
function rotatePlaneNearest(plane: Uint8Array, w: number, h: number, degrees: number): { plane: Uint8Array; width: number; height: number } {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const nw = Math.max(1, Math.round(w * cos + h * sin));
  const nh = Math.max(1, Math.round(w * sin + h * cos));
  const out = new Uint8Array(nw * nh);
  const cx = w / 2;
  const cy = h / 2;
  const ncx = nw / 2;
  const ncy = nh / 2;
  const a = Math.cos(rad);
  const b = Math.sin(rad);
  for (let y = 0; y < nh; y++) {
    const dy = y - ncy;
    for (let x = 0; x < nw; x++) {
      const dx = x - ncx;
      const sx = Math.round(a * dx + b * dy + cx);
      const sy = Math.round(-b * dx + a * dy + cy);
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
        out[y * nw + x] = 255;
      } else {
        out[y * nw + x] = plane[sy * w + sx];
      }
    }
  }
  return { plane: out, width: nw, height: nh };
}

function projectionProfile(plane: Uint8Array, w: number, h: number, direction: 'horizontal' | 'vertical'): number[] {
  if (direction === 'horizontal') {
    const profile = new Array<number>(h).fill(0);
    for (let y = 0; y < h; y++) {
      let count = 0;
      const rowStart = y * w;
      for (let x = 0; x < w; x++) if (plane[rowStart + x] < 128) count++;
      profile[y] = count;
    }
    return profile;
  }
  const profile = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    const rowStart = y * w;
    for (let x = 0; x < w; x++) if (plane[rowStart + x] < 128) profile[x]++;
  }
  return profile;
}

function computeVariance(arr: number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  const mean = sum / arr.length;
  let acc = 0;
  for (const v of arr) acc += (v - mean) ** 2;
  return acc / arr.length;
}

/**
 * Projection-profile deskew. Same scoring idea as the benchmark (pick the
 * angle whose row-projection variance is highest, i.e. the angle that makes
 * text/bar lines horizontal), but the search happens on a downscaled plane.
 */
async function deskew(img: Raster): Promise<Raster> {
  const SEARCH_MAX_DIM = 480;
  const scale = Math.min(1, SEARCH_MAX_DIM / Math.max(img.width, img.height));
  const sw = Math.max(8, Math.round(img.width * scale));
  const sh = Math.max(8, Math.round(img.height * scale));

  const small = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .resize({ width: sw, height: sh, fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // sharp returns a fresh Buffer; view it without copying.
  const plane = new Uint8Array(small.data.buffer, small.data.byteOffset, small.data.length);
  const binary = new Uint8Array(plane.length);
  // Binarise with the global mean so the profile is polarity independent.
  let sum = 0;
  for (let i = 0; i < plane.length; i++) sum += plane[i];
  const mean = sum / Math.max(1, plane.length);
  for (let i = 0; i < plane.length; i++) binary[i] = plane[i] < mean ? 0 : 255;

  let bestAngle = 0;
  let bestVariance = -1;
  for (let angle = -12; angle <= 12; angle += 1) {
    const rotated = rotatePlaneNearest(binary, sw, sh, angle);
    const variance = computeVariance(projectionProfile(rotated.plane, rotated.width, rotated.height, 'horizontal'));
    if (variance > bestVariance) {
      bestVariance = variance;
      bestAngle = angle;
    }
  }
  if (Math.abs(bestAngle) < 1) return cloneRaster(img);
  return rotate(img, bestAngle);
}

async function perspectiveCorrection(img: Raster): Promise<Raster> {
  // The benchmark estimated a dominant edge angle and rectified by rotation.
  // Kept as-is, with the sampling grid tightened so the estimate is stable.
  const edges = sobelXRaw(img);
  const angle = detectLineOrientation(edges);
  if (Math.abs(angle) < 1) return cloneRaster(img);
  return rotate(img, angle);
}

function detectLineOrientation(edges: Raster): number {
  const { width: w, height: h, data } = edges;
  let bestAngle = 0;
  let bestScore = 0;
  const votes = new Map<number, number>();
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (data[(y * w + x) * 4] > 128) {
        for (let dx = 4; dx < 20; dx += 2) {
          const nx = x + dx;
          if (nx < w && data[(y * w + nx) * 4] > 128) {
            // Local gradient direction of a horizontal run.
            const up = y > 0 && data[((y - 1) * w + x) * 4] > 128 ? 1 : 0;
            const down = y < h - 1 && data[((y + 1) * w + x) * 4] > 128 ? 1 : 0;
            const slope = (down - up) / 2;
            const angle = Math.round(Math.atan(slope) * (180 / Math.PI));
            votes.set(angle, (votes.get(angle) ?? 0) + 1);
          }
        }
      }
    }
  }
  for (const [angle, count] of votes) {
    if (count > bestScore) {
      bestScore = count;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/**
 * Auto region-of-interest crop. Ported from the benchmark: binarise, build a
 * row-density profile, then keep the horizontal band with the highest
 * row-density variance (where barcode bars and dense text lines live).
 */
async function autoRoi(img: Raster): Promise<Raster> {
  const gray = grayscale(cloneRaster(img));
  const d = gray.data;
  const w = gray.width;
  const h = gray.height;

  for (let i = 0; i < d.length; i += 4) setGray(d, i, d[i] < 128 ? 0 : 255);

  const rowDensity = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const rowStart = y * w;
    for (let x = 0; x < w; x++) if (d[(rowStart + x) * 4] === 0) count++;
    rowDensity[y] = count / w;
  }

  const bandSize = Math.max(20, Math.floor(h * 0.05));
  let bestStart = 0;
  let bestScore = -1;
  for (let y = 0; y + bandSize <= h; y++) {
    let bandMean = 0;
    for (let i = y; i < y + bandSize; i++) bandMean += rowDensity[i];
    bandMean /= bandSize;
    let score = 0;
    for (let i = y; i < y + bandSize; i++) score += (rowDensity[i] - bandMean) ** 2;
    if (score > bestScore) {
      bestScore = score;
      bestStart = y;
    }
  }

  const pad = Math.round(h * 0.02);
  const y1 = Math.max(0, bestStart - pad);
  const y2 = Math.min(h, bestStart + bandSize + pad);
  if (y2 - y1 < 32 || y2 - y1 >= h) return cloneRaster(img);

  return crop(img, 0, y1, w, y2 - y1);
}

async function barcodeCrop(img: Raster): Promise<Raster> {
  // Same band search as auto_roi; the benchmark aliased the two because the
  // horizontal projection is what actually localises 1D barcodes.
  return autoRoi(img);
}

async function crop(img: Raster, left: number, top: number, width: number, height: number): Promise<Raster> {
  const out = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .extract({ left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)), width: Math.round(width), height: Math.round(height) })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: out.info.width,
    height: out.info.height,
    data: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.length),
  };
}

// ─── Tier 3 — Advanced ──────────────────────────────────────────────────────

function dilate(img: Raster, kernelW: number, kernelH: number): Raster {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data);
  const halfW = Math.floor(kernelW / 2);
  const halfH = Math.floor(kernelH / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let maxVal = 0;
      for (let dy = -halfH; dy <= halfH; dy++) {
        for (let dx = -halfW; dx <= halfW; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            const v = data[(ny * w + nx) * 4];
            if (v > maxVal) maxVal = v;
          }
        }
      }
      setGray(out, (y * w + x) * 4, maxVal);
    }
  }
  return { width: w, height: h, data: out };
}

function erode(img: Raster, kernelW: number, kernelH: number): Raster {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data);
  const halfW = Math.floor(kernelW / 2);
  const halfH = Math.floor(kernelH / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let minVal = 255;
      for (let dy = -halfH; dy <= halfH; dy++) {
        for (let dx = -halfW; dx <= halfW; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            const v = data[(ny * w + nx) * 4];
            if (v < minVal) minVal = v;
          }
        }
      }
      setGray(out, (y * w + x) * 4, minVal);
    }
  }
  return { width: w, height: h, data: out };
}

function morphClose(img: Raster): Raster {
  return erode(dilate(img, 3, 1), 3, 1);
}

function horizontalMorphology(img: Raster): Raster {
  return dilate(dilate(img, 5, 1), 5, 1);
}

function sobelXRaw(img: Raster): Raster {
  const { width: w, height: h, data } = img;
  const gray = grayscale(cloneRaster(img));
  const d = gray.data;
  const out = new Uint8ClampedArray(d.length);
  const kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let acc = 0;
      let ki = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, ki++) {
          acc += d[((y + dy) * w + (x + dx)) * 4] * kx[ki];
        }
      }
      const i = (y * w + x) * 4;
      const v = Math.min(255, Math.abs(acc));
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function sobelX(img: Raster): Raster {
  return otsuThreshold(sobelXRaw(img));
}

function blackHat(img: Raster): Raster {
  const closed = morphClose(grayscale(cloneRaster(img)));
  const orig = grayscale(cloneRaster(img));
  const d = orig.data;
  const c = closed.data;
  for (let i = 0; i < d.length; i += 4) setGray(d, i, Math.max(0, c[i] - d[i]));
  return orig;
}

function denoise(img: Raster): Raster {
  const { width: w, height: h, data } = img;
  const gray = grayscale(cloneRaster(img));
  const d = gray.data;
  const out = new Uint8ClampedArray(d);
  const window = new Array<number>(9);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) window[n++] = d[((y + dy) * w + (x + dx)) * 4];
      }
      // Insertion sort of 9 elements — faster than allocating and sorting.
      for (let i = 1; i < 9; i++) {
        const v = window[i];
        let j = i - 1;
        while (j >= 0 && window[j] > v) {
          window[j + 1] = window[j];
          j--;
        }
        window[j + 1] = v;
      }
      setGray(out, (y * w + x) * 4, window[4]);
    }
  }
  return { width: w, height: h, data: out };
}

/** Shared integral-image (sum + sum of squares) computation. */
function integralImages(img: Raster): { integral: Float64Array; integralSq: Float64Array; gray: Float64Array } {
  const { width: w, height: h } = img;
  const d = img.data;
  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = d[i * 4];

  const integral = new Float64Array(w * h);
  const integralSq = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rowSum += v;
      rowSumSq += v * v;
      integral[y * w + x] = rowSum + (y > 0 ? integral[(y - 1) * w + x] : 0);
      integralSq[y * w + x] = rowSumSq + (y > 0 ? integralSq[(y - 1) * w + x] : 0);
    }
  }
  return { integral, integralSq, gray };
}

function sauvolaThreshold(img: Raster): Raster {
  const d = img.data;
  const { width: w, height: h } = img;
  const blockSize = 31;
  const k = 0.2;
  const R = 128;
  const half = Math.floor(blockSize / 2);
  const { integral, integralSq } = integralImages(img);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const y1 = Math.max(0, y - half);
      const y2 = Math.min(h - 1, y + half);
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(w - 1, x + half);
      const count = (y2 - y1 + 1) * (x2 - x1 + 1);
      let sum = integral[y2 * w + x2];
      let sumSq = integralSq[y2 * w + x2];
      if (y1 > 0) {
        sum -= integral[(y1 - 1) * w + x2];
        sumSq -= integralSq[(y1 - 1) * w + x2];
      }
      if (x1 > 0) {
        sum -= integral[y2 * w + (x1 - 1)];
        sumSq -= integralSq[y2 * w + (x1 - 1)];
      }
      if (y1 > 0 && x1 > 0) {
        sum += integral[(y1 - 1) * w + (x1 - 1)];
        sumSq += integralSq[(y1 - 1) * w + (x1 - 1)];
      }
      const mean = sum / count;
      const variance = sumSq / count - mean * mean;
      const stddev = Math.sqrt(Math.max(0, variance));
      const threshold = mean * (1 + k * (stddev / R - 1));
      setGray(d, (y * w + x) * 4, d[(y * w + x) * 4] > threshold ? 255 : 0);
    }
  }
  return img;
}

function niblackThreshold(img: Raster): Raster {
  const d = img.data;
  const { width: w, height: h } = img;
  const blockSize = 31;
  const k = -0.2;
  const half = Math.floor(blockSize / 2);
  const { integral, integralSq } = integralImages(img);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const y1 = Math.max(0, y - half);
      const y2 = Math.min(h - 1, y + half);
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(w - 1, x + half);
      const count = (y2 - y1 + 1) * (x2 - x1 + 1);
      let sum = integral[y2 * w + x2];
      let sumSq = integralSq[y2 * w + x2];
      if (y1 > 0) {
        sum -= integral[(y1 - 1) * w + x2];
        sumSq -= integralSq[(y1 - 1) * w + x2];
      }
      if (x1 > 0) {
        sum -= integral[y2 * w + (x1 - 1)];
        sumSq -= integralSq[y2 * w + (x1 - 1)];
      }
      if (y1 > 0 && x1 > 0) {
        sum += integral[(y1 - 1) * w + (x1 - 1)];
        sumSq += integralSq[(y1 - 1) * w + (x1 - 1)];
      }
      const mean = sum / count;
      const stddev = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
      const threshold = mean + k * stddev;
      setGray(d, (y * w + x) * 4, d[(y * w + x) * 4] > threshold ? 255 : 0);
    }
  }
  return img;
}

function autoPolarity(img: Raster): Raster {
  const d = img.data;
  const gray = grayscale(cloneRaster(img));
  const gd = gray.data;
  let darkCount = 0;
  let lightCount = 0;
  for (let i = 0; i < gd.length; i += 4) {
    if (gd[i] < 128) darkCount++;
    else lightCount++;
  }
  if (darkCount > lightCount) {
    for (let i = 0; i < gd.length; i += 4) setGray(gd, i, 255 - gd[i]);
  }
  return gray;
}

// ─── Tier 5 — Full AUTO pipeline ────────────────────────────────────────────

async function fullAutoPipeline(img: Raster): Promise<Raster> {
  let current = grayscale(cloneRaster(img));
  current = denoise(current);
  current = autoPolarity(current);
  current = await autoRoi(current);
  current = clahe(current);
  current = await deskew(current);
  current = adaptiveThreshold(current);
  return current;
}

function upscale(img: Raster, factor: number): Raster {
  const w = img.width;
  const h = img.height;
  const nw = Math.round(w * factor);
  const nh = Math.round(h * factor);
  if (nw * nh > 40_000_000) return cloneRaster(img);
  const out = new Uint8ClampedArray(nw * nh * 4);
  const src = img.data;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / factor));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / factor));
      const si = (sy * w + sx) * 4;
      const di = (y * nw + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return { width: nw, height: nh, data: out };
}

// ─── Region extraction helpers used by the OCR stage ────────────────────────

/**
 * Suggests rectangular regions likely to contain dense small text (ingredient
 * panels / nutrition tables). Used as a hint for OCR retries and for the
 * `signals` block; never used to fabricate content.
 */
export function suggestTextRegions(img: Raster): Array<{ x: number; y: number; width: number; height: number; kind: string }> {
  const plane = toLuminancePlane(img);
  const { width: w, height: h } = img;
  const cell = 32;
  const cols = Math.floor(w / cell);
  const rows = Math.floor(h / cell);
  if (cols < 1 || rows < 1) return [];

  const density = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let edges = 0;
      let count = 0;
      for (let y = r * cell; y < (r + 1) * cell; y += 2) {
        for (let x = c * cell; x < (c + 1) * cell; x += 2) {
          const p = y * w + x;
          if (p + 1 < plane.length && plane[p] !== plane[p + 1]) edges++;
          count++;
        }
      }
      density[r * cols + c] = count > 0 ? edges / count : 0;
    }
  }

  const values = Array.from(density).sort((a, b) => a - b);
  const p90 = values[Math.floor(values.length * 0.9)] ?? 0;
  if (p90 <= 0) return [];

  const regions: Array<{ x: number; y: number; width: number; height: number; kind: string }> = [];
  let startRow = -1;
  for (let r = 0; r < rows; r++) {
    let rowActive = false;
    for (let c = 0; c < cols; c++) {
      if (density[r * cols + c] >= p90) {
        rowActive = true;
        break;
      }
    }
    if (rowActive && startRow === -1) startRow = r;
    if (!rowActive && startRow !== -1) {
      regions.push({ x: 0, y: startRow * cell, width: w, height: (r - startRow) * cell, kind: 'text_band' });
      startRow = -1;
    }
  }
  if (startRow !== -1) {
    regions.push({ x: 0, y: startRow * cell, width: w, height: (rows - startRow) * cell, kind: 'text_band' });
  }
  return regions.filter((r) => r.height >= cell * 2).slice(0, 4);
}

/** Exports helpers so the OCR stage can reuse the exact same luma math. */
export { grayscale, grayToRaster };