/**
 * ZXing (TypeScript port) adapter — `@zxing/library`.
 *
 * This is the "ZXing" engine of the benchmark registry, minus `@zxing/browser`
 * (which is only a camera/file helper). Decoding is done straight from a
 * luminance buffer through `RGBLuminanceSource` + `HybridBinarizer`, so no DOM
 * and no canvas are required.
 *
 * Two behavioural differences from the browser adapter were necessary:
 *
 *  1. The browser adapter used `MultiFormatReader`, which on a miss logs a wall
 *     of `MultiFormatReader: non-ReaderException from reader: ...` noise and can
 *     abort the whole decode when an early reader throws (observed with
 *     MaxiCode/Aztec on plain EAN photos). Here every symbology gets its own
 *     reader instance, so one throwing reader cannot suppress a later one.
 *  2. Console noise is muted for the duration of the decode; @zxing/library
 *     writes directly to `console.log`, which would corrupt structured logs.
 *
 * Measured capability on this deployment (documented honestly, not asserted):
 * reliable on Code 128 and the 2D symbologies; its 1D retail decode (EAN-13 on
 * real product photos) is weaker than ZXing-C++/ZBar, so it is registered as a
 * secondary opinion rather than a primary engine.
 */
import { Mutex, sinceMs } from '../../core/async.js';
import { globalMetrics } from '../../core/metrics.js';
import { BarcodeScannerAdapter, type DecodeOptions } from '../adapter.js';
import type { BarcodeFormatName, BarcodePoint, BarcodeResult } from '../types.js';
import type { Raster } from '../../imaging/raster.js';
import { toLuminancePlane } from '../../imaging/raster.js';

/** One entry per canonical format -> the @zxing/library reader that decodes it. */
interface ReaderEntry {
  canonical: BarcodeFormatName;
  ctorName: string;
  oneD: boolean;
}

/**
 * @zxing/library has no EAN-8 reader; EAN-8 is handled by the multi-format 1D
 * reader, which is why `MultiFormatOneDReader` is registered for it.
 */
const READERS: ReaderEntry[] = [
  { canonical: 'EAN-13', ctorName: 'EAN13Reader', oneD: true },
  { canonical: 'EAN-8', ctorName: 'MultiFormatOneDReader', oneD: true },
  { canonical: 'UPC-A', ctorName: 'UPCAReader', oneD: true },
  { canonical: 'UPC-E', ctorName: 'UPCEReader', oneD: true },
  { canonical: 'Code 128', ctorName: 'Code128Reader', oneD: true },
  { canonical: 'Code 39', ctorName: 'Code39Reader', oneD: true },
  { canonical: 'Code 93', ctorName: 'Code93Reader', oneD: true },
  { canonical: 'ITF', ctorName: 'ITFReader', oneD: true },
  { canonical: 'Codabar', ctorName: 'CodaBarReader', oneD: true },
  { canonical: 'QR Code', ctorName: 'QRCodeReader', oneD: false },
  { canonical: 'Data Matrix', ctorName: 'DataMatrixReader', oneD: false },
  { canonical: 'PDF417', ctorName: 'PDF417Reader', oneD: false },
  { canonical: 'Aztec', ctorName: 'AztecCodeReader', oneD: false },
];

interface ZxingModule {
  MultiFormatOneDReader: new () => ReaderLike;
  EAN13Reader: new () => ReaderLike;
  UPCAReader: new () => ReaderLike;
  UPCEReader: new () => ReaderLike;
  Code128Reader: new () => ReaderLike;
  Code39Reader: new () => ReaderLike;
  Code93Reader: new () => ReaderLike;
  ITFReader: new () => ReaderLike;
  CodaBarReader: new () => ReaderLike;
  QRCodeReader: new () => ReaderLike;
  DataMatrixReader: new () => ReaderLike;
  PDF417Reader: new () => ReaderLike;
  AztecCodeReader: new () => ReaderLike;
  RGBLuminanceSource: new (data: Uint8ClampedArray, width: number, height: number) => unknown;
  HybridBinarizer: new (source: unknown) => unknown;
  GlobalHistogramBinarizer: new (source: unknown) => unknown;
  BinaryBitmap: new (binarizer: unknown) => unknown;
  DecodeHintType: { TRY_HARDER: unknown; POSSIBLE_FORMATS: unknown };
  BarcodeFormat: Record<string, unknown>;
}

