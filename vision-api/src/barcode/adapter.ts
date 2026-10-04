/**
 * Engine adapter contract.
 *
 * Server-side port of `barcode-benchmark/src/app/core/barcode/barcode-scanner.adapter.ts`.
 * The original lifecycle methods (`start`/`stop`/`destroy`) were driven by the
 * Angular scanner page; a stateless HTTP service only needs `initialise` and
 * `decode`. The isolation guarantee is preserved and is the point of the class:
 * one engine throwing can never affect the others.
 */
import type { BarcodeFormatName, BarcodeResult, EngineLifecycleStatus } from './types.js';
import type { Raster } from '../imaging/raster.js';
import { TWO_D_FORMATS } from './types.js';

export interface DecodeOptions {
  /** Restricts the decode to these formats when the engine supports it. */
  formats?: BarcodeFormatName[];
  /** Extra per-engine effort (equivalent to zxing-wasm's `tryHarder`). */
  tryHarder?: boolean;
}

export interface EngineAttemptInfo {
  engine: string;
  variant: string;
  decodeTimeMs: number;
  detected: number;
}

export abstract class BarcodeScannerAdapter {
  abstract getName(): string;

  /** Whether the engine can run in this process at all. */
  abstract isAvailable(): boolean;

  /** Why the engine is unavailable; `null` when available. */
  getUnavailableReason(): string | null {
    return this.isAvailable() ? null : `${this.getName()} cannot run in this environment.`;
  }

  abstract getSupportedFormats(): BarcodeFormatName[];

  getStatus(): EngineLifecycleStatus {
    return this.isAvailable() ? 'available' : 'platform_unsupported';
  }

  /** Load the engine (WASM module, worker, native binding). Must be idempotent. */
  abstract initialise(): Promise<void>;

  /**
   * Decode a single raster. Returns `[]` when nothing was found.
   * MUST NOT throw: engine failures are surfaced through `getLastError()`.
   */
  abstract decode(image: Raster, options?: DecodeOptions): Promise<BarcodeResult[]>;

  /** True when the engine was at least attempted during this request. */
  wasAttempted(): boolean {
    return this.attempted;
  }

  protected attempted = false;
  private lastError: string | null = null;

  getLastError(): string | null {
    return this.lastError;
  }

  protected recordAttempt(): void {
    this.attempted = true;
  }

  protected recordError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  /** 2D-only filter, inherited from the benchmark adapter. */
  protected filterBarcodeOnly(results: BarcodeResult[]): BarcodeResult[] {
    return results.filter((r) => !TWO_D_FORMATS.has(r.format));
  }

  protected computeBoundingBox(points: Array<{ x: number; y: number }> | undefined) {
    if (!points || points.length === 0) return undefined;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
    return { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) };
  }
}