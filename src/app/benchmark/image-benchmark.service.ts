import { Injectable, computed, signal } from '@angular/core';
import { BenchmarkRecord, ResultClassification } from './benchmark.model';
import { BarcodeResult } from '../core/barcode/barcode.model';
import { BenchmarkStorageService } from './benchmark-storage.service';
import { EngineRegistry } from '../core/barcode/engine-registry';
import { BarcodePoint } from '../core/barcode/barcode.model';
import {
  PREPROCESS_VARIANTS,
  PreprocessVariant,
  TIER_MAP,
  Tier,
  applyVariant,
} from '../core/image/preprocessing';

export const IMAGE_CATEGORIES = [
  'NORMAL',
  'ROTATION',
  'PERSPECTIVE',
  'DISTANCE',
  'BLUR',
  'LOW LIGHT',
  'GLARE',
  'DAMAGE',
  'CURVED',
  'PARTIAL',
  'SMALL',
  'MULTIPLE',
  'OCCLUDED',
] as const;

export interface TestImage {
  id: string;
  file: File;
  filename: string;
  objectUrl: string;
  width: number;
  height: number;
  expectedValue: string;
  expectedFormat: string;
  category: string;
  angle: number | null;
  distanceCm: number | null;
}

export interface ImageTestOutcome {
  imageId: string;
  engine: string;
  variant: PreprocessVariant;
  values: string[];
  formats: string[];
  latencyMs: number | null;
  classification: ResultClassification;
  points?: BarcodePoint[];
}

/**
 * Orchestrates the image benchmark: every compatible engine receives the
 * EXACT same source ImageData (fair comparison), first against the original
 * image (baseline), then optionally against preprocessing variants.
 */
@Injectable({ providedIn: 'root' })
export class ImageBenchmarkService {
  readonly images = signal<TestImage[]>([]);
  readonly outcomes = signal<ImageTestOutcome[]>([]);
  readonly running = signal(false);
  readonly progress = signal<{ done: number; total: number }>({ done: 0, total: 0 });
  readonly lastError = signal<string | null>(null);

  /** Images where NO engine found a barcode in ANY variant. */
  readonly missedImages = computed(() => {
    const imgs = this.images();
    const outcomes = this.outcomes();
    return imgs.filter((img) => {
      const imgOutcomes = outcomes.filter((o) => o.imageId === img.id);
      if (imgOutcomes.length === 0) return false; // not yet tested
      // Missed only if ALL outcomes across ALL variants are MISS
      return imgOutcomes.every((o) => o.classification === 'miss');
    });
  });

  /** Images where the original variant missed but at least one variant succeeded. */
  readonly partialHitImages = computed(() => {
    const imgs = this.images();
    const outcomes = this.outcomes();
    return imgs.filter((img) => {
      const imgOutcomes = outcomes.filter((o) => o.imageId === img.id);
      if (imgOutcomes.length === 0) return false;
      const origMissed = imgOutcomes
        .filter((o) => o.variant === 'original')
        .every((o) => o.classification === 'miss');
      const anyDetected = imgOutcomes.some(
        (o) => o.classification === 'correct' || o.classification === 'incorrect'
      );
      return origMissed && anyDetected;
    });
  });

  readonly retryEngines = signal<Set<string>>(new Set());
  readonly retryRunning = signal(false);

  /** Aggregated per-engine stats over all outcomes (original variant only). */
  readonly engineSummaries = computed(() => this.summarize(this.outcomes(), 'original'));
  readonly engineSummariesAllVariants = computed(() => this.summarize(this.outcomes()));

  private initialized = new Set<string>();

  constructor(
    private storage: BenchmarkStorageService,
    private engines: EngineRegistry
  ) {}

