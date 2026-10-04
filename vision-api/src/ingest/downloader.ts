/**
 * SSRF-hardened image downloader.
 *
 * Guarantees:
 *  - redirects are followed manually, and every hop is re-validated,
 *  - the resolved IP is re-checked inside the socket `lookup` hook (no DNS
 *    rebinding window),
 *  - responses are streamed with a hard byte cap (no unbounded buffering),
 *  - total wall-clock deadline, plus connect / header timeouts,
 *  - content type must be an allowed image type and the bytes must actually
 *    sniff as an image,
 *  - nothing is written to disk; the buffer lives only for the request.
 */
import { sinceMs } from '../core/async.js';
import { Agent, request } from 'undici';
import type { AppConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { globalMetrics } from '../core/metrics.js';
import { createPinnedLookup, validateImageUrl } from './urlPolicy.js';

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/tiff',
  'image/heic',
  'image/heif',
  'application/octet-stream', // tolerated: the byte sniff is authoritative
]);

/** Formats the pipeline can actually decode (sharp/libvips). */
export const SUPPORTED_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff', 'bmp', 'heif'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/** Magic byte sniffing — the content type header is never trusted on its own. */
export function sniffImageFormat(buffer: Buffer): SupportedFormat | null {
  if (buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  // WEBP: "RIFF" .... "WEBP"
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  // GIF: "GIF87a"/"GIF89a"
  const gif = buffer.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  // BMP: "BM"
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  // AVIF / HEIF: ftyp box
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis') || brand === 'mif1' || brand === 'heic' || brand === 'heix' || brand === 'mif2') {
      return brand.startsWith('avif') || brand.startsWith('avis') ? 'avif' : 'heif';
    }
  }
  // TIFF: II*\0 or MM\0*
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) {
    return 'tiff';
  }
  return null;
}

export interface DownloadedImage {
  buffer: Buffer;
  contentType: string | null;
  /** Redacted URL (no query string) for logs and diagnostics. */
  sourceTag: string;
  finalUrl: string;
  bytes: number;
  elapsedMs: number;
}

export interface DownloadOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

function buildAgent(config: AppConfig, hostname: string): Agent {
  return new Agent({
    connect: {
      // undici types: `lookup` is `net.LookupFunction`; our pinned variant is
      // compatible but needs a cast.
      lookup: createPinnedLookup(config, hostname) as never,
      timeout: Math.min(10_000, config.ingest.downloadTimeoutMs),
    },
    headersTimeout: Math.min(15_000, config.ingest.downloadTimeoutMs),
    bodyTimeout: Math.min(20_000, config.ingest.downloadTimeoutMs),
    keepAliveTimeout: 5_000,
    // undici 7 removed `maxRedirections`; redirects are followed manually by
    // `downloadImage` so every hop can be re-validated against the IP policy.
  });
}

export async function downloadImage(
  imageUrl: string,
  config: AppConfig,
  options: DownloadOptions = {},
): Promise<DownloadedImage> {
  const startedAt = process.hrtime.bigint();
  const timeoutMs = options.timeoutMs ?? config.ingest.downloadTimeoutMs;
  const maxBytes = options.maxBytes ?? config.ingest.downloadMaxBytes;
  const userAgent = options.userAgent ?? 'FoodGuardVisionAPI/1.0 (+https://github.com/cartoonwithindian/foodguard)';

  let currentUrl = imageUrl;
  let hops = 0;

  for (;;) {
    let validated;
    try {
      validated = await validateImageUrl(currentUrl, config);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.BLOCKED_URL) globalMetrics.increment('download_blocked_total');
      throw err;
    }

    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());

    let response;
    const agent = buildAgent(config, validated.hostname);
    try {
      response = await request(currentUrl, {
        method: 'GET',
        dispatcher: agent,
        headers: {
          accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8,*/*;q=0.5',
          'accept-encoding': 'identity',
          'user-agent': userAgent,
        },
        signal: AbortSignal.timeout(remaining()),
      });
    } catch (err) {
      globalMetrics.increment('download_failed_total');
      const aborted = err instanceof Error && (err.name === 'TimeoutError' || (err as NodeJS.ErrnoException).code === 'UND_ERR_HEADERS_TIMEOUT');
      throw new AppError(
        aborted ? ErrorCode.DOWNLOAD_TIMEOUT : ErrorCode.DOWNLOAD_FAILED,
        aborted ? 'Timed out while downloading the image.' : 'Failed to download the image.',
        { details: { host: validated.hostname, reason: err instanceof Error ? err.message : String(err) }, cause: err },
      );
    }

    const status = response.statusCode;
    const location = response.headers.location;
    const contentType = typeof response.headers['content-type'] === 'string' ? (response.headers['content-type'] as string) : null;

    if (status >= 300 && status < 400 && location) {
      await response.body.dump().catch(() => undefined);
      await agent.close().catch(() => undefined);
      if (hops >= config.ingest.maxRedirects) {
        throw new AppError(ErrorCode.DOWNLOAD_FAILED, 'Too many redirects while downloading the image.');
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new AppError(ErrorCode.DOWNLOAD_FAILED, 'The image server returned an invalid redirect target.');
      }
      hops += 1;
      currentUrl = next.href;
      continue;
    }

    if (status < 200 || status >= 300) {
      await response.body.dump().catch(() => undefined);
      await agent.close().catch(() => undefined);
      globalMetrics.increment('download_failed_total');
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, 'The image could not be downloaded from the provided URL.', {
        details: { status },
      });
    }

    const declaredLength = Number(response.headers['content-length'] ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body.dump().catch(() => undefined);
      await agent.close().catch(() => undefined);
      throw new AppError(ErrorCode.DOWNLOAD_TOO_LARGE, 'The image exceeds the maximum allowed download size.', {
        details: { declared_bytes: declaredLength, max_bytes: maxBytes },
      });
    }

    if (contentType) {
      const baseType = contentType.split(';')[0]!.trim().toLowerCase();
      if (!baseType.startsWith('image/') && !ALLOWED_CONTENT_TYPES.has(baseType)) {
        await response.body.dump().catch(() => undefined);
        await agent.close().catch(() => undefined);
        throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'The URL did not return a supported image file.', {
          details: { content_type: baseType },
        });
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (total > maxBytes) {
          throw new AppError(ErrorCode.DOWNLOAD_TOO_LARGE, 'The image exceeds the maximum allowed download size.', {
            details: { max_bytes: maxBytes },
          });
        }
        chunks.push(buf);
      }
    } catch (err) {
      if (err instanceof AppError) {
        globalMetrics.increment('download_failed_total');
        throw err;
      }
      globalMetrics.increment('download_failed_total');
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, 'The image download was interrupted.', {
        details: { reason: err instanceof Error ? err.message : String(err) },
        cause: err,
      });
    } finally {
      await agent.close().catch(() => undefined);
    }

    const buffer = Buffer.concat(chunks, total);
    const format = sniffImageFormat(buffer);
    if (!format) {
      globalMetrics.increment('invalid_image_total');
      throw new AppError(ErrorCode.INVALID_IMAGE, 'The downloaded file is not a readable image.');
    }

    const elapsedMs = sinceMs(startedAt);
    const sourceTag = (() => {
      try {
        const u = new URL(currentUrl);
        return `${u.protocol}//${u.host}${u.pathname}`;
      } catch {
        return '[unparseable-url]';
      }
    })();

    return { buffer, contentType, sourceTag, finalUrl: currentUrl, bytes: total, elapsedMs };
  }
}