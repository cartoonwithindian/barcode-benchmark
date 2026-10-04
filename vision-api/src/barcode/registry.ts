/**
 * Engine registry.
 *
 * Server-side counterpart of `barcode-benchmark/src/app/core/barcode/engine-registry.ts`.
 *
 * Order matters: it is the order engines are tried inside a preprocessing tier.
 * ZXing-C++ leads because it had the best hit rate in the recorded benchmark
 * data (836/2071 attempts, highest success rate); ZBar follows as the independent
 * 1D cross-check; ZXing-TS is the pure-TypeScript third opinion; Quagga2 is
 * registered but reports `platform_unsupported` on this runtime.
 *
 * Initialisation is lazy and idempotent, and one engine failing to load never
 * removes the others from the plan.
 */
import type { Logger } from '../core/logger.js';
import { globalMetrics } from '../core/metrics.js';
import type { BarcodeScannerAdapter } from './adapter.js';
import type { EngineLifecycleStatus } from './types.js';
import { Quagga2Adapter } from './adapters/quagga2.adapter.js';
import { ZbarWasmAdapter } from './adapters/zbarWasm.adapter.js';
import { ZxingCppAdapter } from './adapters/zxingCpp.adapter.js';
import { ZxingTsAdapter } from './adapters/zxingTs.adapter.js';

export interface EngineStatusReport {
  name: string;
  status: EngineLifecycleStatus;
  reason: string | null;
  formats: string[];
  /** Set once the engine has been initialised in this process. */
  initialised: boolean;
  last_error: string | null;
}

export class EngineRegistry {
  private readonly engines: BarcodeScannerAdapter[];

  constructor(private readonly log: Logger) {
    this.engines = [
      new ZxingCppAdapter(),
      new ZbarWasmAdapter(),
      new ZxingTsAdapter(),
      new Quagga2Adapter(),
    ];
  }

  getAll(): BarcodeScannerAdapter[] {
    return this.engines;
  }

  /** Engines that report themselves available on this runtime. */
  getAvailable(): BarcodeScannerAdapter[] {
    return this.engines.filter((e) => e.isAvailable());
  }

  /**
   * Engines to actually run for this request: available engines only, and at
   * most `limit` of them so a single image cannot fan out to every decoder.
   */
  getPlan(limit = 3): BarcodeScannerAdapter[] {
    return this.getAvailable().slice(0, Math.max(1, limit));
  }

  byName(name: string): BarcodeScannerAdapter | undefined {
    return this.engines.find((e) => e.getName() === name);
  }

  /** Warms up every available engine. Called once, lazily, on first analyze. */
  async warmUp(): Promise<void> {
    for (const engine of this.getAvailable()) {
      try {
        await engine.initialise();
        this.log.debug({ engine: engine.getName() }, 'engine initialised');
      } catch (err) {
        this.log.warn(
          { engine: engine.getName(), reason: err instanceof Error ? err.message : String(err) },
          'engine initialisation failed; continuing without it',
        );
      }
    }
  }

  statusReport(): EngineStatusReport[] {
    return this.engines.map((engine) => ({
      name: engine.getName(),
      status: engine.getStatus(),
      reason: engine.getUnavailableReason(),
      formats: engine.getSupportedFormats(),
      initialised: engine.wasAttempted(),
      last_error: engine.getLastError(),
    }));
  }

  recordMetrics(engine: string, ms: number, detected: number): void {
    globalMetrics.recordEngineAttempt(engine);
    globalMetrics.recordEngineResult(engine, ms, detected > 0);
  }
}