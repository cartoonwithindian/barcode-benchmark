import { describe, expect, it } from 'vitest';
import { AnalysisCache } from '../src/analyze/cache.js';
import { withEnv, TEST_ENV, TEST_API_KEY, startImageServer, silentLogger } from './helpers.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import { VisionService } from '../src/analyze/orchestrator.js';

describe('AnalysisCache', () => {
  it('provides key stability: same bytes+fingerprint same key, different differs', () => {
    const buf1 = Buffer.from('hello');
    const buf2 = Buffer.from('hello');
    const buf3 = Buffer.from('world');
    const k1 = AnalysisCache.hash(buf1, 'fp1');
    const k2 = AnalysisCache.hash(buf2, 'fp1');
    expect(k1).toBe(k2);
    const k3 = AnalysisCache.hash(buf3, 'fp1');
    expect(k3).not.toBe(k1);
    const k4 = AnalysisCache.hash(buf1, 'fp2');
    expect(k4).not.toBe(k1);
  });

  it('tracks hits/misses, LRU recency, eviction, TTL, and disabled cache', () => {
    const cache = new AnalysisCache<string>(2, 100); // max 2 entries, ttl 100ms
    // miss
    expect(cache.get('k1')).toBeUndefined();
    let stats = cache.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    stats = cache.stats();
    expect(stats.entries).toBe(2);
    // hit k1 - LRU; then add k3, should evict k2 (oldest)
    expect(cache.get('k1')).toBe('v1'); // hit
    stats = cache.stats();
    expect(stats.hits).toBe(1);
    cache.set('k3', 'v3'); // evict k2
    stats = cache.stats();
    expect(stats.entries).toBe(2);
    expect(stats.evictions).toBe(1);
    // k2 should be evicted
    expect(cache.get('k2')).toBeUndefined();
    // TTL expiry
    const short = new AnalysisCache<string>(5, 1);
    short.set('kttl', 'vttl');
    expect(short.get('kttl')).toBe('vttl');
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(short.get('kttl')).toBeUndefined(); // expired
        // disabled cache - maxEntries <= 0 means nothing stored
        const disabled = new AnalysisCache<string>(0, 1000);
        disabled.set('k', 'v');
        expect(disabled.get('k')).toBeUndefined();
        expect(disabled.stats().entries).toBe(0);
        resolve(null);
      }, 5);
    });
  });

  it('stats object has correct shape', () => {
    const cache = new AnalysisCache(5, 1000);
    const s = cache.stats();
    expect(s).toHaveProperty('hits');
    expect(s).toHaveProperty('misses');
    expect(s).toHaveProperty('entries');
    expect(s).toHaveProperty('evictions');
  });
});

describe('Cache integration with VisionService', () => {
  it('second identical analysis hits cache when enabled', async () => {
    const imgServer = await startImageServer();
    const port = new URL(imgServer.origin).port;
    const env = {
      ...TEST_ENV,
      ALLOWED_URL_PORTS: port,
      CACHE_ENABLED: 'true',
      CACHE_MAX_ENTRIES: '10',
      CACHE_TTL_SECONDS: '300',
      OCR_ENABLED: 'false',
    };
    await withEnv(env, async () => {
      const config = loadConfig();
      const service = new VisionService(config, silentLogger());
      try {
        const url = imgServer.url('barcode-ean13.png');
        // First call - miss
        const res1 = await service.analyze({ image_url: url }, { requestId: 'r1', log: silentLogger() });
        expect(res1.diagnostics.cache_hit).toBe(false);
        // Second call - hit
        const res2 = await service.analyze({ image_url: url }, { requestId: 'r2', log: silentLogger() });
        expect(res2.diagnostics.cache_hit).toBe(true);
        const stats = service.cacheStats;
        expect(stats.hits).toBeGreaterThan(0);
        expect(stats.misses).toBeGreaterThan(0);
      } finally {
        await service.close();
        await imgServer.close();
      }
    });
  }, 120000);
});