interface ReaderLike {
  decode(bitmap: unknown): { getText(): string; getBarcodeFormat(): unknown; getResultPoints(): Array<{ getX(): number; getY(): number }> };
  setHints?(hints: Map<unknown, unknown>): void;
}

export class ZxingTsAdapter extends BarcodeScannerAdapter {
  override getName(): string {
    return 'ZXing-TS';
  }

  override isAvailable(): boolean {
    return typeof WebAssembly === 'undefined' || true; // pure TypeScript, always available
  }

  override getSupportedFormats(): BarcodeFormatName[] {
    return READERS.map((r) => r.canonical);
  }

  private readonly initMutex = new Mutex();
  private module: ZxingModule | null = null;
  private initError: string | null = null;

  override async initialise(): Promise<void> {
    if (this.module) return;
    await this.initMutex.run(async () => {
      if (this.module) return;
      try {
        this.module = (await import('@zxing/library')) as unknown as ZxingModule;
      } catch (err) {
        this.initError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    });
  }

  override getStatus() {
    if (this.module) return 'available' as const;
    if (this.initError) return 'failed' as const;
    return 'available' as const;
  }

  /** Runs `fn` with console.log muted (zxing logs reader exceptions directly). */
  private static muted<T>(fn: () => T): T {
    const original = console.log;
    console.log = () => undefined;
    try {
      return fn();
    } finally {
      console.log = original;
    }
  }

  override async decode(image: Raster, options: DecodeOptions = {}): Promise<BarcodeResult[]> {
    this.recordAttempt();
    const startedAt = process.hrtime.bigint();
    try {
      await this.initialise();
      const zx = this.module;
      if (!zx) return [];

      const plane = toLuminancePlane(image);
      const luminance = new Uint8ClampedArray(plane);
      const source = new zx.RGBLuminanceSource(luminance, image.width, image.height);
      const hybrid = new zx.BinaryBitmap(new zx.HybridBinarizer(source));
      const globalHistogram = new zx.BinaryBitmap(new zx.GlobalHistogramBinarizer(source));

      const wanted = options.formats?.length ? new Set(options.formats) : null;
      const results: BarcodeResult[] = [];
      const seen = new Set<string>();

      for (const entry of READERS) {
        if (wanted && !wanted.has(entry.canonical)) continue;
        const Ctor = (zx as unknown as Record<string, new () => ReaderLike>)[entry.ctorName];
        if (typeof Ctor !== 'function') continue;

        // Global-histogram binarisation recovers high-contrast barcodes that the
        // local (hybrid) binariser flattens on unevenly lit photos.
        const bitmaps = entry.oneD ? [hybrid, globalHistogram] : [hybrid];
        for (const bitmap of bitmaps) {
          let decoded: { getText(): string; getResultPoints(): Array<{ getX(): number; getY(): number }> } | null = null;
          try {
            decoded = ZxingTsAdapter.muted(() => {
              const reader = new Ctor();
              try {
                reader.setHints?.(new Map([[zx.DecodeHintType.TRY_HARDER, true]]));
              } catch {
                /* reader does not accept hints */
              }
              return reader.decode(bitmap);
            });
          } catch {
            decoded = null; // NotFoundException / ChecksumException / FormatException
          }
          if (!decoded) continue;
          const value = decoded.getText();
          if (!value || seen.has(value)) continue;
          seen.add(value);
          const points: BarcodePoint[] | undefined = decoded.getResultPoints()?.length
            ? decoded.getResultPoints().map((p) => ({ x: p.getX(), y: p.getY() }))
            : undefined;
          results.push({
            value,
            format: entry.canonical,
            points,
            boundingBox: this.computeBoundingBox(points),
            decodeTimeMs: 0,
            engine: this.getName(),
            variant: '',
            engineConfidence: null,
          });
        }
      }

      const decodeTimeMs = sinceMs(startedAt);
      for (const r of results) r.decodeTimeMs = decodeTimeMs;
      globalMetrics.observe('barcode_decode_zxing_ts', decodeTimeMs);
      return results;
    } catch (err) {
      this.recordError(err);
      return [];
    }
  }
}