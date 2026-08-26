import { BarcodeResult, BarcodeFormatName } from '../barcode.model';
import { BarcodeScannerAdapter } from '../barcode-scanner.adapter';
import jsQR from 'jsqr';

/**
 * jsQR decodes QR codes only. It is honest about that: no other
 * formats are ever reported by this adapter.
 */
export class JsQrAdapter extends BarcodeScannerAdapter {
  override getName(): string {
    return 'jsQR';
  }

  override isAvailable(): boolean {
    return true;
  }

  override getSupportedFormats(): string[] {
    return ['QR Code'];
  }

  async initialize(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async scanFrame(frame: ImageData): Promise<BarcodeResult[]> {
    const t0 = performance.now();
    try {
      const code = jsQR(frame.data, frame.width, frame.height, {
        inversionAttempts: 'dontInvert',
      });
      if (!code) return [];
      const dt = Math.round(performance.now() - t0);
      const loc = code.location;
      const points = [
        loc.topLeftCorner,
        loc.topRightCorner,
        loc.bottomRightCorner,
        loc.bottomLeftCorner,
      ].map((p) => ({ x: p.x, y: p.y }));
      return [{ value: code.data, format: 'QR Code', points, decodeTimeMs: dt }];
    } catch {
      return [];
    }
  }

  async destroy(): Promise<void> {}
}
