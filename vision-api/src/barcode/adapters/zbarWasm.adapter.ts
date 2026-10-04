/**
 * ZBar (WASM) adapter.
 *
 * Ported from `barcode-benchmark/src/app/core/barcode/adapters/zbar-wasm.adapter.ts`.
 * `scanRGBABuffer` is already a raw-buffer API, so the browser adapter needed no
 * canvas at all and this port is essentially unchanged.
 *
 * Two Node-specific fixes were required and are the reason this file looks
 * different from the original:
 *
 *  1. `zbar.wasm`'s emscripten loader prefers `fetch` when a global `fetch`
 *     exists. Node 18+ has one, so the loader tried to `fetch()` a *filesystem
 *     path* and died with ERR_INVALID_URL. Hiding `globalThis.fetch` for the
 *     duration of the import makes the loader use its `fs` path instead.
 *  2. The same loader installs `process.on('unhandledRejection', throw)`.
 *     In a long-lived server any unrelated stray rejection would kill the
 *     process, so the handlers it adds are removed once the module is ready.
 *
 * ZBar is the independent second opinion on 1D symbologies; it is the engine
 * that produced the second "agreeing" decode in the fusion examples.
 */
import { createRequire } from 'node:module';
import { Mutex, sinceMs } from '../../core/async.js';
import { globalMetrics } from '../../core/metrics.js';
import { BarcodeScannerAdapter, type DecodeOptions } from '../adapter.js';
import { ZBAR_FORMAT_MAP } from '../formats.js';
import type { BarcodeFormatName, BarcodePoint, BarcodeResult } from '../types.js';
import type { Raster } from '../../imaging/raster.js';
import { grayToRaster, toLuminancePlane } from '../../imaging/raster.js';

interface ZbarSymbol {
  decode(): string;
  typeName: string;
  points: Array<{ x: number; y: number }>;
}

interface ZbarModule {
  scanRGBABuffer: (buffer: ArrayBuffer, width: number, height: number) => Promise<ZbarSymbol[]>;
  scanGrayBuffer: (buffer: ArrayBuffer, width: number, height: number) => Promise<ZbarSymbol[]>;
  getDefaultScanner: () => Promise<unknown>;
}

export class ZbarWasmAdapter extends BarcodeScannerAdapter {
  override getName(): string {
    return 'ZBar';
  }

  override isAvailable(): boolean {
    return typeof WebAssembly !== 'undefined';
  }

  override getSupportedFormats(): BarcodeFormatName[] {
    // Only symbols this build actually enables.
    return [...new Set(Object.values(ZBAR_FORMAT_MAP))].filter((f) => f !== 'UNKNOWN');
  }

  private readonly initMutex = new Mutex();
  private module: ZbarModule | null = null;
  private initError: string | null = null;

  override async initialise(): Promise<void> {
    if (this.module) return;
    await this.initMutex.run(async () => {
      if (this.module) return;
      const preUnhandled = process.listeners('unhandledRejection');
      const preUncaught = process.listeners('uncaughtException');
      const realFetch = globalThis.fetch;
      try {
        // See fix (1) in the class docblock.
        (globalThis as { fetch?: typeof fetch }).fetch = undefined as unknown as typeof fetch;
        const mod = (await import('zbar.wasm')) as unknown as ZbarModule;
        // `zbar.wasm/dist/instance` holds the single WASM instance promise.
        const require = createRequire(import.meta.url);
        const instanceModule = require('zbar.wasm/dist/instance.js') as { getInstance: () => Promise<unknown> };
        await instanceModule.getInstance();
        // Touch the default scanner so the WASM heap is ready before first use.
        await mod.getDefaultScanner();
        this.module = mod;
      } catch (err) {
        this.initError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        (globalThis as { fetch?: typeof fetch }).fetch = realFetch;
        // See fix (2) in the class docblock.
        for (const listener of process.listeners('unhandledRejection')) {
          if (!preUnhandled.includes(listener)) process.off('unhandledRejection', listener);
        }
        for (const listener of process.listeners('uncaughtException')) {
          if (!preUncaught.includes(listener)) process.off('uncaughtException', listener);
        }
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

      // ZBar wants luminance data; feeding it a grayscale plane is both faster
      // and more accurate than handing it RGBA, and matches what the benchmark
      // effectively produced with its grayscale preprocessing variants.
      const plane = toLuminancePlane(image);
      const gray = grayToRaster(plane, image.width, image.height);
      const buffer = plane.buffer.slice(plane.byteOffset, plane.byteOffset + plane.byteLength) as ArrayBuffer;

      const symbols = await mod.scanGrayBuffer(buffer, gray.width, gray.height);
      const decodeTimeMs = sinceMs(startedAt);

      const wanted = options.formats ? new Set(options.formats) : null;
      const mapped: BarcodeResult[] = [];
      for (const symbol of symbols) {
        const value = symbol.decode();
        if (!value) continue;
        const format = ZBAR_FORMAT_MAP[symbol.typeName] ?? 'UNKNOWN';
        if (wanted && format !== 'UNKNOWN' && !wanted.has(format)) continue;
        const points: BarcodePoint[] | undefined = symbol.points?.length
          ? symbol.points.map((p) => ({ x: p.x, y: p.y }))
          : undefined;
        mapped.push({
          value,
          format,
          points,
          boundingBox: this.computeBoundingBox(points),
          decodeTimeMs,
          engine: this.getName(),
          variant: '',
          // ZBar exposes no confidence score through this binding.
          engineConfidence: null,
        });
      }
      globalMetrics.observe('barcode_decode_zbar', decodeTimeMs);
      return mapped;
    } catch (err) {
      this.recordError(err);
      return [];
    }
  }
}