import { ImageDataLike } from './image-data-like';

// ─── Variant types ───────────────────────────────────────────────────────────

export type Tier =
  | 'Tier 1 — Basic'
  | 'Tier 2 — Geometry'
  | 'Tier 3 — Advanced'
  | 'Tier 4 — Combinations'
  | 'Tier 5 — Full AUTO';

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

export const ALL_VARIANTS: PreprocessVariant[] = [
  // Tier 1
  'original', 'grayscale', 'upscale2x', 'upscale3x', 'clahe', 'sharpen', 'otsu', 'adaptive_threshold',
  // Tier 2
  'rotate_15', 'rotate_30', 'rotate_45', 'rotate_90',
  'rotate_neg15', 'rotate_neg30', 'rotate_neg45', 'rotate_neg90',
  'deskew', 'perspective_correction', 'auto_roi', 'barcode_crop',
  // Tier 3
  'morph_close', 'horiz_morphology', 'sobel_x', 'black_hat',
  'denoise', 'sauvola', 'niblack', 'auto_polarity',
  // Tier 4
  'gray_upscale2x', 'gray_clahe', 'clahe_upscale2x', 'clahe_otsu',
  'clahe_adaptive', 'roi_upscale2x', 'roi_clahe', 'roi_otsu', 'roi_perspective',
  // Tier 5
  'full_auto',
];

export const TIER_MAP: Record<Tier, PreprocessVariant[]> = {
  'Tier 1 — Basic': ['original', 'grayscale', 'upscale2x', 'upscale3x', 'clahe', 'sharpen', 'otsu', 'adaptive_threshold'],
  'Tier 2 — Geometry': ['rotate_15', 'rotate_30', 'rotate_45', 'rotate_90', 'rotate_neg15', 'rotate_neg30', 'rotate_neg45', 'rotate_neg90', 'deskew', 'perspective_correction', 'auto_roi', 'barcode_crop'],
  'Tier 3 — Advanced': ['morph_close', 'horiz_morphology', 'sobel_x', 'black_hat', 'denoise', 'sauvola', 'niblack', 'auto_polarity'],
  'Tier 4 — Combinations': ['gray_upscale2x', 'gray_clahe', 'clahe_upscale2x', 'clahe_otsu', 'clahe_adaptive', 'roi_upscale2x', 'roi_clahe', 'roi_otsu', 'roi_perspective'],
  'Tier 5 — Full AUTO': ['full_auto'],
};

export const PREPROCESS_VARIANTS: PreprocessVariant[] = ALL_VARIANTS;

export const VARIANT_LABELS: Record<PreprocessVariant, string> = {
  // Tier 1
  original: 'Original',
  grayscale: 'Grayscale',
  upscale2x: 'Upscale 2×',
  upscale3x: 'Upscale 3×',
  clahe: 'CLAHE',
  sharpen: 'Sharpen',
  otsu: 'Otsu Threshold',
  adaptive_threshold: 'Adaptive Threshold',
  // Tier 2
  rotate_15: 'Rotate +15°',
  rotate_30: 'Rotate +30°',
  rotate_45: 'Rotate +45°',
  rotate_90: 'Rotate +90°',
  rotate_neg15: 'Rotate -15°',
  rotate_neg30: 'Rotate -30°',
  rotate_neg45: 'Rotate -45°',
  rotate_neg90: 'Rotate -90°',
  deskew: 'Deskew',
  perspective_correction: 'Perspective Correction',
  auto_roi: 'Auto ROI',
  barcode_crop: 'Barcode Crop',
  // Tier 3
  morph_close: 'Morphological Close',
  horiz_morphology: 'Horizontal Morphology',
  sobel_x: 'Sobel X',
  black_hat: 'Black Hat',
  denoise: 'Denoise',
  sauvola: 'Sauvola Threshold',
  niblack: 'Niblack Threshold',
  auto_polarity: 'Auto Polarity',
  // Tier 4
  gray_upscale2x: 'Grayscale + Upscale 2×',
  gray_clahe: 'Grayscale + CLAHE',
  clahe_upscale2x: 'CLAHE + Upscale 2×',
  clahe_otsu: 'CLAHE + Otsu',
  clahe_adaptive: 'CLAHE + Adaptive Threshold',
  roi_upscale2x: 'ROI + Upscale 2×',
  roi_clahe: 'ROI + CLAHE',
  roi_otsu: 'ROI + Otsu',
  roi_perspective: 'ROI + Perspective',
  // Tier 5
  full_auto: 'Full AUTO Pipeline',
};

