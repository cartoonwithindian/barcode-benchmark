import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BenchmarkService } from '../../benchmark/benchmark.service';
import { BenchmarkStorageService } from '../../benchmark/benchmark-storage.service';
import {
  BenchmarkRecord,
  EngineStats,
  newStats,
} from '../../benchmark/benchmark.model';

interface RankedEngine {
  engine: string;
  liveStats: EngineStats;
  imageStats: EngineStats;
}

@Component({
  selector: 'app-dashboard-page',
  imports: [CommonModule],
  templateUrl: './dashboard-page.html',
})
export class DashboardPage {
  readonly loading = signal(true);
  readonly records = signal<BenchmarkRecord[]>([]);
  readonly error = signal<string | null>(null);

  readonly liveRecords = computed(() => this.records().filter((r) => r.testType !== 'image'));
  readonly imageRecords = computed(() => this.records().filter((r) => r.testType === 'image'));

  readonly rankedEngines = computed(() => this.buildRankings(this.records()));
  readonly liveRankings = computed(() => this.buildRankings(this.liveRecords()));
  readonly imageRankings = computed(() => this.buildRankings(this.imageRecords()));

  readonly angleMatrix = computed(() => {
    const records = this.records().filter(
      (r) => r.angle != null && r.angle !== undefined
    );
    const engineAngleMap = new Map<string, Map<number, { total: number; correct: number }>>();
    for (const r of records) {
      if (r.angle == null) continue;
      let engineMap = engineAngleMap.get(r.engine);
      if (!engineMap) {
        engineMap = new Map();
        engineAngleMap.set(r.engine, engineMap);
      }
      let stat = engineMap.get(r.angle);
      if (!stat) {
        stat = { total: 0, correct: 0 };
        engineMap.set(r.angle, stat);
      }
      stat.total++;
      if (r.success || r.classification === 'correct') stat.correct++;
    }
    const engines = [...engineAngleMap.keys()].sort();
    const angles = [...new Set(records.map((r) => r.angle!))].sort((a, b) => a - b);
    const rows = engines.map((engine) => {
      const angleMap = engineAngleMap.get(engine)!;
      return {
        engine,
        cells: angles.map((a) => {
          const s = angleMap.get(a);
          return s ? (s.correct / s.total > 0.5 ? '\u2713' : '\u2717') : '---';
        }),
      };
    });
    return { angles, rows };
  });

  constructor(public benchmark: BenchmarkService, private storage: BenchmarkStorageService) {
    this.load();
  }

  imageSummary(stats: EngineStats) {
    return this.benchmark.computeSummary(stats);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const all = await this.storage.getAll();
      this.records.set(all);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  exportJson(): void {
    this.storage.exportJson(this.records());
  }

  exportCsv(): void {
    this.storage.exportCsv(this.records());
  }

  async importJson(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const count = await this.storage.importJson(file);
      this.error.set(null);
      await this.load();
      alert(`Imported ${count} records.`);
    } catch (e) {
      this.error.set((e as Error).message);
    }
    input.value = '';
  }

  async clearAll(): Promise<void> {
    if (!confirm('Delete ALL benchmark records? This cannot be undone.')) return;
    await this.storage.clear();
    this.records.set([]);
  }

  fmtPct(v: number | null): string {
    return v == null ? 'N/A' : `${Math.round(v)}%`;
  }

  fmtMs(v: number | null): string {
    return v == null ? '---' : `${v}ms`;
  }

  private buildRankings(records: BenchmarkRecord[]): RankedEngine[] {
    const map = new Map<string, { live: EngineStats; image: EngineStats }>();
    for (const r of records) {
      let entry = map.get(r.engine);
      if (!entry) {
        entry = { live: newStats(r.engine), image: newStats(r.engine) };
        map.set(r.engine, entry);
      }
      const stats = r.testType === 'image' ? entry.image : entry.live;
      stats.totalFrames++;
      if (r.classification === 'correct' || r.classification === 'incorrect') {
        stats.detections++;
        if (r.detectionTimeMs != null) {
          stats.latenciesMs.push(r.detectionTimeMs);
          if (stats.latenciesMs.length > 2000) stats.latenciesMs.shift();
        }
      }
      if (r.classification === 'correct') stats.correct++;
      if (r.classification === 'incorrect') stats.incorrect++;
    }
    return [...map.values()]
      .map((v) => ({ engine: v.live.engine, liveStats: v.live, imageStats: v.image }))
      .sort((a, b) => {
        const accA = a.liveStats.detections > 0 ? a.liveStats.correct / a.liveStats.detections : 0;
        const accB = b.liveStats.detections > 0 ? b.liveStats.correct / b.liveStats.detections : 0;
        return accB - accA;
      });
  }
}
