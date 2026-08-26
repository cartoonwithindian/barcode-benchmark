import { BarcodeResult, BarcodeFormatName, BarcodePoint } from '../barcode.model';
import { BarcodeScannerAdapter } from '../barcode-scanner.adapter';
import { readBarcodes } from 'zxing-wasm/reader';

const FORMAT_MAP: Record<string, BarcodeFormatName> = {
  EAN8: 'EAN-8',
  EAN13: 'EAN-13',
  UPCA: 'UPC-A',
  UPCE: 'UPC-E',
  Code39: 'Code 39',
  Code93: 'Code 93',
  Code128: 'Code 128',
  ITF: 'ITF',
  Codabar: 'Codabar',
  QRCode: 'QR Code',
  DataMatrix: 'Data Matrix',
  PDF417: 'PDF417',
  Aztec: 'Aztec',
};

/**
 * ZXing-C++ compiled to WebAssembly. The .wasm binary is copied to /wasm by
 * the build (see angular.json assets); the emscripten loader is pointed at it
 * via prepareZXingModule overrides in initialize().
 */
export class ZxingWasmAdapter extends BarcodeScannerAdapter {
  private prepared = false;

  override getName(): string {
    return 'ZXing-C++';
  }

  override isAvailable(): boolean {
    return typeof WebAssembly !== 'undefined';
  }

  override getSupportedFormats(): string[] {
    return [...new Set(Object.values(FORMAT_MAP))];
  }

  async initialize(): Promise<void> {
    if (this.prepared) return;
    const { prepareZXingModule } = await import('zxing-wasm/reader');
    await prepareZXingModule({
      overrides: {
        locateFile: (path: string) => `/wasm/${path}`,
      },
      fireImmediately: true,
    });
    this.prepared = true;
  }

  async start(): Promise<void> {
    await this.initialize();
  }

  async stop(): Promise<void> {}

  async scanFrame(frame: ImageData): Promise<BarcodeResult[]> {
    const t0 = performance.now();
    try {
      const results = await readBarcodes(frame, { tryHarder: true });
      const dt = Math.round(performance.now() - t0);
      return this.filterBarcodeOnly(results.map((r) => ({
        value: r.text,
        format: FORMAT_MAP[r.format] ?? 'UNKNOWN',
        points: r.position
          ? [
              r.position.topLeft,
              r.position.topRight,
              r.position.bottomRight,
              r.position.bottomLeft,
            ].map((p) => ({ x: p.x, y: p.y }))
          : undefined,
        decodeTimeMs: dt,
      })));
    } catch {
      return [];
    }
  }

  async destroy(): Promise<void> {}
}
