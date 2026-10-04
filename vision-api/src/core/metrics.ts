/**
 * In-process metrics registry.
 *
 * Purpose-built instead of pulling a Prometheus client: the service only needs a
 * handful of counters and a couple of histograms, and a self-contained
 * implementation keeps the Render image small.
 *
 * Metrics are process-local. Render free/standard instances run a single
 * process; when scaled horizontally each instance reports its own counters.
 */

export interface MetricsSnapshot {
  uptime_seconds: number;
  counters: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; min: number; max: number; avg: number; p50: number; p95: number }>;
  engine: Record<string, EngineMetricsReport>;
  preprocess_variants: Record<string, number>;
}

/** Raw counters; the snapshot adds the derived ratio. */
interface EngineMetrics {
  attempts: number;
  detections: number;
  total_ms: number;
}

/** What `GET /metrics` reports per engine. */
interface EngineMetricsReport extends EngineMetrics {
  detections_per_attempt: number;
  avg_ms: number;
}

class Histogram {
  private values: number[] = [];
  private maxSamples: number;

  constructor(private readonly name: string, maxSamples = 512) {
    this.maxSamples = maxSamples;
  }

  observe(value: number): void {
    this.values.push(value);
    // Reservoir sampling keeps memory bounded on long-lived processes.
    if (this.values.length > this.maxSamples) {
      const idx = Math.floor(Math.random() * this.values.length);
      this.values[idx] = value;
      this.values.length = this.maxSamples;
    }
  }

  snapshot(): { count: number; sum: number; min: number; max: number; avg: number; p50: number; p95: number } {
    if (this.values.length === 0) return { count: 0, sum: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return {
      count: this.values.length,
      sum,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / sorted.length,
      p50: at(50),
      p95: at(95),
    };
  }

  get label(): string {
    return this.name;
  }
}

const COUNTER_NAMES = [
  'requests_total',
  'requests_failed_total',
  'rate_limited_total',
  'unauthorized_total',
  'download_failed_total',
  'download_blocked_total',
  'invalid_image_total',
  'image_too_large_total',
  'cache_hits_total',
  'cache_misses_total',
  'analysis_barcode_detected_total',
  'analysis_barcode_missed_total',
  'analysis_ocr_detected_total',
  'analysis_ocr_missed_total',
  'analysis_ingredients_found_total',
  'analysis_failures_total',
] as const;

export class Metrics {
  private counters: Record<string, number> = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  private histograms = new Map<string, Histogram>();
  private engines = new Map<string, EngineMetrics>();
  private variants = new Map<string, number>();
  private readonly startedAt = Date.now();

  private ensureHistogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name);
      this.histograms.set(name, h);
    }
    return h;
  }

  increment(name: string, by = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + by;
  }

  observe(name: string, value: number): void {
    this.ensureHistogram(name).observe(value);
  }

  recordEngineAttempt(engine: string): void {
    const e = this.engines.get(engine) ?? { attempts: 0, detections: 0, total_ms: 0 };
    e.attempts += 1;
    this.engines.set(engine, e);
  }

  recordEngineResult(engine: string, ms: number, detected: boolean): void {
    const e = this.engines.get(engine) ?? { attempts: 0, detections: 0, total_ms: 0 };
    e.total_ms += ms;
    if (detected) e.detections += 1;
    this.engines.set(engine, e);
  }

  recordVariant(variant: string): void {
    this.variants.set(variant, (this.variants.get(variant) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    const histograms: MetricsSnapshot['histograms'] = {};
    for (const [name, h] of this.histograms) {
      const s = h.snapshot();
      histograms[`${name}_ms`] = s;
    }
    const engine: MetricsSnapshot['engine'] = {};
    for (const [name, e] of this.engines) {
      engine[name] = {
        attempts: e.attempts,
        detections: e.detections,
        total_ms: e.total_ms,
        detections_per_attempt: e.attempts > 0 ? Number((e.detections / e.attempts).toFixed(4)) : 0,
        avg_ms: e.attempts > 0 ? Number((e.total_ms / e.attempts).toFixed(2)) : 0,
      };
    }
    return {
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      counters: { ...this.counters },
      histograms,
      engine,
      preprocess_variants: Object.fromEntries(this.variants),
    };
  }
}

export const globalMetrics = new Metrics();

export function derivedRates(snapshot: MetricsSnapshot): Record<string, number> {
  const c = snapshot.counters;
  const rate = (num: number, den: number) => (den > 0 ? Number((num / den).toFixed(4)) : 0);
  return {
    barcode_detection_rate: rate(c.analysis_barcode_detected_total, c.analysis_barcode_detected_total + c.analysis_barcode_missed_total),
    ocr_success_rate: rate(c.analysis_ocr_detected_total, c.analysis_ocr_detected_total + c.analysis_ocr_missed_total),
    ingredient_extraction_rate: rate(
      c.analysis_ingredients_found_total,
      c.analysis_ocr_detected_total + c.analysis_ocr_missed_total,
    ),
    cache_hit_rate: rate(c.cache_hits_total, c.cache_hits_total + c.cache_misses_total),
    error_rate: rate(c.requests_failed_total, c.requests_total),
  };
}