// ─── Public API ──────────────────────────────────────────────────────────────

export function applyVariant(frame: ImageDataLike, variant: PreprocessVariant): ImageData {
  switch (variant) {
    // Tier 1
    case 'original':            return clone(frame);
    case 'grayscale':           return grayscale(clone(frame));
    case 'upscale2x':           return upscale(clone(frame), 2);
    case 'upscale3x':           return upscale(clone(frame), 3);
    case 'clahe':               return clahe(clone(frame));
    case 'sharpen':             return sharpen(clone(frame));
    case 'otsu':                return otsuThreshold(clone(frame));
    case 'adaptive_threshold':  return adaptiveThreshold(clone(frame));
    // Tier 2
    case 'rotate_15':           return rotate(clone(frame), 15);
    case 'rotate_30':           return rotate(clone(frame), 30);
    case 'rotate_45':           return rotate(clone(frame), 45);
    case 'rotate_90':           return rotate(clone(frame), 90);
    case 'rotate_neg15':        return rotate(clone(frame), -15);
    case 'rotate_neg30':        return rotate(clone(frame), -30);
    case 'rotate_neg45':        return rotate(clone(frame), -45);
    case 'rotate_neg90':        return rotate(clone(frame), -90);
    case 'deskew':              return deskew(clone(frame));
    case 'perspective_correction': return perspectiveCorrection(clone(frame));
    case 'auto_roi':            return autoRoi(clone(frame));
    case 'barcode_crop':        return barcodeCrop(clone(frame));
    // Tier 3
    case 'morph_close':         return morphClose(clone(frame));
    case 'horiz_morphology':    return horizontalMorphology(clone(frame));
    case 'sobel_x':             return sobelX(clone(frame));
    case 'black_hat':           return blackHat(clone(frame));
    case 'denoise':             return denoise(clone(frame));
    case 'sauvola':             return sauvolaThreshold(clone(frame));
    case 'niblack':             return niblackThreshold(clone(frame));
    case 'auto_polarity':       return autoPolarity(clone(frame));
    // Tier 4 — Combinations (pipeline)
    case 'gray_upscale2x':      return upscale(grayscale(clone(frame)), 2);
    case 'gray_clahe':          return clahe(grayscale(clone(frame)));
    case 'clahe_upscale2x':     return upscale(clahe(clone(frame)), 2);
    case 'clahe_otsu':          return otsuThreshold(clahe(clone(frame)));
    case 'clahe_adaptive':      return adaptiveThreshold(clahe(clone(frame)));
    case 'roi_upscale2x':       return upscale(autoRoi(clone(frame)), 2);
    case 'roi_clahe':           return clahe(autoRoi(clone(frame)));
    case 'roi_otsu':            return otsuThreshold(autoRoi(clone(frame)));
    case 'roi_perspective':     return perspectiveCorrection(autoRoi(clone(frame)));
    // Tier 5
    case 'full_auto':           return fullAutoPipeline(clone(frame));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clone(frame: ImageDataLike): ImageData {
  return new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
}

function luminance(d: Uint8ClampedArray, i: number): number {
  return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
}

function setGray(d: Uint8ClampedArray, i: number, v: number): void {
  d[i] = d[i + 1] = d[i + 2] = v;
}

// ─── Tier 1 — Basic ─────────────────────────────────────────────────────────

function grayscale(img: ImageData): ImageData {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    setGray(d, i, luminance(d, i));
  }
  return img;
}

function sharpen(img: ImageData): ImageData {
  const { width: w, height: h, data } = img;
  const src = new Uint8ClampedArray(data);
  const k = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0, ki = 0;
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

function clahe(img: ImageData): ImageData {
  // Contrast Limited Adaptive Histogram Equalization (simplified block-based)
  const d = img.data;
  const w = img.width, h = img.height;
  // First convert to grayscale
  for (let i = 0; i < d.length; i += 4) setGray(d, i, luminance(d, i));

  const blockSize = 64;
  const clipLimit = 3.0;
  const hist = new Array<number>(256).fill(0);

  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      const endY = Math.min(by + blockSize, h);
      const endX = Math.min(bx + blockSize, w);
      // Build histogram for this block
      hist.fill(0);
      let pixelCount = 0;
      for (let y = by; y < endY; y++) {
        for (let x = bx; x < endX; x++) {
          hist[d[(y * w + x) * 4]]++;
          pixelCount++;
        }
      }
      // Clip histogram
      const limit = Math.floor(clipLimit * pixelCount / 256);
      let excess = 0;
      for (let t = 0; t < 256; t++) {
        if (hist[t] > limit) { excess += hist[t] - limit; hist[t] = limit; }
      }
      const avgInc = Math.floor(excess / 256);
      for (let t = 0; t < 256; t++) hist[t] += avgInc;
      // Build LUT
      const lut = new Uint8ClampedArray(256);
      let cumulative = 0;
      for (let t = 0; t < 256; t++) {
        cumulative += hist[t];
        lut[t] = Math.max(0, Math.min(255, Math.round((cumulative / pixelCount) * 255)));
      }
      // Apply LUT
      for (let y = by; y < endY; y++) {
        for (let x = bx; x < endX; x++) {
          const i = (y * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = lut[d[i]];
        }
      }
    }
  }
  return img;
}

function otsuThreshold(img: ImageData): ImageData {
  const d = img.data;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(luminance(d, i))]++;
  const total = d.length / 4;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  for (let i = 0; i < d.length; i += 4) {
    const b = luminance(d, i) > threshold ? 255 : 0;
    setGray(d, i, b);
  }
  return img;
}

