import { Component, ElementRef, computed, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  CameraService,
  ResolutionPreset,
} from '../../core/camera/camera.service';
import { EngineRegistry } from '../../core/barcode/engine-registry';
import { BenchmarkService } from '../../benchmark/benchmark.service';
import { BenchmarkStorageService } from '../../benchmark/benchmark-storage.service';
import { TestType } from '../../benchmark/benchmark.model';
import { SCANNER_REGISTRY } from '../../core/barcode/scanner-registry';
import { COMMERCIAL_SLOTS } from '../../core/barcode/commercial-slots';

const FPS_OPTIONS = [5, 10, 15, 30];
const ANGLES = [0, 15, 30, 45, 60, 75, 90];

@Component({
  selector: 'app-scanner-page',
  imports: [CommonModule],
  templateUrl: './scanner-page.html',
})
export class ScannerPage {
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly frameCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('frameCanvas');

  readonly fpsOptions = FPS_OPTIONS;
  readonly angles = ANGLES;
  readonly registry = SCANNER_REGISTRY;
  readonly commercialSlots = COMMERCIAL_SLOTS;

  // -- get accessors avoid running before the constructor assigns the service fields --
  get devices() { return this.camera.devices; }
  get cameraRunning() { return this.camera.running; }
  get torchSupported() { return this.camera.torchSupported; }
  get zoomSupported() { return this.camera.zoomSupported; }
  get actualResolution() { return this.camera.actualResolution; }

  readonly deviceId = signal<string>('');
  readonly resolution = signal<ResolutionPreset>('720p');
  readonly fps = signal(15);
  readonly scanning = signal(false);
  readonly torchOn = signal(false);
  readonly zoomLevel = signal(1);

  get groundTruth() { return this.benchmark.groundTruth; }
  get testType() { return this.benchmark.testType; }
  get testCondition() { return this.benchmark.testCondition; }
  get angle() { return this.benchmark.angle; }
  get distanceCm() { return this.benchmark.distanceCm; }
  get raceStates() { return this.benchmark.raceStates; }
  get totalFrames() { return this.benchmark.totalFrames; }
  get sessionId() { return this.benchmark.sessionId; }

  // -- engines list (same getter pattern) --
  get engines() { return this.enginesRegistry.getAll(); }
  readonly selected = signal<Set<string>>(new Set());
  readonly engineSearch = signal('');
  readonly sequential = signal(false);
  readonly dedupe = signal(true);

  readonly debugMode = signal(false);
  readonly lastError = signal<string | null>(null);

  readonly filteredEngines = computed(() => {
    const q = this.engineSearch().toLowerCase();
    if (!q) return this.engines;
    return this.engines.filter((e) => e.getName().toLowerCase().includes(q));
  });

  readonly availableCount = computed(
    () => this.engines.filter((e) => e.isAvailable()).length
  );

  readonly unavailableEngines = computed(() =>
    this.engines.filter((e) => !e.isAvailable())
  );

  readonly orderedRaceRows = computed(() => [...this.raceStates().values()]);

