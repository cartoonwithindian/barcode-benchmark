/**
 * OCR engine wrapper around Tesseract (tesseract.js, WASM).
 *
 * Why Tesseract here: it is the only mature OCR engine that runs *inside* the
 * Node process without a native system dependency, which keeps the Render image
 * self-contained (no apt-get libtesseract, no Python sidecar). The traineddata
 * file is vendored under `assets/tessdata` so no network call happens at request
 * time and no CDN is trusted at runtime.
 *
 * Resource discipline:
 *  - a bounded worker pool (`OCR_WORKER_LIMIT`) so concurrent requests cannot
 *    spawn unbounded WASM heaps,
 *  - a queue with a hard wait timeout; callers degrade to `ocr.detected = false`
 *    rather than hanging,
 *  - workers are terminated on `close()` during graceful shutdown.
 */
import { sinceMs } from '../core/async.js';
import type { Logger } from '../core/logger.js';

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrBlock {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0..100 as reported by Tesseract. */
  confidence: number;
  words: OcrWord[];
  lines: OcrLine[];
  blocks: OcrBlock[];
  elapsedMs: number;
  psm: number;
  variant: string;
  engine: string;
}

export interface OcrEngineOptions {
  langPath: string;
  lang: string;
  workerLimit: number;
  timeoutMs: number;
  cache: boolean;
  logger: Logger;
}

interface TesseractWorker {
  recognize(
    image: Buffer,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>,
  ): Promise<{ data: { text: string; confidence: number; blocks?: unknown[] } }>;
  setParameters(params: Record<string, unknown>): Promise<void>;
  terminate(): Promise<unknown>;
}

type CreateWorker = (
  lang: string,
  oem?: number,
  options?: Record<string, unknown>,
) => Promise<TesseractWorker>;

const PSM = {
  AUTO: '3',
  SINGLE_BLOCK: '6',
  SPARSE_TEXT: '11',
  SINGLE_LINE: '7',
} as const;

/** A caller parked in `acquire()`, waiting for a worker to come free. */
interface Waiter {
  /** False once the promise has settled, so a released worker is never wasted. */
  active: boolean;
  /** Hands `worker` to the waiting caller. Returns false if already settled. */
  settle(worker: TesseractWorker): boolean;
}

export class OcrEngine {
  private readonly workers: TesseractWorker[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly ready: Array<Promise<void>> = [];
  private closing = false;
  private createWorker: CreateWorker | null = null;
  private factory: CreateWorker | null = null;

  constructor(private readonly options: OcrEngineOptions) {}

  private async loadFactory(): Promise<CreateWorker> {
    if (this.factory) return this.factory;
    const mod = (await import('tesseract.js')) as unknown as { createWorker: CreateWorker; PSM: Record<string, string> };
    this.psm = mod.PSM;
    this.factory = mod.createWorker;
    return this.factory;
  }

  private psm: Record<string, string> | null = null;

  /**
   * Lazily creates the worker pool. Safe to call repeatedly.
   *
   * A worker that finishes initialising while somebody is already waiting has to
   * be *handed over*, not merely appended to the idle list: pushing alone leaves
   * the waiting caller asleep until the timeout, which is how the first OCR
   * request of every cold start used to fail.
   */
  private ensureWorkers(): void {
    if (this.workers.length > 0 || this.waiters.length > 0 || this.ready.length > 0 || this.closing) return;
    for (let i = 0; i < Math.max(1, this.options.workerLimit); i++) {
      const promise = (async () => {
        const create = await this.loadFactory();
        const worker = await create(this.options.lang, 1, {
          langPath: this.options.langPath,
          cacheMethod: this.options.cache ? 'write' : 'none',
          gzip: true,
          // Never phone home; OCR results must not depend on a CDN at runtime.
          logger: () => undefined,
          errorHandler: (err: unknown) => {
            this.options.logger.warn({ reason: String(err) }, 'tesseract worker error');
          },
        });
        this.release(worker);
      })();
      this.ready.push(promise);
    }
  }

  private acquire(): Promise<TesseractWorker> {
    const idle = this.workers.shift();
    if (idle) return Promise.resolve(idle);
    this.ensureWorkers();
    const alsoIdle = this.workers.shift();
    if (alsoIdle) return Promise.resolve(alsoIdle);

    return new Promise<TesseractWorker>((resolve, reject) => {
      const waiter: Waiter = { active: true, settle: () => false };
      const timer = setTimeout(() => {
        if (!waiter.active) return;
        waiter.active = false;
        // Unregister first: a later `release` must not consume a dead waiter and
        // leak the worker it was carrying.
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('ocr_worker_timeout'));
      }, this.options.timeoutMs);

      waiter.settle = (worker) => {
        if (!waiter.active) return false;
        waiter.active = false;
        clearTimeout(timer);
        resolve(worker);
        return true;
      };
      this.waiters.push(waiter);

      // A worker can land between the idle check above and the push below.
      const late = this.workers.shift();
      if (late) waiter.settle(late);
    });
  }

