/**
 * Async helpers used across the ingestion and pipeline layers.
 */

/** Rejects with `error` if `promise` has not settled within `ms` milliseconds. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error()), ms);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs tasks with bounded concurrency, preserving input order in the result.
 * A rejected task resolves to its error instead of failing the batch.
 */
export async function settledMap<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await task(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Runs tasks with bounded concurrency, propagating the first rejection. */
export async function parallelMap<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `process.hrtime.bigint()` counts nanoseconds. */
export const NS_PER_MS = 1_000_000n;

/** A monotonic millisecond mark. Use with {@link sinceMs}. */
export function nowMs(): number {
  return Number(process.hrtime.bigint() / NS_PER_MS);
}

/**
 * Milliseconds elapsed since a {@link nowMs}-style mark.
 *
 * Always go through this instead of dividing by hand: the divisor for
 * nanoseconds is 1e6, and getting it wrong inflates every reported duration
 * by 1000x, which silently turns a millisecond budget into a microsecond one.
 */
export function elapsedMs(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / NS_PER_MS);
}

/** Alias of {@link elapsedMs}, used where "since <mark>" reads better. */
export const sinceMs = elapsedMs;

/** Single-slot mutex used to lazily initialise heavy WASM engines exactly once. */
export class Mutex {
  private current: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.current.then(fn, fn);
    // Keep the chain alive even when a task rejects.
    this.current = next.catch(() => undefined);
    return next;
  }
}

/**
 * Counting semaphore that bounds how many tasks run at the same time.
 *
 * `run()` never rejects on its own: a queued task that throws has its error
 * propagated to its own caller only, and every waiter is woken exactly once.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  get inFlight(): number {
    return this.available <= 0 ? this.waiters.length + 1 : 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const wake = this.waiters.shift();
    if (wake) {
      // Hand the permit straight to the waiter; availability stays 0.
      wake();
    } else {
      this.available += 1;
    }
  }
}