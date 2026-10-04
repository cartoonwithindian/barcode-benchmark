/**
 * Quagga2 adapter.
 *
 * Ported from `barcode-benchmark/src/app/core/barcode/adapters/quagga2.adapter.ts`,
 * which used the maintained `@ericblade/quagga2` fork.
 *
 * Verdict from actually running it on this deployment (not assumed):
 * Quagga2 *does* load under Node and its localiser works — `decodeSingle`
 * returns populated `boxes` for a data-URL source — but `codeResult` is always
 * `null`/`barcodes` empty, because the 1D decode stage depends on browser worker
 * and canvas facilities that Node does not provide. Returning fabricated decodes
 * would be worse than reporting the limitation, so:
 *
 *  - the adapter is kept (it is part of the benchmark's value and may become
 *    usable if a canvas shim is introduced),
 *  - it reports `platform_unsupported` with an accurate reason,
 *  - it is excluded from the decode plan unless `VISION_ENABLE_QUAGGA2=true`,
 *  - `/version` and the analysis diagnostics report it honestly so the
 *    operator can see the engine list is not being padded.
 */
import { Mutex, sinceMs } from '../../core/async.js';
import { BarcodeScannerAdapter, type DecodeOptions } from '../adapter.js';
import type { BarcodeFormatName, BarcodePoint, BarcodeResult } from '../types.js';
import type { Raster } from '../../imaging/raster.js';

/** The only Quagga2 entry point this adapter uses, structurally typed for Node. */
interface QuaggaDecodeSingleFn {
  decodeSingle(config: Record<string, unknown>): Promise<{
    codeResult?: { code?: string; format?: string; decodedText?: string } | null;
    barcodes?: unknown[];
    boxes?: number[][];
    box?: number[][];
  } | null>;
}

const QUAGGA_REASON =
  'Runs under Node but its 1D decode stage requires browser worker/canvas facilities; localisation succeeds while codeResult stays empty. Enable VISION_ENABLE_QUAGGA2=true only together with a canvas shim.';

export class Quagga2Adapter extends BarcodeScannerAdapter {
  override getName(): string {
    return 'Quagga2';
  }

  override isAvailable(): boolean {
    return this.enabled && this.canvasLike();
  }

  private get enabled(): boolean {
    return process.env.VISION_ENABLE_QUAGGA2 === 'true';
  }

  /** Quagga2 needs an HTMLImageElement/canvas to rasterise the source. */
  private canvasLike(): boolean {
    return typeof (globalThis as { document?: { createElement?: unknown } }).document?.createElement === 'function';
  }

  override getUnavailableReason(): string | null {
    if (this.isAvailable()) return null;
    return QUAGGA_REASON;
  }

  override getStatus() {
    if (this.isAvailable()) return 'available' as const;
    return 'platform_unsupported' as const;
  }

  override getSupportedFormats(): BarcodeFormatName[] {
    return ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code 128', 'Code 39', 'Code 93', 'Codabar', 'ITF'];
  }

  private readonly initMutex = new Mutex();
  /**
   * Quagga2 ships browser-first typings (an `HTMLImageElement` source and a
   * `QuaggaJSStatic` default export). Node has neither, so the module is held
   * behind a narrow structural type describing only `decodeSingle`, which is the
   * single entry point this adapter uses.
   */
  private quagga: QuaggaDecodeSingleFn | null = null;

  override async initialise(): Promise<void> {
    if (!this.isAvailable()) return;
    if (this.quagga) return;
    await this.initMutex.run(async () => {
      if (this.quagga) return;
      const mod = (await import('@ericblade/quagga2')) as unknown as {
        default?: QuaggaDecodeSingleFn;
        decodeSingle?: QuaggaDecodeSingleFn;
      };
      this.quagga = mod.default ?? mod.decodeSingle ?? null;
      if (!this.quagga) throw new Error('Quagga2 module loaded but exposes no decodeSingle().');
    });
  }

  override async decode(image: Raster, _options: DecodeOptions = {}): Promise<BarcodeResult[]> {
    this.recordAttempt();
    if (!this.isAvailable()) return [];
    try {
      await this.initialise();
      const quagga = this.quagga;
      if (!quagga) return [];
      const startedAt = process.hrtime.bigint();
      const result = await quagga.decodeSingle({
        // Quagga2 accepts raw RGBA bytes plus `inputStream.size` on Node; no
        // canvas or data URL is fabricated here.
        src: image.data,
        numOfWorkers: 0,
        locate: true,
        inputStream: { size: Math.max(image.width, image.height) },
        decoder: {
          readers: [
            'ean_reader',
            'ean_8_reader',
            'upc_reader',
            'upc_e_reader',
            'code_128_reader',
            'code_39_reader',
            'code_93_reader',
            'codabar_reader',
            'i2of5_reader',
          ],
        },
      });
      const code = result?.codeResult?.code;
      if (!code) return [];
      const decodeTimeMs = sinceMs(startedAt);
      const box = result?.box as number[][] | undefined;
      const points: BarcodePoint[] | undefined = box?.map((p) => ({ x: p[0], y: p[1] }));
      const formatMap: Record<string, BarcodeFormatName> = {
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
      return [
        {
          value: code,
          format: formatMap[result?.codeResult?.format ?? ''] ?? 'UNKNOWN',
          points,
          boundingBox: this.computeBoundingBox(points),
          decodeTimeMs,
          engine: this.getName(),
          variant: '',
          engineConfidence: null,
        },
      ];
    } catch (err) {
      this.recordError(err);
      return [];
    }
  }
}