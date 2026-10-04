/**
 * Content-addressed response cache.
 *
 * Key = SHA-256 of the downloaded image bytes + a fingerprint of the options
 * that change the result. Because the key is the *content* hash, the same image
 * URL re-fetched (or a different CDN URL serving the same bytes) hits the cache,
 * and no image is ever written to disk.
 *
 * Bounded LRU with a TTL. On Render the instance may be evicted at any time; a
 * cache miss is always safe, so nothing here needs to be durable.
 */
import { createHash } from 'node:crypto';

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  evictions: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class AnalysisCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  static hash(buffer: Buffer | Uint8Array, fingerprint: string): string {
    const hash = createHash('sha256');
    hash.update(buffer);
    hash.update('|');
    hash.update(fingerprint);
    return hash.digest('hex');
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency: re-inserting moves the key to the end of the Map.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.maxEntries <= 0) return;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
      this.evictions++;
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.store.size, evictions: this.evictions };
  }
}
