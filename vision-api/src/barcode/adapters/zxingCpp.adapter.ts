/**
 * ZXing-C++ adapter (WASM).
 *
 * Ported from `barcode-benchmark/src/app/core/barcode/adapters/zxing-wasm.adapter.ts`.
 *
 * The browser adapter had to copy `zxing_reader.wasm` into an asset folder and
 * override `locateFile`. Server-side the module resolves the binary next to its
 * own ESM entry, so the override disappears; the decode logic, the format map
 * and the `tryHarder` flag are unchanged.
 *
 * Benchmark note: in `barcode-benchmark-1787709460337.json` ZXing-C++ produced
 * 836 of the 2071 decode attempts and had the highest hit rate of any engine,
 * which is why this adapter leads the engine order.
 */
import { Mutex, sinceMs } from '../../core/async.js';
import { globalMetrics } from '../../core/metrics.js';
import { BarcodeScannerAdapter, type DecodeOptions } from '../adapter.js';
import { ZXING_CPP_FORMAT_MAP } from '../formats.js';
import type { BarcodeFormatName, BarcodePoint, BarcodeResult } from '../types.js';
import type { Raster } from '../../imaging/raster.js';

/** Formats requested from zxing-wasm, in the benchmark's priority order for retail packs. */
const REQUESTED_FORMATS = [
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
  'Code128',
  'Code39',
  'Code93',
  'ITF',
  'Codabar',
  'QRCode',
  'DataMatrix',
  'PDF417',
  'Aztec',
] as const;

const CANONICAL_TO_ZXING = new Map<string, string>(
  Object.entries(ZXING_CPP_FORMAT_MAP)
    .filter(([canonical]) => canonical !== 'UNKNOWN')
    .map(([zxing, canonical]) => [canonical, zxing]),
);

interface ZxingResult {
  text: string;
  format: string;
  position?: { topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomRight: { x: number; y: number }; bottomLeft: { x: number; y: number } };
  error?: string;
}

type ReaderModule = { readBarcodes: (image: unknown, options?: unknown) => Promise<ZxingResult[]> };

export class ZxingCppAdapter extends BarcodeScannerAdapter {
  override getName(): string {
    return 'ZXing-C++';
  }

  override isAvailable(): boolean {
    return typeof WebAssembly !== 'undefined';
  }

  override getSupportedFormats(): BarcodeFormatName[] {
    return [...new Set(Object.values(ZXING_CPP_FORMAT_MAP))].filter((f) => f !== 'UNKNOWN');
  }

  private readonly initMutex = new Mutex();
  private module: ReaderModule | null = null;
  private initError: string | null = null;

  override async initialise(): Promise<void> {
    if (this.module) return;
    await this.initMutex.run(async () => {
      if (this.module) return;
      try {
        this.module = (await import('zxing-wasm/reader')) as unknown as ReaderModule;
      } catch (err) {
        this.initError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    });
  }

  override getStatus() {
    if (this.module) return 'available' as const;
    if (this.initError) return 'failed' as const;
    return this.isAvailable() ? ('available' as const) : ('platform_unsupported' as const);
  }

  override async decode(image: Raster, options: DecodeOptions = {}): Promise<BarcodeResult[]> {
    this.recordAttempt();
    const startedAt = process.hrtime.bigint();
    try {
      await this.initialise();
      const mod = this.module;
      if (!mod) return [];

      const wanted = options.formats?.length
        ? options.formats.map((f) => CANONICAL_TO_ZXING.get(f)).filter((v): v is string => Boolean(v))
        : [...REQUESTED_FORMATS];

      const results = await mod.readBarcodes(
        { data: image.data, width: image.width, height: image.height },
        {
          tryHarder: options.tryHarder ?? true,
          tryRotate: true,
          tryInvert: true,
          tryDownscale: true,
          formats: wanted,
        },
      );
      const decodeTimeMs = sinceMs(startedAt);

      const mapped: BarcodeResult[] = [];
      for (const r of results) {
        if (!r.text) continue;
        const format = ZXING_CPP_FORMAT_MAP[r.format] ?? 'UNKNOWN';
        const points: BarcodePoint[] | undefined = r.position
          ? [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft].map((p) => ({
              x: p.x,
              y: p.y,
            }))
          : undefined;
        mapped.push({
          value: r.text,
          format,
          points,
          boundingBox: this.computeBoundingBox(points),
          decodeTimeMs,
          engine: this.getName(),
          variant: '',
          // zxing-wasm does not expose a per-result score.
          engineConfidence: null,
        });
      }
      globalMetrics.observe('barcode_decode_zxing_cpp', decodeTimeMs);
      return mapped;
    } catch (err) {
      this.recordError(err);
      return [];
    }
  }
}