/**
 * Staged barcode pipeline.
 *
 * Implements the "fast path first" strategy from the service brief:
 *
 *   Tier 1 variants x primary engines
 *        -> high-confidence / multi-engine agreement? stop barcode work, report.
 *        -> otherwise widen: more variants (Tier 2), then geometry/ROI (Tier 3)
 *           and the secondary engines.
 *
 * Hard guarantees:
 *  - a wall-clock budget (`maxMs`) and a variant budget (`maxVariants`) bound the
 *    work, so a pathological image can never pin the instance,
 *  - no combinatorial explosion: variants are tried in a fixed order and each is
 *    fed to at most `enginesPerVariant` engines,
 *  - nothing is fabricated: an engine that throws contributes zero results and
 *    the error is reported in `diagnostics.engines[].error`.
 */
import { sinceMs } from '../core/async.js';
import type { Logger } from '../core/logger.js';
import { globalMetrics } from '../core/metrics.js';
import { applyVariant, type PreprocessVariant } from '../imaging/preprocessing.js';
import type { Raster } from '../imaging/raster.js';
import { buildVariantPlan, type PlanName } from '../imaging/variants.js';
import type { EngineRegistry } from './registry.js';
import { fuseBarcodeResults, selectPrimaryBarcode, type FusedBarcode } from './fusion.js';
import type { BarcodeResult } from './types.js';

export interface BarcodePipelineOptions {
  plan: PlanName;
  maxVariants: number;
  maxMs: number;
  minConfidence: number;
  /** Stop once this many engines agree on the same payload. */
  agreementTarget: number;
  /** Confidence at which further barcode work is pointless. */
  stopConfidence: number;
  maxResults: number;
}

export interface EngineAttemptReport {
  engine: string;
  status: string;
  variants_tried: number;
  detections: number;
  total_ms: number;
  error: string | null;
}

export interface BarcodePipelineResult {
  detected: boolean;
  fused: FusedBarcode[];
  primary: FusedBarcode | null;
  variantsUsed: PreprocessVariant[];
  attempts: EngineAttemptReport[];
  totalMs: number;
  stoppedEarly: boolean;
  stopReason: string;
  totalDecodes: number;
}

const DEFAULTS: BarcodePipelineOptions = {
  plan: 'standard',
  maxVariants: 6,
  maxMs: 9000,
  minConfidence: 0.5,
  agreementTarget: 2,
  stopConfidence: 0.85,
  maxResults: 5,
};

export class BarcodePipeline {
  private warmedUp = false;
  private warmUpPromise: Promise<void> | null = null;

  constructor(
    private readonly registry: EngineRegistry,
    private readonly log: Logger,
  ) {}

  async warmUp(): Promise<void> {
    if (this.warmedUp) return;
    if (!this.warmUpPromise) {
      this.warmUpPromise = this.registry.warmUp().finally(() => {
        this.warmedUp = true;
      });
    }
    await this.warmUpPromise;
  }

  async run(image: Raster, options: Partial<BarcodePipelineOptions> = {}): Promise<BarcodePipelineResult> {
    const opts = { ...DEFAULTS, ...options };
    const startedAt = process.hrtime.bigint();
    const plan = buildVariantPlan(opts.plan, opts.maxVariants);
    const engines = this.registry.getPlan(3);

    const allResults: BarcodeResult[] = [];
    const variantsUsed: PreprocessVariant[] = [];
    const perEngine = new Map<string, { variants: number; detections: number; ms: number }>();

    for (const engine of engines) {
      perEngine.set(engine.getName(), { variants: 0, detections: 0, ms: 0 });
    }

    let stoppedEarly = false;
    let stopReason = 'variant_budget_exhausted';

    await this.warmUp();

    for (let variantIndex = 0; variantIndex < plan.variants.length; variantIndex++) {
      const variant = plan.variants[variantIndex]!;
      const elapsed = sinceMs(startedAt);
      if (elapsed > opts.maxMs) {
        stopReason = 'time_budget_exhausted';
        break;
      }
      if (variantsUsed.length >= opts.maxVariants) {
        stopReason = 'variant_budget_exhausted';
        break;
      }

      let raster: Raster;
      const variantStart = process.hrtime.bigint();
      try {
        raster = await applyVariant(image, variant);
      } catch (err) {
        this.log.debug(
          { variant, reason: err instanceof Error ? err.message : String(err) },
          'preprocessing variant failed; skipping',
        );
        continue;
      }
      variantsUsed.push(variant);
      globalMetrics.recordVariant(variant);

      // Primary engines first; the cheap 1D specialists also run on variants.
      for (const engine of engines) {
        const elapsedNow = sinceMs(startedAt);
        if (elapsedNow > opts.maxMs) break;
        const decodeStart = process.hrtime.bigint();
        const results = await engine.decode(raster);
        const decodeMs = sinceMs(decodeStart);
        const stats = perEngine.get(engine.getName()) ?? { variants: 0, detections: 0, ms: 0 };
        stats.variants += 1;
        stats.detections += results.length;
        stats.ms += decodeMs;
        perEngine.set(engine.getName(), stats);
        this.registry.recordMetrics(engine.getName(), decodeMs, results.length);

        for (const r of results) allResults.push({ ...r, variant });

        if (results.length > 0) {
          const interim = fuseBarcodeResults(allResults, { minConfidence: 0, maxResults: 5 });
          const leader = selectPrimaryBarcode(interim);
          if (leader && leader.confidence !== null) {
            const strongEnough = leader.confidence >= opts.stopConfidence;
            const agreed = leader.agreement >= opts.agreementTarget;
            if (strongEnough || (agreed && leader.is_retail_gtin)) {
              stoppedEarly = true;
              stopReason = strongEnough ? 'confidence_target_reached' : 'multi_engine_agreement';
              break;
            }
          }
        }
      }

      if (stoppedEarly) break;
      const variantMs = sinceMs(variantStart);
      this.log.debug({ variant, variant_ms: variantMs, cumulative_ms: elapsed }, 'barcode variant complete');
    }

    const fused = fuseBarcodeResults(allResults, { minConfidence: opts.minConfidence, maxResults: opts.maxResults });
    const primary = selectPrimaryBarcode(fused);
    const totalMs = sinceMs(startedAt);
    globalMetrics.observe('barcode_pipeline', totalMs);

    const attempts: EngineAttemptReport[] = [...perEngine.entries()].map(([engine, stats]) => ({
      engine,
      status: this.registry.byName(engine)?.getStatus() ?? 'unknown',
      variants_tried: stats.variants,
      detections: stats.detections,
      total_ms: Number(stats.ms.toFixed(2)),
      error: this.registry.byName(engine)?.getLastError() ?? null,
    }));

    return {
      detected: fused.length > 0,
      fused,
      primary,
      variantsUsed,
      attempts,
      totalMs,
      stoppedEarly,
      stopReason,
      totalDecodes: allResults.length,
    };
  }
}