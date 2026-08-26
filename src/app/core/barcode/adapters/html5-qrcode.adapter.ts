import { BarcodeResult, BarcodeFormatName, BarcodePoint } from '../barcode.model';
import { BarcodeScannerAdapter } from '../barcode-scanner.adapter';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

const FORMAT_MAP: Record<number, BarcodeFormatName> = {
  [Html5QrcodeSupportedFormats.EAN_8]: 'EAN-8',
  [Html5QrcodeSupportedFormats.EAN_13]: 'EAN-13',
  [Html5QrcodeSupportedFormats.UPC_A]: 'UPC-A',
  [Html5QrcodeSupportedFormats.UPC_E]: 'UPC-E',
  [Html5QrcodeSupportedFormats.CODE_39]: 'Code 39',
  [Html5QrcodeSupportedFormats.CODE_93]: 'Code 93',
  [Html5QrcodeSupportedFormats.CODE_128]: 'Code 128',
  [Html5QrcodeSupportedFormats.ITF]: 'ITF',
  [Html5QrcodeSupportedFormats.CODABAR]: 'Codabar',
  [Html5QrcodeSupportedFormats.QR_CODE]: 'QR Code',
  [Html5QrcodeSupportedFormats.DATA_MATRIX]: 'Data Matrix',
  [Html5QrcodeSupportedFormats.PDF_417]: 'PDF417',
  [Html5QrcodeSupportedFormats.AZTEC]: 'Aztec',
};

const ELEMENT_ID = 'html5-qrcode-benchmark-hidden';

/**
 * html5-qrcode. Its public API is camera-oriented, but it exposes a
 * single-image decode path (scanFile) which we feed with each captured
 * frame rendered to a PNG blob. Every engine receives the identical frame.
 */
export class Html5QrCodeAdapter extends BarcodeScannerAdapter {
  private scanner: Html5Qrcode | null = null;

  override getName(): string {
    return 'html5-qrcode';
  }

  override isAvailable(): boolean {
    return typeof document !== 'undefined';
  }

  override getSupportedFormats(): string[] {
    return [...new Set(Object.values(FORMAT_MAP))];
  }

  async initialize(): Promise<void> {
    if (this.scanner) return;
    let el = document.getElementById(ELEMENT_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ELEMENT_ID;
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    this.scanner = new Html5Qrcode(ELEMENT_ID, { verbose: false });
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  private canvasToPngFile(canvas: HTMLCanvasElement): Promise<File> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('toBlob failed'));
          return;
        }
        resolve(new File([blob], 'frame.png', { type: 'image/png' }));
      }, 'image/png');
    });
  }

  async scanFrame(frame: ImageData): Promise<BarcodeResult[]> {
    const t0 = performance.now();
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d')!.putImageData(frame, 0, 0);
    try {
      const file = await this.canvasToPngFile(canvas);
      const res = await this.scanner!.scanFileV2(file, false);
      const dt = Math.round(performance.now() - t0);
      // html5-qrcode does not reliably expose the format on the file path;
      // report UNKNOWN rather than guessing.
      const rawFormat = (
        res as unknown as { result?: { format?: { format?: number } } }
      )?.result?.format?.format;
      const format =
        (rawFormat !== undefined ? FORMAT_MAP[rawFormat] : undefined) ?? 'UNKNOWN';
      const points: BarcodePoint[] | undefined = (
        res as unknown as { result?: { points?: { x: number; y: number }[] } }
      )?.result?.points;
      return this.filterBarcodeOnly([{ value: res.decodedText, format, points, decodeTimeMs: dt }]);
    } catch {
      return [];
    }
  }

  async destroy(): Promise<void> {
    this.scanner = null;
    document.getElementById(ELEMENT_ID)?.remove();
  }
}