function adaptiveThreshold(img: ImageData): ImageData {
  // Mean adaptive threshold (block size 31)
  const d = img.data;
  const w = img.width, h = img.height;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = luminance(d, i * 4);

  const blockSize = 31;
  const C = 10; // constant subtracted
  const half = Math.floor(blockSize / 2);

  // Integral image for fast mean computation
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
      const i = (y * w + x) * 4;
      const b = gray[y * w + x] > mean - C ? 255 : 0;
      setGray(d, i, b);
    }
  }
  return img;
}

// ─── Tier 2 — Geometry ──────────────────────────────────────────────────────

function rotateCanvas(img: ImageData, degrees: number): ImageData {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const nw = Math.round(img.width * cos + img.height * sin);
  const nh = Math.round(img.width * sin + img.height * cos);

  const src = toCanvas(img);
  const dst = document.createElement('canvas');
  dst.width = nw;
  dst.height = nh;
  const ctx = dst.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, nw, nh);
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -img.width / 2, -img.height / 2);
  return fromCanvas(dst);
}

function rotate(img: ImageData, degrees: number): ImageData {
  return rotateCanvas(img, degrees);
}

function deskew(img: ImageData): ImageData {
  // Simple projection-profile based deskew: try small angles, pick the one
  // with the strongest horizontal projection variance.
  const gray = toGrayscaleData(img);
  let bestAngle = 0;
  let bestVariance = -1;

  for (let angle = -15; angle <= 15; angle += 0.5) {
    const rotated = rotateCanvas(new ImageData(new Uint8ClampedArray(gray.data), gray.width, gray.height), angle);
    const proj = projectionProfile(rotated, 'horizontal');
    const variance = computeVariance(proj);
    if (variance > bestVariance) {
      bestVariance = variance;
      bestAngle = angle;
    }
  }

  if (Math.abs(bestAngle) < 0.5) return img; // already straight
  return rotate(img, bestAngle);
}

