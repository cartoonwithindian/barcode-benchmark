import { BarcodeResult, BarcodeFormatName, BarcodePoint } from '../barcode.model';
import { BarcodeScannerAdapter } from '../barcode-scanner.adapter';
import { scanRGBABuffer } from 'zbar.wasm';

const FORMAT_MAP: Record<string, BarcodeFormatName> = {
  'EAN-8': 'EAN-8',
  'EAN-13': 'EAN-13',
  'UPC-A': 'UPC-A',
  'UPC-E': 'UPC-E',
  'CODE-39': 'Code 39',
  'CODE-128': 'Code 128',
  'I25': 'ITF',
  'PDF417': 'PDF417',
  'QR-Code': 'QR Code',
};

/** ZBar compiled to WebAssembly (zbar.wasm — bundles its .wasm inline). */
export class ZBarWasmAdapter extends BarcodeScannerAdapter {
  override getName(): string {
    return 'ZBar (wasm)';
  }

  override isAvailable(): boolean {
    return typeof WebAssembly !== 'undefined';
  }

  override getSupportedFormats(): string[] {
    // Only formats the ZBar build actually exposes symbols for.
    return [...new Set(Object.values(FORMAT_MAP))];
  }

  async initialize(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async scanFrame(frame: ImageData): Promise<BarcodeResult[]> {
    const t0 = performance.now();
    try {
      const buf = frame.data.buffer.slice(
        frame.data.byteOffset,
        frame.data.byteOffset + frame.data.byteLength
      ) as ArrayBuffer;
      const symbols = await scanRGBABuffer(buf, frame.width, frame.height);
      const dt = Math.round(performance.now() - t0);
      const results: BarcodeResult[] = [];
      for (const sym of symbols) {
        results.push({
          value: sym.decode(),
          format: FORMAT_MAP[sym.typeName] ?? 'UNKNOWN',
          points: sym.points.map((p) => ({ x: p.x, y: p.y })),
          decodeTimeMs: dt,
        });
      }
      return this.filterBarcodeOnly(results);
    } catch {
      return [];
    }
  }

  async destroy(): Promise<void> {}
}
