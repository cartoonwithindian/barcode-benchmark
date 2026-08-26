import { Injectable } from '@angular/core';
import { BarcodeScannerAdapter } from './barcode-scanner.adapter';
import { ZxingAdapter } from './adapters/zxing.adapter';
import { ZxingWasmAdapter } from './adapters/zxing-wasm.adapter';
import { ZBarWasmAdapter } from './adapters/zbar-wasm.adapter';
import { Quagga2Adapter } from './adapters/quagga2.adapter';
import { Html5QrCodeAdapter } from './adapters/html5-qrcode.adapter';
import { BarcodeDetectorAdapter } from './adapters/barcode-detector.adapter';

/**
 * All browser-capable engines wired into the app. Each adapter is fully
 * isolated; a failing engine never affects the others.
 */
@Injectable({ providedIn: 'root' })
export class EngineRegistry {
  private readonly engines: BarcodeScannerAdapter[] = [
    new ZxingAdapter(),
    new ZxingWasmAdapter(),
    new BarcodeDetectorAdapter(),
    new ZBarWasmAdapter(),
    new Quagga2Adapter(),
    new Html5QrCodeAdapter(),
  ];

  getAll(): BarcodeScannerAdapter[] {
    return this.engines;
  }

  getAvailable(): BarcodeScannerAdapter[] {
    return this.engines.filter((e) => e.isAvailable());
  }
}