function projectionProfile(img: ImageData, direction: 'horizontal' | 'vertical'): number[] {
  const { width: w, height: h, data } = img;
  if (direction === 'horizontal') {
    const profile = new Array<number>(h).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        profile[y] += data[(y * w + x) * 4] < 128 ? 1 : 0;
      }
    }
    return profile;
  } else {
    const profile = new Array<number>(w).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        profile[x] += data[(y * w + x) * 4] < 128 ? 1 : 0;
      }
    }
    return profile;
  }
}

function computeVariance(arr: number[]): number {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, v) => a + (v - mean) ** 2, 0) / arr.length;
}

function perspectiveCorrection(img: ImageData): ImageData {
  // Simple 4-point perspective correction: detect edges, estimate quadrilateral
  // For a practical browser implementation, we apply a slight transform
  const edges = sobelXRaw(img);
  const hough = detectLineOrientation(edges);
  if (Math.abs(hough) < 1) return img;
  return rotate(img, hough);
}

function detectLineOrientation(edges: ImageData): number {
  // Simplified Hough: find dominant angle from edge pixels
  const { width: w, height: h, data } = edges;
  const angles = new Map<number, number>();
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (data[(y * w + x) * 4] > 128) {
        // Check horizontal neighbors for angle
        for (let dx = 4; dx < 20; dx += 2) {
          const nx = x + dx;
          if (nx < w && data[(y * w + nx) * 4] > 128) {
            const angle = Math.round(Math.atan2(0, dx) * 180 / Math.PI);
            angles.set(angle, (angles.get(angle) || 0) + 1);
          }
        }
      }
    }
  }
  let bestAngle = 0, bestCount = 0;
  for (const [angle, count] of angles) {
    if (count > bestCount) { bestCount = count; bestAngle = angle; }
  }
  return bestAngle;
}

function autoRoi(img: ImageData): ImageData {
  // Detect the most likely barcode region using horizontal projection
  const gray = grayscale(clone(img));
  const d = gray.data;
  const w = gray.width, h = gray.height;

  // Binary threshold
  for (let i = 0; i < d.length; i += 4) {
    setGray(d, i, d[i] < 128 ? 0 : 255);
  }

  // Horizontal projection: count dark pixels per row
  const rowDensity = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] === 0) count++;
    }
    rowDensity[y] = count / w;
  }

  // Find the band with highest density variation (barcode region)
  const bandSize = Math.max(20, Math.floor(h * 0.05));
  let bestStart = 0, bestScore = -1;
  for (let y = 0; y < h - bandSize; y++) {
    let bandMean = 0;
    for (let i = y; i < y + bandSize; i++) bandMean += rowDensity[i];
    bandMean /= bandSize;
    let score = 0;
    for (let i = y; i < y + bandSize; i++) score += (rowDensity[i] - bandMean) ** 2;
    if (score > bestScore) { bestScore = score; bestStart = y; }
  }

  const pad = 10;
  const y1 = Math.max(0, bestStart - pad);
  const y2 = Math.min(h, bestStart + bandSize + pad);

  // Crop
  const out = document.createElement('canvas');
  out.width = w;
  out.height = y2 - y1;
  const ctx = out.getContext('2d')!;
  const src = toCanvas(img);
  ctx.drawImage(src, 0, y1, w, y2 - y1, 0, 0, w, y2 - y1);
  return fromCanvas(out);
}

function barcodeCrop(img: ImageData): ImageData {
  // Similar to auto_roi but also tries vertical detection
  return autoRoi(img);
}

// ─── Tier 3 — Advanced ──────────────────────────────────────────────────────

function morphClose(img: ImageData): ImageData {
  // Dilate then Erode with horizontal structuring element
  const dilated = dilate(img, 3, 1);
  return erode(dilated, 3, 1);
}

