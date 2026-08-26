import { BarcodeResult, BarcodeFormatName, BarcodePoint } from '../barcode.model';
import { BarcodeScannerAdapter } from '../barcode-scanner.adapter';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

const FORMAT_MAP: Partial<Record<BarcodeFormat, BarcodeFormatName>> = {
  [BarcodeFormat.EAN_8]: 'EAN-8',
  [BarcodeFormat.EAN_13]: 'EAN-13',
  [BarcodeFormat.UPC_A]: 'UPC-A',
  [BarcodeFormat.UPC_E]: 'UPC-E',
  [BarcodeFormat.CODE_39]: 'Code 39',
  [BarcodeFormat.CODE_93]: 'Code 93',
  [BarcodeFormat.CODE_128]: 'Code 128',
  [BarcodeFormat.ITF]: 'ITF',
  [BarcodeFormat.CODABAR]: 'Codabar',
  [BarcodeFormat.QR_CODE]: 'QR Code',
  [BarcodeFormat.DATA_MATRIX]: 'Data Matrix',
  [BarcodeFormat.PDF_417]: 'PDF417',
  [BarcodeFormat.AZTEC]: 'Aztec',
};

export class ZxingAdapter extends BarcodeScannerAdapter {
  private reader: BrowserMultiFormatReader | null = null;

  override getName(): string {
    return 'ZXing';
  }

  override isAvailable(): boolean {
    return true;
  }

  override getSupportedFormats(): string[] {
    return Object.values(FORMAT_MAP).filter(Boolean) as string[];
  }

  async initialize(): Promise<void> {
    if (this.reader) return;
    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.TRY_HARDER, true);
    this.reader = new BrowserMultiFormatReader(hints as never, { delayBetweenScanAttempts: 0 });
    (this.reader as any).timeBetweenDecodingAttempts = 0;
  }

  async start(): Promise<void> {
    await this.initialize();
  }

  async stop(): Promise<void> {
    // Frame-driven adapter: nothing to stop.
  }

  async scanFrame(frame: ImageData): Promise<BarcodeResult[]> {
    const t0 = performance.now();
    try {
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas.getContext('2d')!.putImageData(frame, 0, 0);
      const result = this.reader!.decodeFromCanvas(canvas);
      const points: BarcodePoint[] = [];
      const rp = result.getResultPoints();
      if (rp) for (const p of rp) if (p) points.push({ x: p.getX(), y: p.getY() });
      const fmt = FORMAT_MAP[result.getBarcodeFormat()] ?? 'UNKNOWN';
      const t1 = performance.now();
      return this.filterBarcodeOnly([
        { value: result.getText(), format: fmt, points, decodeTimeMs: Math.round(t1 - t0) },
      ]);
    } catch {
      // NotFoundException or decode error → no result on this frame.
      return [];
    }
  }

  async destroy(): Promise<void> {
    this.reader = null;
  }
}