  async addFiles(files: File[]): Promise<void> {
    const added: TestImage[] = [];
    for (const file of files) {
      if (!/^image\//.test(file.type)) continue;
      try {
        const bmp = await createImageBitmap(file);
        added.push({
          id: crypto.randomUUID(),
          file,
          filename: file.name,
          objectUrl: URL.createObjectURL(file),
          width: bmp.width,
          height: bmp.height,
          expectedValue: '',
          expectedFormat: '',
          category: 'NORMAL',
          angle: null,
          distanceCm: null,
        });
        bmp.close();
      } catch {
        // Skip unreadable files; never fabricate results for them.
      }
    }
    if (added.length) this.images.update((imgs) => [...imgs, ...added]);
  }

  updateMeta(id: string, patch: Partial<TestImage>): void {
    this.images.update((imgs) => imgs.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  removeImage(id: string): void {
    const img = this.images().find((i) => i.id === id);
    if (img) URL.revokeObjectURL(img.objectUrl);
    this.images.update((imgs) => imgs.filter((i) => i.id !== id));
    this.outcomes.update((o) => o.filter((x) => x.imageId !== id));
  }

  clearOutcomes(): void {
    this.outcomes.set([]);
    this.progress.set({ done: 0, total: 0 });
  }

  /**
   * Runs every available engine against every image with the same input.
   * Baseline (original) always runs; preprocessing variants are optional.
   */
  async runAll(selectedTiers: Tier[], selectedEngines?: Set<string>): Promise<void> {
    if (this.running() || !this.images().length) return;
    this.running.set(true);
    this.lastError.set(null);

    try {
      await this.ensureEnginesInitialized();
      const activeEngines = selectedEngines
        ? this.engines.getAvailable().filter((e) => selectedEngines.has(e.getName()))
        : this.engines.getAvailable();
      const variantSet = new Set<PreprocessVariant>(['original']);
      for (const tier of selectedTiers) {
        for (const v of TIER_MAP[tier]) variantSet.add(v);
      }
      const variants = [...variantSet];
      const images = this.images();
      const outcomes: ImageTestOutcome[] = [];
      const records: BenchmarkRecord[] = [];
      const sessionId = `image-${Date.now()}`;
      let done = 0;

      for (const img of images) {
        const frame = await this.loadFrame(img.file);
        if (!frame) {
          for (const e of activeEngines) {
            outcomes.push(this.miss(img.id, e.getName(), 'original'));
          }
          done++;
          this.progress.set({ done, total: images.length });
          continue;
        }

        // Build scale variants: original size + progressively smaller.
        // Small barcodes in large images need aggressive downscaling so the
        // barcode occupies a meaningful portion of the frame.
        const longest = Math.max(frame.width, frame.height);
        const scales: Array<{ label: string; data: ImageData }> = [
          { label: `${frame.width}x${frame.height}`, data: frame },
        ];
        // Generate downscale targets: 800, 500, 300 px on longest side
        for (const max of [800, 500, 300]) {
          if (longest > max) {
            scales.push({ label: `${max}px`, data: this.downscale(frame, max) });
          }
        }

        for (const variant of variants) {
          for (const engine of activeEngines) {
            const name = engine.getName();
            let bestResults: BarcodeResult[] = [];
            let bestDt = 0;
            let failed = false;
            let bestScale = scales[0].label;

            // Try each scale; stop at first successful decode.
            for (const scale of scales) {
              const data = variant === 'original' ? scale.data : applyVariant(scale.data, variant);
              const t0 = performance.now();
              try {
                const r = await engine.scanFrame(data);
                const dt = Math.round(performance.now() - t0);
                if (r.length > 0 && bestResults.length === 0) {
                  bestResults = r;
                  bestDt = dt;
                  bestScale = scale.label;
                  break; // found at this scale, no need to try others
                }
              } catch {
                failed = true;
              }
            }

            const dt = bestDt;
            const results = bestResults;
            const gt = img.expectedValue.trim();

            let classification: ResultClassification;
            if (failed && results.length === 0) classification = 'miss';
            else if (results.length === 0) classification = 'miss';
            else if (!gt || results.some((r) => r.value === gt)) classification = 'correct';
            else classification = 'incorrect';

            outcomes.push({
              imageId: img.id,
              engine: name,
              variant,
              values: results.map((r) => r.value),
              formats: results.map((r) => r.format),
              latencyMs: results.length === 0 ? null : dt,
              classification,
              points: results[0]?.points,
            });

            records.push({
              id: crypto.randomUUID(),
              sessionId,
              engine: name,
              barcodeValue: results[0]?.value ?? null,
              expectedValue: gt || null,
              format: results[0]?.format ?? '—',
              timestamp: Date.now(),
              frameNumber: done,
              detectionTimeMs: results.length ? dt : null,
              camera: '(uploaded image)',
              resolution: bestScale,
              testType: 'image',
              testCondition:
                variant === 'original' ? img.category : `${img.category}/${variant}`,
              angle: img.angle ?? undefined,
              distanceCm: img.distanceCm ?? undefined,
              classification,
              success: classification === 'correct',
            });
          }
        }
        done++;
        this.progress.set({ done, total: images.length });
      }

      this.outcomes.update((o) => [...o, ...outcomes]);
      try {
        await this.storage.addRecords(records);
      } catch (e) {
        this.lastError.set(`Results shown but persistence failed: ${(e as Error).message}`);
      }
    } finally {
      this.running.set(false);
    }
  }

  /**
   * Re-run only images where ALL engines got MISS, using the given engines.
   * Aggressively tries ALL preprocessing variants + ALL scales.
   * Previous outcomes for these images are cleared before re-running.
   */
  async runMissed(
    selectedTiers: Tier[],
    selectedEngines?: Set<string>
  ): Promise<void> {
    if (this.retryRunning()) return;
    const missed = this.missedImages();
    if (!missed.length) return;
    this.retryRunning.set(true);
    this.lastError.set(null);

    try {
      await this.ensureEnginesInitialized();
      const activeEngines = selectedEngines
        ? this.engines.getAvailable().filter((e) => selectedEngines.has(e.getName()))
        : this.engines.getAvailable();

      if (!activeEngines.length) {
        this.lastError.set('No available engines selected for retry.');
        return;
      }

      const variantSet = new Set<PreprocessVariant>(['original']);
      for (const tier of selectedTiers) {
        for (const v of TIER_MAP[tier]) variantSet.add(v);
      }
      const variants = [...variantSet];

      // Clear old outcomes for these missed images
      const missedIds = new Set(missed.map((m) => m.id));
      this.outcomes.update((o) => o.filter((x) => !missedIds.has(x.imageId)));

      const outcomes: ImageTestOutcome[] = [];
      const records: BenchmarkRecord[] = [];
      const sessionId = `retry-${Date.now()}`;
      let done = 0;

      this.progress.set({ done: 0, total: missed.length });

      for (const img of missed) {
        const frame = await this.loadFrame(img.file);
        if (!frame) {
          for (const e of activeEngines) {
            outcomes.push(this.miss(img.id, e.getName(), 'original'));
          }
          done++;
          this.progress.set({ done, total: missed.length });
          continue;
        }

        const longest = Math.max(frame.width, frame.height);
        const scales: Array<{ label: string; data: ImageData }> = [
          { label: `${frame.width}x${frame.height}`, data: frame },
        ];
        // More aggressive downscaling targets
        for (const max of [1000, 800, 600, 400, 250]) {
          if (longest > max) {
            scales.push({ label: `${max}px`, data: this.downscale(frame, max) });
          }
        }

        for (const variant of variants) {
          for (const engine of activeEngines) {
            const name = engine.getName();
            let bestResults: BarcodeResult[] = [];
            let bestDt = 0;
            let failed = false;
            let bestScale = scales[0].label;

            for (const scale of scales) {
              const data = variant === 'original' ? scale.data : applyVariant(scale.data, variant);
              const t0 = performance.now();
              try {
                const r = await engine.scanFrame(data);
                const dt = Math.round(performance.now() - t0);
                if (r.length > 0 && bestResults.length === 0) {
                  bestResults = r;
                  bestDt = dt;
                  bestScale = scale.label;
                  break;
                }
              } catch {
                failed = true;
              }
            }

            const dt = bestDt;
            const results = bestResults;
            const gt = img.expectedValue.trim();

            let classification: ResultClassification;
            if (failed && results.length === 0) classification = 'miss';
            else if (results.length === 0) classification = 'miss';
            else if (!gt || results.some((r) => r.value === gt)) classification = 'correct';
            else classification = 'incorrect';

            outcomes.push({
              imageId: img.id,
              engine: name,
              variant,
              values: results.map((r) => r.value),
              formats: results.map((r) => r.format),
              latencyMs: results.length === 0 ? null : dt,
              classification,
              points: results[0]?.points,
            });

            records.push({
              id: crypto.randomUUID(),
              sessionId,
              engine: name,
              barcodeValue: results[0]?.value ?? null,
              expectedValue: gt || null,
              format: results[0]?.format ?? '—',
              timestamp: Date.now(),
              frameNumber: done,
              detectionTimeMs: results.length ? dt : null,
              camera: '(uploaded image - retry)',
              resolution: bestScale,
              testType: 'image',
              testCondition: variant === 'original' ? img.category : `${img.category}/${variant}`,
              angle: img.angle ?? undefined,
              distanceCm: img.distanceCm ?? undefined,
              classification,
              success: classification === 'correct',
            });
          }
        }
        done++;
        this.progress.set({ done, total: missed.length });
      }

      this.outcomes.update((o) => [...o, ...outcomes]);
      try {
        await this.storage.addRecords(records);
      } catch (e) {
        this.lastError.set(`Retry results shown but persistence failed: ${(e as Error).message}`);
      }
    } finally {
      this.retryRunning.set(false);
    }
  }

  getOutcomesFor(imageId: string, variant: PreprocessVariant = 'original'): ImageTestOutcome[] {
    return this.outcomes().filter((o) => o.imageId === imageId && o.variant === variant);
  }

  private miss(imageId: string, engine: string, variant: PreprocessVariant): ImageTestOutcome {
    return {
      imageId,
      engine,
      variant,
      values: [],
      formats: [],
      latencyMs: null,
      classification: 'miss',
    };
  }

  private async ensureEnginesInitialized(): Promise<void> {
    for (const engine of this.engines.getAvailable()) {
      if (this.initialized.has(engine.getName())) continue;
      try {
        await engine.initialize();
        this.initialized.add(engine.getName());
      } catch {
        // Isolated failure — engine simply won't appear in runs.
      }
    }
  }

  private async loadFrame(file: File): Promise<ImageData | null> {
    try {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const frame = ctx.getImageData(0, 0, bmp.width, bmp.height);
      bmp.close();
      return frame;
    } catch {
      return null;
    }
  }

  /**
   * Downscale an ImageData so its longest side is at most `maxPx`.
   * Returns the same reference if already small enough.
   */
  private downscale(frame: ImageData, maxPx: number): ImageData {
    const longest = Math.max(frame.width, frame.height);
    if (longest <= maxPx) return frame;
    const scale = maxPx / longest;
    const nw = Math.round(frame.width * scale);
    const nh = Math.round(frame.height * scale);
    const src = document.createElement('canvas');
    src.width = frame.width;
    src.height = frame.height;
    src.getContext('2d')!.putImageData(frame, 0, 0);
    const dst = document.createElement('canvas');
    dst.width = nw;
    dst.height = nh;
    dst.getContext('2d')!.drawImage(src, 0, 0, nw, nh);
    return dst.getContext('2d')!.getImageData(0, 0, nw, nh);
  }

  private summarize(outcomes: ImageTestOutcome[], onlyVariant?: PreprocessVariant) {
    const map = new Map<
      string,
      { engine: string; total: number; detected: number; correct: number; latencies: number[] }
    >();
    for (const o of outcomes) {
      if (onlyVariant && o.variant !== onlyVariant) continue;
      let s = map.get(o.engine);
      if (!s) {
        s = { engine: o.engine, total: 0, detected: 0, correct: 0, latencies: [] };
        map.set(o.engine, s);
      }
      s.total++;
      if (o.classification === 'correct' || o.classification === 'incorrect') {
        s.detected++;
        if (o.latencyMs != null) s.latencies.push(o.latencyMs);
      }
      if (o.classification === 'correct') s.correct++;
    }
    return [...map.values()]
      .map((s) => ({
        engine: s.engine,
        total: s.total,
        success: s.correct,
        detectionRate: s.total ? (s.detected / s.total) * 100 : 0,
        accuracy: s.detected ? (s.correct / s.detected) * 100 : null,
        avgLatency: s.latencies.length
          ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
          : null,
      }))
      .sort((a, b) => b.detectionRate - a.detectionRate);
  }
}