function horizontalMorphology(img: ImageData): ImageData {
  // Horizontal dilation + closing (helps connect barcode bars)
  const dilated = dilate(img, 5, 1);
  return dilate(dilated, 5, 1);
}

function dilate(img: ImageData, kernelW: number, kernelH: number): ImageData {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data);
  const halfW = Math.floor(kernelW / 2);
  const halfH = Math.floor(kernelH / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let maxVal = 0;
      for (let dy = -halfH; dy <= halfH; dy++) {
        for (let dx = -halfW; dx <= halfW; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            maxVal = Math.max(maxVal, data[(ny * w + nx) * 4]);
          }
        }
      }
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = maxVal;
    }
  }
  return new ImageData(out, w, h);
}

function erode(img: ImageData, kernelW: number, kernelH: number): ImageData {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data);
  const halfW = Math.floor(kernelW / 2);
  const halfH = Math.floor(kernelH / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let minVal = 255;
      for (let dy = -halfH; dy <= halfH; dy++) {
        for (let dx = -halfW; dx <= halfW; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            minVal = Math.min(minVal, data[(ny * w + nx) * 4]);
          }
        }
      }
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = minVal;
    }
  }
  return new ImageData(out, w, h);
}

function sobelXRaw(img: ImageData): ImageData {
  const { width: w, height: h, data } = img;
  const gray = grayscale(clone(img));
  const d = gray.data;
  const out = new Uint8ClampedArray(d.length);
  const kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let acc = 0, ki = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, ki++) {
          acc += d[((y + dy) * w + (x + dx)) * 4] * kx[ki];
        }
      }
      const i = (y * w + x) * 4;
      const v = Math.min(255, Math.abs(acc));
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return new ImageData(out, w, h);
}

function sobelX(img: ImageData): ImageData {
  const result = sobelXRaw(img);
  // Apply Otsu to clean up
  return otsuThreshold(result);
}

function blackHat(img: ImageData): ImageData {
  // Black hat = close - original (reveals dark features)
  const closed = morphClose(grayscale(clone(img)));
  const orig = grayscale(clone(img));
  const d = orig.data;
  const c = closed.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, c[i] - d[i]);
    setGray(d, i, v);
  }
  return orig;
}

function denoise(img: ImageData): ImageData {
  // Median filter (3x3)
  const { width: w, height: h, data } = img;
  const gray = grayscale(clone(img));
  const d = gray.data;
  const out = new Uint8ClampedArray(d);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const neighbors: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          neighbors.push(d[((y + dy) * w + (x + dx)) * 4]);
        }
      }
      neighbors.sort((a, b) => a - b);
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = neighbors[4]; // median of 9
    }
  }
  return new ImageData(out, w, h);
}

function sauvolaThreshold(img: ImageData): ImageData {
  // Sauvola adaptive threshold
  const d = img.data;
  const w = img.width, h = img.height;
  const blockSize = 31;
  const k = 0.2, R = 128;
  const half = Math.floor(blockSize / 2);

  // Integral image + integral of squared image
  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = d[i * 4];

  const integral = new Float64Array(w * h);
  const integralSq = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let rowSum = 0, rowSumSq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rowSum += v;
      rowSumSq += v * v;
      integral[y * w + x] = rowSum + (y > 0 ? integral[(y - 1) * w + x] : 0);
      integralSq[y * w + x] = rowSumSq + (y > 0 ? integralSq[(y - 1) * w + x] : 0);
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const count = (y2 - y1 + 1) * (x2 - x1 + 1);
      let sum = integral[y2 * w + x2];
      let sumSq = integralSq[y2 * w + x2];
      if (y1 > 0) { sum -= integral[(y1 - 1) * w + x2]; sumSq -= integralSq[(y1 - 1) * w + x2]; }
      if (x1 > 0) { sum -= integral[y2 * w + (x1 - 1)]; sumSq -= integralSq[y2 * w + (x1 - 1)]; }
      if (y1 > 0 && x1 > 0) { sum += integral[(y1 - 1) * w + (x1 - 1)]; sumSq += integralSq[(y1 - 1) * w + (x1 - 1)]; }
      const mean = sum / count;
      const variance = sumSq / count - mean * mean;
      const stddev = Math.sqrt(Math.max(0, variance));
      const threshold = mean * (1 + k * (stddev / R - 1));
      const i = (y * w + x) * 4;
      const b = d[i] > threshold ? 255 : 0;
      setGray(d, i, b);
    }
  }
  return img;
}