  /** Returns `worker` to the pool or hands it to the longest-waiting caller. */
  private release(worker: TesseractWorker): void {
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.workers.push(worker);
        return;
      }
      if (waiter.settle(worker)) return;
      // That waiter had already timed out; try the next one.
    }
  }

  /**
   * Destroys a worker and, unless the engine is shutting down, arranges a
   * replacement. A Tesseract worker cannot be interrupted, so a pass that
   * overran its budget leaves the worker permanently busy and the pool one
   * smaller; replacing it is the only way back to full capacity.
   */
  private async discard(worker: TesseractWorker, reason: string): Promise<void> {
    this.options.logger.warn({ reason, worker_limit: this.options.workerLimit }, 'discarding busy ocr worker');
    await worker.terminate().catch(() => undefined);
    const index = this.ready.indexOf(worker as never);
    if (index !== -1) this.ready.splice(index, 1);
    if (this.closing) return;
    this.ready.push(
      (async () => {
        const create = await this.loadFactory();
        const fresh = await create(this.options.lang, 1, {
          langPath: this.options.langPath,
          cacheMethod: this.options.cache ? 'write' : 'none',
          gzip: true,
          logger: () => undefined,
          errorHandler: (err: unknown) => {
            this.options.logger.warn({ reason: String(err) }, 'tesseract worker error');
          },
        });
        this.release(fresh);
      })(),
    );
  }

  /** Recognises an encoded image buffer (PNG/JPEG). Never throws: failures return `null`. */
  async recognise(imageBuffer: Buffer, variant: string, psm: number): Promise<OcrResult | null> {
    let worker: TesseractWorker;
    const startedAt = process.hrtime.bigint();
    try {
      worker = await this.acquire();
    } catch (err) {
      this.options.logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'ocr worker unavailable');
      return null;
    }

    let poisoned = false;
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: String(psm),
        // Indian labels mix English words with FSSAI/INS codes; keep the default
        // English model but stop the engine from "correcting" digits away.
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });

      // A Tesseract worker cannot be interrupted, and some page-segmentation
      // modes on a dense synthetic page can run for minutes. The pass is
      // therefore raced against the budget: on overrun the worker is destroyed
      // and replaced, because a worker left mid-recognition is never reusable.
      const raced = await Promise.race([
        worker.recognize(imageBuffer, {}, { text: true, blocks: true, hocr: false, tsv: false }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('ocr_pass_timeout')),
            this.options.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      const { data } = raced;

      const words = extractWords(data.blocks);
      const lines = extractLines(data.blocks);
      const blocks = extractBlocks(data.blocks);
      return {
        text: data.text ?? '',
        confidence: Number((data.confidence ?? 0).toFixed(2)),
        words,
        lines,
        blocks,
        elapsedMs: sinceMs(startedAt),
        psm,
        variant,
        engine: 'tesseract',
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.options.logger.warn({ reason, variant, psm }, 'ocr recognition failed');
      poisoned = reason === 'ocr_pass_timeout';
      return null;
    } finally {
      if (poisoned) await this.discard(worker, 'pass_timeout');
      else this.release(worker);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    // Fail anybody still parked in `acquire()` rather than leaving them to time
    // out: a worker may never arrive once the pool is draining.
    const parked = this.waiters.splice(0, this.waiters.length);
    for (const waiter of parked) waiter.active = false;

    const all = [...this.workers];
    this.workers.length = 0;
    for (const worker of all) {
      try {
        await worker.terminate();
      } catch {
        /* best effort */
      }
    }
    // A worker that was still being created when close() ran would otherwise be
    // pushed onto an already-terminated pool; await it and take it down.
    await Promise.allSettled(this.ready.splice(0, this.ready.length));
  }

  /** Exposed so the pipeline can use the same PSM constants. */
  static get psm(): Record<string, number> {
    return { AUTO: 3, SINGLE_BLOCK: 6, SPARSE_TEXT: 11, SINGLE_LINE: 7 };
  }
}

// ─── Tesseract block parsing ────────────────────────────────────────────────

/**
 * Tesseract's `blocks` output is a nested tree
 * (block -> paragraph -> line -> word). We walk it defensively: a shape change
 * in a future release degrades the region data, it never breaks the OCR text.
 */
interface RawNode {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  paragraphs?: RawNode[];
  lines?: RawNode[];
  words?: RawNode[];
}

function walk(node: RawNode, visit: (n: RawNode) => void): void {
  visit(node);
  for (const paragraph of node.paragraphs ?? []) walk(paragraph, visit);
  for (const line of node.lines ?? []) walk(line, visit);
  for (const word of node.words ?? []) walk(word, visit);
}

function extractWords(blocks: unknown): OcrWord[] {
  const out: OcrWord[] = [];
  for (const block of (blocks ?? []) as RawNode[]) {
    walk(block, (node) => {
      if (node.bbox && typeof node.text === 'string' && node.words === undefined && node.lines === undefined) {
        const text = node.text.trim();
        if (text.length > 0) {
          out.push({ text, confidence: node.confidence ?? 0, bbox: node.bbox });
        }
      }
    });
  }
  return out;
}

function extractLines(blocks: unknown): OcrLine[] {
  const out: OcrLine[] = [];
  for (const block of (blocks ?? []) as RawNode[]) {
    walk(block, (node) => {
      if (node.bbox && typeof node.text === 'string' && node.words !== undefined) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (text.length > 0) out.push({ text, confidence: node.confidence ?? 0, bbox: node.bbox });
      }
    });
  }
  return out.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

function extractBlocks(blocks: unknown): OcrBlock[] {
  const out: OcrBlock[] = [];
  for (const block of (blocks ?? []) as RawNode[]) {
    if (block.bbox && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text.length > 0) out.push({ text, confidence: block.confidence ?? 0, bbox: block.bbox });
    }
  }
  return out;
}

/**
 * PSM constants re-exported for the pipeline; Tesseract's own `PSM` enum is
 * loaded lazily with the engine so a missing language pack fails cleanly.
 */
export const OCR_PSM = PSM;