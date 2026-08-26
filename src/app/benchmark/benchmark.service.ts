import { Injectable, computed, signal } from '@angular/core';
import {
  BenchmarkRecord,
  EngineStats,
  ResultClassification,
  TestType,
  newStats,
  percentile,
} from './benchmark.model';
import { BarcodeResult } from '../core/barcode/barcode.model';

export interface EngineRaceState {
  engine: string;
  status: 'idle' | 'processing' | 'found' | 'miss' | 'failed';
  lastValue: string | null;
  lastLatencyMs: number | null;
  stats: EngineStats;
  error: string | null;
}

/**
 * Holds live benchmark state for the current run and persists every
 * attempt (including misses) to IndexedDB via BenchmarkStorageService.
 */
@Injectable({ providedIn: 'root' })
export class BenchmarkService {
  readonly sessionId = signal<string>('');
  readonly groundTruth = signal<string>('');
  readonly testType = signal<TestType>('live');
  readonly testCondition = signal<string>('normal');
  readonly angle = signal<number | undefined>(undefined);
  readonly distanceCm = signal<number | undefined>(undefined);
  readonly cameraLabel = signal<string>('');
  readonly resolution = signal<string>('');

  readonly frameCounter = signal(0);
  readonly raceStates = signal<Map<string, EngineRaceState>>(new Map());

  readonly totalFrames = computed(() => this.frameCounter());
  readonly firstCorrectEngine = computed(() => {
    let best: { engine: string; ms: number } | null = null;
    for (const s of this.raceStates().values()) {
      if (s.status === 'found' && s.stats.correct > 0) {
        const lat = s.lastLatencyMs ?? Number.MAX_SAFE_INTEGER;
        if (!best || lat < best.ms) best = { engine: s.engine, ms: lat };
      }
    }
    return best?.engine ?? null;
  });

  private pending: BenchmarkRecord[] = [];

  startSession(): string {
    const id = `session-${Date.now()}`;
    this.sessionId.set(id);
    this.frameCounter.set(0);
    return id;
  }

  initEngineState(engineName: string): void {
    const map = new Map(this.raceStates());
    if (!map.has(engineName)) {
      map.set(engineName, {
        engine: engineName,
        status: 'idle',
        lastValue: null,
        lastLatencyMs: null,
        stats: newStats(engineName),
        error: null,
      });
      this.raceStates.set(map);
    }
  }

  setEngineStatus(
    engine: string,
    status: EngineRaceState['status'],
    error: string | null = null
  ): void {
    const map = new Map(this.raceStates());
    const s = map.get(engine);
    if (!s) return;
    map.set(engine, { ...s, status, error });
    this.raceStates.set(map);
  }

  /**
   * Records one frame outcome for one engine and returns its classification.
   * A miss is also recorded — misses are essential data.
   */
  recordFrameResult(
    engine: string,
    results: BarcodeResult[],
    latencyMs: number | null,
    opts: { failed?: boolean; suppressIfDuplicate?: boolean } = {}
  ): ResultClassification {
    const failed = opts.failed ?? false;
    const suppressIfDuplicate = opts.suppressIfDuplicate ?? false;
    const map = new Map(this.raceStates());
    const s = map.get(engine) ?? {
      engine,
      status: 'idle' as const,
      lastValue: null,
      lastLatencyMs: null,
      stats: newStats(engine),
      error: null,
    };
    // Duplicate-result suppression: consecutive identical detections update
    // latency stats but are not persisted again as new records.
    if (
      suppressIfDuplicate &&
      results.length > 0 &&
      s.lastValue !== null &&
      s.lastValue === results[0].value
    ) {
      if (latencyMs != null) {
        s.lastLatencyMs = Math.round(latencyMs);
        s.stats.latenciesMs.push(s.lastLatencyMs);
        if (s.stats.latenciesMs.length > 2000) s.stats.latenciesMs.shift();
      }
      map.set(engine, { ...s, stats: { ...s.stats } });
      this.raceStates.set(map);
      return 'duplicate';
    }

    s.stats.totalFrames++;
    const gt = this.groundTruth().trim();
    let classification: ResultClassification = 'miss';
    let value: string | null = null;

    if (failed) {
      s.status = 'failed';
    } else if (results.length > 0) {
      value = results[0].value;
      s.lastValue = value;
      s.status = 'found';
      s.stats.detections++;
      classification =
        !gt || value === gt ? 'correct' : 'incorrect';
      if (classification === 'correct') s.stats.correct++;
      else s.stats.incorrect++;
    } else {
      s.status = 'miss';
      s.lastValue = null;
    }
    if (latencyMs != null && results.length > 0) {
      s.lastLatencyMs = Math.round(latencyMs);
      s.stats.latenciesMs.push(s.lastLatencyMs);
      if (s.stats.latenciesMs.length > 2000) s.stats.latenciesMs.shift();
    }

    map.set(engine, { ...s, stats: { ...s.stats }, error: s.error });
    this.raceStates.set(map);

    // Persist one record per result; a miss becomes a single miss record.
    if (results.length > 0) {
      for (const r of results) this.queueRecord(engine, r.value, r.format, r.decodeTimeMs, classification);
    } else {
      this.queueRecord(engine, null, '—', null, classification);
    }
    return classification;
  }

  private queueRecord(
    engine: string,
    value: string | null,
    format: string,
    detectionTimeMs: number | null,
    classification: ResultClassification
  ): void {
    this.pending.push({
      id: crypto.randomUUID(),
      sessionId: this.sessionId(),
      engine,
      barcodeValue: value,
      expectedValue: this.groundTruth() || null,
      format,
      timestamp: Date.now(),
      frameNumber: this.frameCounter(),
      detectionTimeMs,
      camera: this.cameraLabel(),
      resolution: this.resolution(),
      testType: this.testType(),
      testCondition: this.testCondition(),
      angle: this.angle(),
      distanceCm: this.distanceCm(),
      classification,
      success: classification === 'correct',
    });
  }

  /** Flushes queued records to IndexedDB. */
  async flush(storage: { addRecords(r: BenchmarkRecord[]): Promise<void> }): Promise<void> {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    await storage.addRecords(batch);
  }

  computeSummary(stats: EngineStats) {
    const lat = stats.latenciesMs;
    const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
    return {
      detectionRate:
        stats.totalFrames > 0 ? (stats.detections / stats.totalFrames) * 100 : null,
      accuracy: stats.detections > 0 ? (stats.correct / stats.detections) * 100 : null,
      falsePositiveRate:
        stats.detections > 0 ? (stats.incorrect / stats.detections) * 100 : null,
      avgLatency: avg != null ? Math.round(avg) : null,
      minLatency: lat.length ? Math.min(...lat) : null,
      maxLatency: lat.length ? Math.max(...lat) : null,
      medianLatency: lat.length ? Math.round(percentile(lat, 50)) : null,
    };
  }
}
