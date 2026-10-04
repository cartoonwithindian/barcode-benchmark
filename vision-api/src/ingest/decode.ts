/**
 * Decoding of a downloaded image into an RGBA raster the pipelines operate on.
 *
 * Responsibilities:
 *  - reject corrupt / unsupported payloads,
 *  - enforce dimension + total-pixel limits *before* full decode
 *    (decompression-bomb protection),
 *  - apply EXIF orientation exactly once (`sharp.rotate()` with no argument),
 *  - strip metadata from the pixel pipeline (no EXIF is carried into OCR),
 *  - downscale very large images to a working resolution so cost stays bounded.
 */
import sharp from 'sharp';
import type { AppConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { globalMetrics } from '../core/metrics.js';
import { sniffImageFormat, type SupportedFormat } from './downloader.js';
import type { Raster } from '../imaging/raster.js';

/**
 * Default cap for the raster handed to the engines.
 *
 * Every preprocessing variant is a full-width RGBA copy, so this is the single
 * biggest multiplier on memory: 2200px costs 19.4 MB per variant, 1600px costs
 * 10.2 MB. It is also a large multiplier on latency - measured ZXing-C++ decode
 * times were 858 ms at 2200px and 189 ms at 1600px on the same image.
 *
 * Overridable via `WORKING_MAX_DIMENSION` so a small-RAM host can trade a little
 * decode resolution for headroom; see `docs/OPERATIONS.md` for the measurements.
 */
const DEFAULT_WORKING_MAX_DIMENSION = 2200;

export interface DecodedImage {
  raster: Raster;
  /** Dimensions after EXIF orientation has been applied. */
  width: number;
  height: number;
  format: SupportedFormat;
  /** Dimensions as stored in the file, before orientation. */
  sourceWidth: number;
  sourceHeight: number;
  orientationApplied: boolean;
  /** Original file size in bytes. */
  byteSize: number;
  /** Set when the source was larger than the working resolution. */
  downscaled: boolean;
  bytesPerPixel: number;
  /** megapixel estimate, useful for diagnostics and budgeting. */
  megapixels: number;
}

sharp.cache(false);
sharp.concurrency(1);

export async function decodeImage(buffer: Buffer, config: AppConfig): Promise<DecodedImage> {
  const format = sniffImageFormat(buffer);
  if (!format) {
    globalMetrics.increment('invalid_image_total');
    throw new AppError(ErrorCode.INVALID_IMAGE, 'The provided file is not a supported image.');
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer, {
      limitInputPixels: config.ingest.maxImagePixels,
      failOn: 'error',
    }).metadata();
  } catch (err) {
    globalMetrics.increment('invalid_image_total');
    throw new AppError(ErrorCode.INVALID_IMAGE, 'The image could not be decoded (corrupt or unsupported file).', {
      details: { reason: err instanceof Error ? err.message : String(err) },
      cause: err,
    });
  }

  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (!sourceWidth || !sourceHeight) {
    globalMetrics.increment('invalid_image_total');
    throw new AppError(ErrorCode.INVALID_IMAGE, 'The image has no readable dimensions.');
  }

  if (Math.max(sourceWidth, sourceHeight) > config.ingest.maxImageDimension) {
    globalMetrics.increment('image_too_large_total');
    throw new AppError(
      ErrorCode.IMAGE_TOO_LARGE,
      'The image dimensions exceed the maximum supported size.',
      { details: { width: sourceWidth, height: sourceHeight, max_dimension: config.ingest.maxImageDimension } },
    );
  }

  const pixels = sourceWidth * sourceHeight;
  if (pixels > config.ingest.maxImagePixels) {
    globalMetrics.increment('image_too_large_total');
    throw new AppError(ErrorCode.IMAGE_TOO_LARGE, 'The image pixel count exceeds the maximum supported size.', {
      details: { pixels, max_pixels: config.ingest.maxImagePixels },
    });
  }

  const workingMax = Math.min(config.ingest.maxImageDimension, config.ingest.workingMaxDimension);
  const needsDownscale = Math.max(sourceWidth, sourceHeight) > workingMax;
  let pipeline: sharp.Sharp;
  try {
    pipeline = sharp(buffer, {
      limitInputPixels: config.ingest.maxImagePixels,
      failOn: 'error',
      // Honour EXIF orientation: this rotates/flips so that downstream pixel
      // coordinates match what a human sees.
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: workingMax,
        height: workingMax,
        fit: 'inside',
        withoutEnlargement: true,
      })
      // Drop EXIF/IPTC/XMP: only pixels are needed downstream.
      .withMetadata({ orientation: undefined })
      .toColorspace('srgb');
  } catch (err) {
    globalMetrics.increment('invalid_image_total');
    throw new AppError(ErrorCode.INVALID_IMAGE, 'The image could not be normalised.', {
      details: { reason: err instanceof Error ? err.message : String(err) },
      cause: err,
    });
  }

  let raw: Buffer;
  let info: sharp.OutputInfo;
  try {
    const result = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    raw = result.data;
    info = result.info;
  } catch (err) {
    globalMetrics.increment('invalid_image_total');
    throw new AppError(ErrorCode.INVALID_IMAGE, 'The image pixels could not be read.', {
      details: { reason: err instanceof Error ? err.message : String(err) },
      cause: err,
    });
  }

  if (info.channels !== 4) {
    // ensureAlpha should always give 4 channels; defensive re-pack.
    raw = await sharp(raw, { raw: { width: info.width, height: info.height, channels: info.channels as 1 | 2 | 3 | 4 } })
      .ensureAlpha()
      .raw()
      .toBuffer();
  }

  const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset, info.width * info.height * 4);
  const raster: Raster = { width: info.width, height: info.height, data };

  return {
    raster,
    width: info.width,
    height: info.height,
    format,
    sourceWidth,
    sourceHeight,
    orientationApplied: (metadata.orientation ?? 1) !== 1,
    byteSize: buffer.length,
    downscaled: needsDownscale,
    bytesPerPixel: info.width * info.height > 0 ? buffer.length / (info.width * info.height) : 0,
    megapixels: Number(((info.width * info.height) / 1_000_000).toFixed(3)),
  };
}

/** Re-encodes a raster back to an encoded image (used to hand variants to WASM engines that prefer PNG). */
export async function rasterToPng(raster: Raster): Promise<Buffer> {
  return sharp(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength), {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .png({ compressionLevel: 3 })
    .toBuffer();
}