import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ImageBenchmarkService,
  TestImage,
  IMAGE_CATEGORIES,
} from '../../benchmark/image-benchmark.service';
import { PreprocessVariant, VARIANT_LABELS, TIER_MAP, Tier } from '../../core/image/preprocessing';
import { EngineRegistry } from '../../core/barcode/engine-registry';

@Component({
  selector: 'app-image-benchmark-page',
  imports: [CommonModule, FormsModule],
  templateUrl: './image-benchmark-page.html',
})
export class ImageBenchmarkPage {
  readonly categories = IMAGE_CATEGORIES;
  readonly variants = Object.keys(VARIANT_LABELS) as PreprocessVariant[];
  readonly variantLabels = VARIANT_LABELS;
  readonly tiers = Object.keys(TIER_MAP) as Tier[];

  // -- engine selection --
  get engines() { return this.enginesRegistry.getAll(); }
  readonly selectedEngines = signal<Set<string>>(new Set());
  readonly engineSearch = signal('');

  // -- tier selection --
  readonly selectedTiers = signal<Set<string>>(new Set(['Tier 1 — Basic']));

  readonly filteredEngines = computed(() => {
    const q = this.engineSearch().toLowerCase();
    if (!q) return this.engines;
    return this.engines.filter((e) => e.getName().toLowerCase().includes(q));
  });

  readonly availableCount = computed(
    () => this.engines.filter((e) => e.isAvailable()).length
  );

  readonly selectedVariantCount = computed(() => {
    let count = 1; // always includes original
    for (const tier of this.selectedTiers()) {
      const t = TIER_MAP[tier as Tier];
      if (t) count += t.length;
    }
    // Dedup: original is always included
    return count;
  });

  selectAllEngines(): void {
    this.selectedEngines.set(new Set(this.engines.filter((e) => e.isAvailable()).map((e) => e.getName())));
  }

  deselectAllEngines(): void {
    this.selectedEngines.set(new Set());
  }

  toggleEngine(name: string): void {
    const next = new Set(this.selectedEngines());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.selectedEngines.set(next);
  }

  isEngineSelected(name: string): boolean {
    return this.selectedEngines().has(name);
  }

  toggleTier(tier: string): void {
    const next = new Set(this.selectedTiers());
    if (next.has(tier)) next.delete(tier);
    else next.add(tier);
    this.selectedTiers.set(next);
  }

  isTierSelected(tier: string): boolean {
    return this.selectedTiers().has(tier);
  }

  get images() { return this.benchmark.images; }
  get outcomes() { return this.benchmark.outcomes; }
  get running() { return this.benchmark.running; }
  get progress() { return this.benchmark.progress; }
  get lastError() { return this.benchmark.lastError; }
  get engineSummaries() { return this.benchmark.engineSummaries; }
  get engineSummariesAllVariants() { return this.benchmark.engineSummariesAllVariants; }
  get missedImages() { return this.benchmark.missedImages; }
  get partialHitImages() { return this.benchmark.partialHitImages; }
  get retryRunning() { return this.benchmark.retryRunning; }

  readonly selectedImage = signal<string | null>(null);
  readonly selectedOutcomeVariant = signal<PreprocessVariant>('original');
  readonly progressPct = computed(() => {
    const p = this.progress();
    return p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  });
  readonly editingId = signal<string | null>(null);

  readonly selectedImageData = computed(() => {
    const id = this.selectedImage();
    return id ? this.images().find((i) => i.id === id) ?? null : null;
  });

  /** imageId -> list of variants where at least one engine detected, with the engines that hit. */
  readonly hitsByImage = computed(() => {
    const map = new Map<string, { variant: PreprocessVariant; engines: string[] }[]>();
    for (const o of this.benchmark.outcomes()) {
      if (o.classification === 'miss') continue;
      let entries = map.get(o.imageId);
      if (!entries) map.set(o.imageId, (entries = []));
      let entry = entries.find((e) => e.variant === o.variant);
      if (!entry) entries.push((entry = { variant: o.variant, engines: [] }));
      if (!entry.engines.includes(o.engine)) entry.engines.push(o.engine);
    }
    return map;
  });

