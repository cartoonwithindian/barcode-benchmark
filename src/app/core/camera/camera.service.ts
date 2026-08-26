import { Injectable, signal } from '@angular/core';

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

export type ResolutionPreset = '480p' | '720p' | '1080p' | '4K';

const RESOLUTIONS: Record<ResolutionPreset, { width: number; height: number }> = {
  '480p': { width: 640, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4K': { width: 3840, height: 2160 },
};

@Injectable({ providedIn: 'root' })
export class CameraService {
  readonly devices = signal<CameraDeviceInfo[]>([]);
  readonly running = signal(false);
  readonly torchSupported = signal(false);
  readonly zoomSupported = signal(false);
  readonly actualResolution = signal<{ w: number; h: number } | null>(null);

  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;

  async listDevices(): Promise<CameraDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      }));
    this.devices.set(cams);
    return cams;
  }

  async start(opts: {
    deviceId?: string;
    facingMode?: 'environment' | 'user';
    resolution: ResolutionPreset;
  }): Promise<MediaStream> {
    await this.stop();
    const res = RESOLUTIONS[opts.resolution];
    const video: MediaTrackConstraints = {
      width: { ideal: res.width },
      height: { ideal: res.height },
    };
    if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
    else video.facingMode = { ideal: opts.facingMode ?? 'environment' };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video });
    } catch (e) {
      throw new Error(this.describeError(e));
    }
    this.track = this.stream.getVideoTracks()[0] ?? null;
    const settings = this.track?.getSettings();
    if (settings?.width && settings?.height) {
      this.actualResolution.set({ w: settings.width, h: settings.height });
    }
    const caps = (this.track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
      torch?: boolean;
      zoom?: unknown;
    };
    this.torchSupported.set(!!caps.torch);
    this.zoomSupported.set(caps.zoom != null);
    this.running.set(true);
    await this.listDevices(); // labels become available after permission
    return this.stream;
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.running.set(false);
    this.torchSupported.set(false);
    this.zoomSupported.set(false);
    this.actualResolution.set(null);
  }

  async setTorch(on: boolean): Promise<boolean> {
    if (!this.track || !this.torchSupported()) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: on } as any] });
      return true;
    } catch {
      return false;
    }
  }

  async setZoom(level: number): Promise<boolean> {
    if (!this.track || !this.zoomSupported()) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: level } as any] });
      return true;
    } catch {
      return false;
    }
  }

  /** Draws the current video frame into a canvas at its native resolution. */
  captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): ImageData | null {
    if (video.videoWidth === 0 || video.videoHeight === 0) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  screenshot(video: HTMLVideoElement): string | null {
    if (video.videoWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    return c.toDataURL('image/png');
  }

  private describeError(e: unknown): string {
    const err = e as { name?: string };
    switch (err?.name) {
      case 'NotAllowedError':
        return 'Camera permission denied. Allow camera access in your browser settings and try again.';
      case 'NotFoundError':
        return 'No camera device found on this system.';
      case 'NotReadableError':
        return 'Camera is already in use by another application.';
      case 'OverconstrainedError':
        return 'The selected camera does not support the requested resolution.';
      default:
        return `Camera error: ${err?.name ?? 'unknown'}`;
    }
  }
}
