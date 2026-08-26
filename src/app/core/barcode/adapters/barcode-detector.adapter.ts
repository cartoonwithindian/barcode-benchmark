import { BarcodeResult, BarcodeFormatName, BarcodePoint } from '../barcode.model';
import { BarcodeScannerAdapter } from '../barcode-scanner.adapter';

const FORMAT_MAP: Record<string, BarcodeFormatName> = {
  ean_8: 'EAN-8',
  ean_13: 'EAN-13',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  code_39: 'Code 39',
  code_93: 'Code 93',
  code_128: 'Code 128',
  itf: 'ITF',
  codabar: 'Codabar',
  qr_code: 'QR Code',
  data_matrix: 'Data Matrix',
  pdf417: 'PDF417',
  aztec: 'Aztec',
};

interface DetectedBarcode {
  rawValue: string;
  format: string;
  boundingBox?: DOMRectReadOnly;
  cornerPoints?: { x: number; y: number }[];
}

/**
 * Browser-native BarcodeDetector API (Chrome/Edge/Android WebView).
 * Availability is feature-detected at runtime — the adapter honestly
 * reports "unavailable" in browsers without the API.
 */
export class BarcodeDetectorAdapter extends BarcodeScannerAdapter {
  private detector: { detect(source: CanvasImageSource | ImageData): Promise<DetectedBarcode[]> } | null =
    null;
  private supportedFormats: string[] = [];

  override getName(): string {
    return 'BarcodeDetector API';
  }

  override isAvailable(): boolean {
    return typeof (globalThis as Record<string, unknown>)['BarcodeDetector'] === 'function';
  }

  override getUnavailableReason(): string | null {
    if (this.isAvailable()) return null;
    return 'The BarcodeDetector API does not exist in this browser (Chromium-only feature).';
  }

  override getSupportedFormats(): string[] {
    return this.supportedFormats.length ? this.supportedFormats : Object.values(FORMAT_MAP);
  }

  override getStatus() {
    if (!this.isAvailable()) return 'browser_unsupported' as const;
    return this.detector ? ('running' as const) : ('available' as const);
  }

  async initialize(): Promise<void> {
    if (!this.isAvailable()) throw new Error(this.getUnavailableReason()!);
    if (this.detector) return;
    const Ctor = (globalThis as Record<string, unknown>)['BarcodeDetector'] as new (
      opts?: { formats?: string[] }
    ) => { detect(source: CanvasImageSource | ImageData): Promise<DetectedBarcode[]> };
    try {
      const supported: string[] = await (
        Ctor.prototype as unknown as { getSupportedFormats(): Promise<string[]> }
      ).getSupportedFormats();
      this.supportedFormats = supported.map((f) => FORMAT_MAP[f] ?? f.toUpperCase());
    } catch {
      this.supportedFormats = Object.values(FORMAT_MAP);
    }
    this.detector = new Ctor({ formats: Object.keys(FORMAT_MAP) });
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async scanFrame(frame: ImageData): Promise<BarcodeResult[]> {
    const t0 = performance.now();
    try {
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas.getContext('2d')!.putImageData(frame, 0, 0);
      const found = await this.detector!.detect(canvas);
      const dt = Math.round(performance.now() - t0);
      return this.filterBarcodeOnly(found
        .filter((d) => d.rawValue)
        .map((d) => ({
          value: d.rawValue,
          format: FORMAT_MAP[d.format] ?? 'UNKNOWN',
          points: d.cornerPoints?.map((p) => ({ x: p.x, y: p.y })),
          decodeTimeMs: dt,
        })));
    } catch {
      return [];
    }
  }

  async destroy(): Promise<void> {
    this.detector = null;
  }
}