  private loopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public benchmark: BenchmarkService,
    private camera: CameraService,
    private enginesRegistry: EngineRegistry,
    private storage: BenchmarkStorageService
  ) {}

  async refreshDevices(): Promise<void> {
    await this.camera.listDevices();
  }

  async startCamera(): Promise<void> {
    this.lastError.set(null);
    try {
      const stream = await this.camera.start({
        deviceId: this.deviceId() || undefined,
        resolution: this.resolution(),
      });
      this.video().nativeElement.srcObject = stream;
      await this.video().nativeElement.play();
    } catch (e) {
      this.lastError.set((e as Error).message);
    }
  }

  async stopCamera(): Promise<void> {
    this.stopScanning();
    await this.camera.stop();
    this.video().nativeElement.srcObject = null;
  }

  selectAll(): void {
    this.selected.set(new Set(this.engines.filter((e) => e.isAvailable()).map((e) => e.getName())));
  }

  deselectAll(): void {
    this.selected.set(new Set());
  }

  selectCompatibleOnly(): void {
    this.selectAll();
  }

  toggleEngine(name: string): void {
    const next = new Set(this.selected());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.selected.set(next);
  }

  isSelected(name: string): boolean {
    return this.selected().has(name);
  }

  async startScanning(): Promise<void> {
    const names = [...this.selected()].filter((n) =>
      this.engines.some((e) => e.getName() === n && e.isAvailable())
    );
    if (!names.length || !this.camera.running()) {
      this.lastError.set('Start the camera and select at least one compatible engine first.');
      return;
    }
    this.lastError.set(null);
    this.benchmark.startSession();
    this.benchmark.resolution.set(
      `${this.resolution()} (${this.actualResolution()?.w ?? '?'}x${this.actualResolution()?.h ?? '?'})`
    );
    for (const name of names) {
      const engine = this.engines.find((e) => e.getName() === name)!;
      this.benchmark.initEngineState(name);
      try {
        await engine.initialize();
        await engine.start();
      } catch (e) {
        this.benchmark.setEngineStatus(name, 'failed', (e as Error).message);
      }
    }
    this.scanning.set(true);
    this.tick();
  }

  stopScanning(): void {
    this.scanning.set(false);
    if (this.loopTimer != null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    for (const engine of this.engines) void engine.stop().catch(() => undefined);
  }

  async toggleTorch(): Promise<void> {
    const on = !this.torchOn();
    const ok = await this.camera.setTorch(on);
    if (ok) this.torchOn.set(on);
  }

  async onZoom(event: Event): Promise<void> {
    const value = Number((event.target as HTMLInputElement).value);
    this.zoomLevel.set(value);
    await this.camera.setZoom(value);
  }

  screenshot(): void {
    const dataUrl = this.camera.screenshot(this.video().nativeElement);
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `frame-${Date.now()}.png`;
    a.click();
  }

  setTestType(type: TestType): void {
    this.benchmark.testType.set(type);
  }

  setAngle(angle: number | null): void {
    this.benchmark.angle.set(angle ?? undefined);
    if (angle == null) return;
    if (this.benchmark.testType() === 'live') this.benchmark.testType.set('angle');
    this.benchmark.testCondition.set(`angle-${angle}`);
  }

  private async tick(): Promise<void> {
    if (!this.scanning()) return;
    const t0 = performance.now();
    try {
      await this.processFrame();
    } catch (e) {
      this.lastError.set((e as Error).message);
    }
    const elapsed = performance.now() - t0;
    const interval = Math.max(0, 1000 / this.fps() - elapsed);
    this.loopTimer = setTimeout(() => void this.tick(), interval);
  }

  private async processFrame(): Promise<void> {
    const video = this.video().nativeElement;
    const canvas = this.frameCanvas().nativeElement;
    const frame = this.camera.captureFrame(video, canvas);
    if (!frame) return;
    this.benchmark.frameCounter.update((n) => n + 1);

    const active = this.engines.filter(
      (e) => this.selected().has(e.getName()) && e.isAvailable()
    );
    const runOne = async (engine: (typeof active)[number]): Promise<void> => {
      const name = engine.getName();
      this.benchmark.setEngineStatus(name, 'processing');
      const t0 = performance.now();
      let results: Awaited<ReturnType<typeof engine.scanFrame>> = [];
      try {
        results = await engine.scanFrame(frame);
      } catch (e) {
        this.benchmark.recordFrameResult(name, [], null, { failed: true });
        this.benchmark.setEngineStatus(name, 'failed', (e as Error).message);
        return;
      }
      const dt = performance.now() - t0;
      this.benchmark.recordFrameResult(name, results, dt, {
        suppressIfDuplicate: this.dedupe(),
      });
    };

    if (this.sequential()) {
      for (const engine of active) await runOne(engine);
    } else {
      await Promise.all(active.map(runOne));
    }
    await this.benchmark.flush(this.storage).catch(() => undefined);
  }

  fmtPct(v: number | null): string {
    return v == null ? 'N/A' : `${Math.round(v)}%`;
  }

  fmtMs(v: number | null): string {
    return v == null ? '---' : `${v}ms`;
  }

  statusIcon(status: string): string {
    switch (status) {
      case 'found': return 'FOUND';
      case 'processing': return '...';
      case 'failed': return 'FAILED';
      case 'miss': return 'MISS';
      default: return 'idle';
    }
  }
}