  hitsFor(imageId: string): { variant: PreprocessVariant; engines: string[] }[] {
    return this.hitsByImage().get(imageId) ?? [];
  }

  selectOutcomeVariant(variant: PreprocessVariant): void {
    this.selectedOutcomeVariant.set(variant);
  }

  readonly selectedImageHits = computed(() => {
    const id = this.selectedImage();
    return id ? this.hitsFor(id) : [];
  });

  readonly selectedOutcomes = computed(() => {
    const id = this.selectedImage();
    return id ? this.benchmark.getOutcomesFor(id, this.selectedOutcomeVariant()) : [];
  });

  readonly dragOver = signal(false);

  // -- retry missed engine selection --
  readonly retrySelected = signal<Set<string>>(new Set());
  readonly retrySearch = signal('');

  readonly filteredRetryEngines = computed(() => {
    const q = this.retrySearch().toLowerCase();
    const all = this.engines.filter((e) => e.isAvailable());
    if (!q) return all;
    return all.filter((e) => e.getName().toLowerCase().includes(q));
  });

  selectAllRetryEngines(): void {
    this.retrySelected.set(new Set(this.engines.filter((e) => e.isAvailable()).map((e) => e.getName())));
  }

  deselectAllRetryEngines(): void {
    this.retrySelected.set(new Set());
  }

  toggleRetryEngine(name: string): void {
    const next = new Set(this.retrySelected());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.retrySelected.set(next);
  }

  isRetryEngineSelected(name: string): boolean {
    return this.retrySelected().has(name);
  }

  constructor(public benchmark: ImageBenchmarkService, private enginesRegistry: EngineRegistry) {}

  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.benchmark.addFiles(Array.from(input.files));
    input.value = '';
  }

  onDrop(event: DragEvent): void {
    this.dragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) this.benchmark.addFiles(Array.from(files));
  }

  removeImage(id: string): void {
    this.benchmark.removeImage(id);
    if (this.selectedImage() === id) this.selectedImage.set(null);
  }

  startEditing(id: string): void {
    this.editingId.set(id);
  }

  cancelEditing(): void {
    this.editingId.set(null);
  }

  saveMeta(id: string, expectedValue: string, expectedFormat: string, category: string, angle: string, distanceCm: string): void {
    this.benchmark.updateMeta(id, {
      expectedValue,
      expectedFormat,
      category,
      angle: angle ? +angle : null,
      distanceCm: distanceCm ? +distanceCm : null,
    });
    this.editingId.set(null);
  }

  async runAll(): Promise<void> {
    const sel = this.selectedEngines().size > 0 ? this.selectedEngines() : undefined;
    const tiers = [...this.selectedTiers()] as Tier[];
    if (tiers.length === 0) tiers.push('Tier 1 — Basic');
    await this.benchmark.runAll(tiers, sel);
  }

  async runMissed(): Promise<void> {
    const sel = this.retrySelected().size > 0 ? this.retrySelected() : undefined;
    const tiers = [...this.selectedTiers()] as Tier[];
    if (tiers.length === 0) tiers.push('Tier 1 — Basic');
    await this.benchmark.runMissed(tiers, sel);
  }

  fmtPct(v: number | null): string {
    return v == null ? 'N/A' : `${Math.round(v)}%`;
  }

  fmtMs(v: number | null): string {
    return v == null ? '---' : `${v}ms`;
  }

  badgeClass(classification: string): string {
    return classification;
  }

  classLabel(c: string): string {
    switch (c) {
      case 'correct': return 'CORRECT';
      case 'incorrect': return 'INCORRECT';
      case 'miss': return 'MISS';
      default: return c;
    }
  }

  tierVariantCount(tier: string): number {
    const t = TIER_MAP[tier as Tier];
    return t ? t.length : 0;
  }

  getTierVariants(tier: string): PreprocessVariant[] {
    return TIER_MAP[tier as Tier] || [];
  }
}
