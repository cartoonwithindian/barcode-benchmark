import { BarcodeResult, BarcodeFormatName, EngineLifecycleStatus } from './barcode.model';

/** 2D-only formats that should be excluded in barcode-only mode. */
const EXCLUDED_2D_FORMATS: Set<BarcodeFormatName> = new Set([
  'QR Code',
  'Data Matrix',
  'Aztec',
]);

/**
 * Common interface implemented by every barcode engine adapter.
 * Engines are fully isolated behind this interface so a failing engine
 * can never break the others.
 */
export abstract class BarcodeScannerAdapter {
  abstract getName(): string;

  abstract isAvailable(): boolean;

  /** Why an engine is unavailable; null when available. */
  getUnavailableReason(): string | null {
    return this.isAvailable() ? null : `${this.getName()} cannot run in this environment.`;
  }

  abstract getSupportedFormats(): string[];

  getStatus(): EngineLifecycleStatus {
    return this.isAvailable() ? 'available' : 'browser_unsupported';
  }

  abstract initialize(): Promise<void>;

  abstract start(): Promise<void>;

  abstract stop(): Promise<void>;

  /** Scan a single frame. Returns [] when nothing was found. Must never throw. */
  abstract scanFrame(frame: ImageData): Promise<BarcodeResult[]>;

  abstract destroy(): Promise<void>;

  /**
   * Post-process raw results to keep only 1D barcode formats.
   * Filters out QR Code, Data Matrix, Aztec, and other 2D-only formats.
   */
  protected filterBarcodeOnly(results: BarcodeResult[]): BarcodeResult[] {
    return results.filter((r) => !EXCLUDED_2D_FORMATS.has(r.format));
  }
}