function niblackThreshold(img: ImageData): ImageData {
  // Niblack adaptive threshold
  const d = img.data;
  const w = img.width, h = img.height;
  const blockSize = 31;
  const k = -0.2;
  const half = Math.floor(blockSize / 2);

  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = d[i * 4];

  const integral = new Float64Array(w * h);
  const integralSq = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let rowSum = 0, rowSumSq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rowSum += v; rowSumSq += v * v;
      integral[y * w + x] = rowSum + (y > 0 ? integral[(y - 1) * w + x] : 0);
      integralSq[y * w + x] = rowSumSq + (y > 0 ? integralSq[(y - 1) * w + x] : 0);
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const count = (y2 - y1 + 1) * (x2 - x1 + 1);
      let sum = integral[y2 * w + x2];
      let sumSq = integralSq[y2 * w + x2];
      if (y1 > 0) { sum -= integral[(y1 - 1) * w + x2]; sumSq -= integralSq[(y1 - 1) * w + x2]; }
      if (x1 > 0) { sum -= integral[y2 * w + (x1 - 1)]; sumSq -= integralSq[y2 * w + (x1 - 1)]; }
      if (y1 > 0 && x1 > 0) { sum += integral[(y1 - 1) * w + (x1 - 1)]; sumSq += integralSq[(y1 - 1) * w + (x1 - 1)]; }
      const mean = sum / count;
      const stddev = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
      const threshold = mean + k * stddev;
      const i = (y * w + x) * 4;
      const b = d[i] > threshold ? 255 : 0;
      setGray(d, i, b);
    }
  }
  return img;
}

function autoPolarity(img: ImageData): ImageData {
  // Determine if barcode is dark-on-light or light-on-dark, and flip if needed
  const d = img.data;
  const w = img.width, h = img.height;
  const gray = grayscale(clone(img));
  const gd = gray.data;

  let darkCount = 0, lightCount = 0;
  for (let i = 0; i < gd.length; i += 4) {
    if (gd[i] < 128) darkCount++;
    else lightCount++;
  }

  // If more dark than light (light-on-dark barcode), invert
  if (darkCount > lightCount) {
    for (let i = 0; i < gd.length; i += 4) {
      setGray(gd, i, 255 - gd[i]);
    }
  }
  return gray;
}

// ─── Tier 5 — Full AUTO Pipeline ────────────────────────────────────────────

function fullAutoPipeline(img: ImageData): ImageData {
  // Step 1: Grayscale
  let current = grayscale(clone(img));
  // Step 2: Denoise
  current = denoise(current);
  // Step 3: Auto polarity
  current = autoPolarity(current);
  // Step 4: Auto ROI
  current = autoRoi(current);
  // Step 5: CLAHE for contrast
  current = clahe(current);
  // Step 6: Deskew
  current = deskew(current);
  // Step 7: Adaptive threshold for clean binary
  current = adaptiveThreshold(current);
  return current;
}

function upscale(img: ImageData, factor: number): ImageData {
  const w = img.width;
  const h = img.height;
  const nw = Math.round(w * factor);
  const nh = Math.round(h * factor);
  const out = new ImageData(nw, nh);
  const src = img.data;
  const dst = out.data;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / factor));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / factor));
      const si = (sy * w + sx) * 4;
      const di = (y * nw + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return out;
}

// ─── Canvas conversion utilities ─────────────────────────────────────────────

function toCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

function fromCanvas(c: HTMLCanvasElement): ImageData {
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
}

function toGrayscaleData(img: ImageData): ImageData {
  return grayscale(clone(img));
}
