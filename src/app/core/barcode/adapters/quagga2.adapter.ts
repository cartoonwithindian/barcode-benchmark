import { BarcodeResult, BarcodeFormatName, BarcodePoint } from '../barcode.model';
import { BarcodeScannerAdapter } from '../barcode-scanner.adapter';
import type Quagga from '@ericblade/quagga2';

const READERS = [
  'ean_reader',
  'ean_8_reader',
  'upc_reader',
  'upc_e_reader',
  'code_128_reader',
  'code_39_reader',
  'code_93_reader',
  'codabar_reader',
  'i2of5_reader',
];

const FORMAT_MAP: Record<string, BarcodeFormatName> = {
  ean_13: 'EAN-13',
  ean_8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  code_128: 'Code 128',
  code_39: 'Code 39',
  code_93: 'Code 93',
  codabar: 'Codabar',
  i2of5: 'ITF',
};

/**
 * Quagga2 (1D only). Implemented through the maintained
 * @ericblade/quagga2 fork — the bare "quagga2" package no longer resolves.
 */
export class Quagga2Adapter extends BarcodeScannerAdapter {
  private quagga: typeof Quagga | null = null;

  override getName(): string {
    return 'Quagga2';
  }

  override isAvailable(): boolean {
    return true;
  }

  override getSupportedFormats(): string[] {
    return [...new Set(Object.values(FORMAT_MAP))];
  }

  async initialize(): Promise<void> {
    if (this.quagga) return;
    this.quagga = (await import('@ericblade/quagga2')).default;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async scanFrame(frame: ImageData): Promise<BarcodeResult[]> {
    const t0 = performance.now();
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d')!.putImageData(frame, 0, 0);
    try {
      const result = await this.quagga!.decodeSingle({
        src: canvas.toDataURL('image/png'),
        numOfWorkers: 0,
        locate: true,
        inputStream: { size: Math.max(frame.width, frame.height) },
        decoder: { readers: READERS as any },
      });
      const dt = Math.round(performance.now() - t0);
      const code = result?.codeResult?.code;
      if (!code) return [];
      const box = result?.box as number[][] | undefined;
      const points: BarcodePoint[] | undefined = box?.map((p) => ({ x: p[0], y: p[1] }));
      const fmt =
        FORMAT_MAP[result?.codeResult?.format ?? ''] ?? 'UNKNOWN';
      return [{ value: code, format: fmt, points, decodeTimeMs: dt }];
    } catch {
      return [];
    }
  }

  async destroy(): Promise<void> {
    this.quagga = null;
  }
}
