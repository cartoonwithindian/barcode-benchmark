/**
 * Barcode engine + fusion tests.
 *
 * These run the real engines (ZXing-C++ WASM, ZBar WASM, ZXing-TS) against the
 * fixtures, so they verify actual decode behaviour rather than mocks. Expected
 * values come from `tests/fixtures/manifest.json`, which records the GTIN that
 * was encoded (or read off the upstream photo during the earlier probe).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineRegistry } from '../src/barcode/registry.js';
import { BarcodePipeline } from '../src/barcode/pipeline.js';
import { fuseBarcodeResults, selectPrimaryBarcode } from '../src/barcode/fusion.js';
import { isValidGtinCheckDigit } from '../src/barcode/formats.js';
import { buildVariantPlan } from '../src/imaging/variants.js';
import type { BarcodeResult } from '../src/barcode/types.js';
import type { Raster } from '../src/imaging/raster.js';
import { loadRaster, silentLogger } from './helpers.js';
import sharp from 'sharp';

const registry = new EngineRegistry(silentLogger());
const pipeline = new BarcodePipeline(registry, silentLogger());

beforeAll(async () => {
  await pipeline.warmUp();
}, 120_000);

afterAll(() => {
  // WASM modules hold no external resources that need releasing; the adapters
  // are stateless after initialise().
});

describe('engine registry', () => {
  it('loads three engines and reports Quagga2 honestly as unsupported', () => {
    const report = registry.statusReport();
    const byName = Object.fromEntries(report.map((e) => [e.name, e]));

    expect(Object.keys(byName).sort()).toEqual(['Quagga2', 'ZBar', 'ZXing-C++', 'ZXing-TS']);
    expect(byName['ZXing-C++']?.status).toBe('available');
    expect(byName.ZBar?.status).toBe('available');
    expect(byName['ZXing-TS']?.status).toBe('available');

    // Quagga2 really does load on Node but cannot decode without canvas; the
    // registry must say so rather than pretend it is available.
    expect(byName.Quagga2?.status).toBe('platform_unsupported');
    expect(byName.Quagga2?.reason).toBeTruthy();
    expect(byName.Quagga2?.reason).toMatch(/node/i);
  });

  it('excludes the unavailable engine from the decode plan', () => {
    const plan = registry.getPlan(4).map((e) => e.getName());
    expect(plan).not.toContain('Quagga2');
    expect(plan).toContain('ZXing-C++');
  });

  it('initialising twice is a no-op', async () => {
    const before = registry.statusReport().find((e) => e.name === 'ZXing-C++');
    await registry.warmUp();
    const after = registry.statusReport().find((e) => e.name === 'ZXing-C++');
    expect(after?.status).toBe(before?.status);
  });
});

describe('variant plans', () => {
  it('escalates from few variants to many as the plan deepens', () => {
    const fast = buildVariantPlan('fast', 40);
    const standard = buildVariantPlan('standard', 40);
    const deep = buildVariantPlan('deep', 40);
    expect(fast.variants.length).toBeLessThan(standard.variants.length);
    expect(standard.variants.length).toBeLessThanOrEqual(deep.variants.length);
    // `original` always comes first so a clean image costs one decode.
    expect(fast.variants[0]).toBe('original');
    expect(standard.variants[0]).toBe('original');
    expect(deep.variants[0]).toBe('original');
  });

  it('honours the variant cap', () => {
    expect(buildVariantPlan('deep', 3).variants.length).toBeLessThanOrEqual(4);
    expect(buildVariantPlan('deep', 1).variants).toEqual(['original']);
  });
});

describe('barcode pipeline on generated fixtures', () => {
  it('reads a clean EAN-13 and reports the exact value', async () => {
    const raster = await loadRaster('barcode-ean13.png');
    const result = await pipeline.run(raster, { plan: 'fast', maxVariants: 4, maxMs: 8000 });

    expect(result.detected).toBe(true);
    expect(result.primary?.value).toBe('8901262260121');
    expect(result.primary?.format).toBe('EAN-13');
    expect(result.primary?.is_retail_gtin).toBe(true);
    // Derived confidence, honestly labelled: no engine in this build exposes a
    // per-result score, so the number must not claim an engine origin.
    expect(result.primary?.confidence_source).toBe('derived');
    expect(result.primary?.confidence).toBeGreaterThan(0);
    expect(result.primary?.confidence).toBeLessThanOrEqual(1);
    expect(result.primary?.engines.length).toBeGreaterThan(0);
  }, 60_000);

  it('recovers a GTIN from the degraded fixture and stops once engines agree', async () => {
    const raster = await loadRaster('barcode-ean13-degraded.jpg');
    const result = await pipeline.run(raster, { plan: 'standard', maxVariants: 8, maxMs: 20_000 });

    expect(result.detected).toBe(true);
    expect(result.primary?.value).toBe('8901262150989');
    // Two independent engines on the first variant is enough; burning the rest
    // of the plan would cost latency for no extra evidence.
    expect(result.primary!.engines.length).toBeGreaterThanOrEqual(2);
    expect(result.stopReason).toBe('multi_engine_agreement');
    expect(result.stoppedEarly).toBe(true);
  }, 60_000);

  it('recovers a GTIN that no engine can read without preprocessing', async () => {
    const raster = await loadRaster('barcode-ean13-hard.jpg');
    const result = await pipeline.run(raster, { plan: 'standard', maxVariants: 9, maxMs: 25_000 });

    expect(result.detected).toBe(true);
    expect(result.primary?.value).toBe('8901030770005');
    // The fixture's whole purpose: the first variant found nothing, so the
    // pipeline had to walk the plan before anything came back.
    expect(result.variantsUsed[0]).toBe('original');
    expect(result.variantsUsed.length).toBeGreaterThan(1);
    expect(result.primary!.variants.some((v) => v !== 'original')).toBe(true);
  }, 90_000);

  it('reads a QR payload and flags it as a URL, not a GTIN', async () => {
    const raster = await loadRaster('barcode-qr.png');
    const result = await pipeline.run(raster, { plan: 'fast', maxVariants: 4, maxMs: 8000 });

    expect(result.detected).toBe(true);
    expect(result.primary?.value).toBe('https://sidsfarm.app.link/download-app');
    expect(result.primary?.format).toBe('QR Code');
    expect(result.primary?.is_url_payload).toBe(true);
    expect(result.primary?.is_retail_gtin).toBe(false);
  }, 60_000);

  it('reports detected:false with no results for an image with no barcode', async () => {
    const raster = await loadRaster('blank-page.png');
    const result = await pipeline.run(raster, { plan: 'fast', maxVariants: 3, maxMs: 8000 });

    expect(result.detected).toBe(false);
    expect(result.fused).toEqual([]);
    expect(result.primary).toBeNull();
    // It still did the work and reported it.
    expect(result.attempts.some((a) => a.variants_tried > 0)).toBe(true);
  }, 60_000);

  it('stops early once a high-confidence value is confirmed', async () => {
    const raster = await loadRaster('barcode-ean13.png');
    const result = await pipeline.run(raster, { plan: 'deep', maxVariants: 20, maxMs: 25_000 });
    expect(result.detected).toBe(true);
    // `deep` offers 20 variants; a clean image must not need all of them.
    expect(result.variantsUsed.length).toBeLessThan(20);
    expect(result.stoppedEarly || result.variantsUsed.length < 20).toBe(true);
  }, 60_000);
});

describe('barcode pipeline on real upstream photos', () => {
  const cases: Array<{ file: string; value: string }> = [
    { file: 'real-amul-pouch.jpeg', value: '8901262260121' },
    { file: 'real-front-13.jpg', value: '8906036670014' },
    { file: 'real-qr-and-gtin-15.jpg', value: '8905694508257' },
  ];

  for (const c of cases) {
    it(`reads ${c.value} from ${c.file}`, async () => {
      const raster = await loadRaster(c.file);
      const result = await pipeline.run(raster, { plan: 'standard', maxVariants: 8, maxMs: 25_000 });
      const values = result.fused.map((f) => f.value);
      expect(values).toContain(c.value);
      // The GTIN must be the primary, i.e. preferred over any QR payload.
      expect(result.primary?.value).toBe(c.value);
      expect(result.primary?.format).toBe('EAN-13');
    }, 90_000);
  }
});

describe('multi-engine agreement on a real photo', () => {
  it('reports more than one observing engine on the clean label fixture', async () => {
    const raster = await loadRaster('label-indian.png');
    const result = await pipeline.run(raster, { plan: 'standard', maxVariants: 8, maxMs: 20_000 });
    const ean = result.fused.find((f) => f.value === '8901262260121');
    expect(ean).toBeDefined();
    expect(ean!.engines.length).toBeGreaterThan(1);
    expect(ean!.agreement).toBeGreaterThanOrEqual(2);
    // Agreement raises derived confidence above the single-engine floor.
    expect(ean!.confidence_breakdown.agreement).toBeGreaterThan(0);
    expect(ean!.confidence!).toBeGreaterThan(
      result.fused.find((f) => f.engines.length === 1)?.confidence ?? 0,
    );
  }, 90_000);
});

/** Fusion options used by the assertions below; matches the service default. */
const FUSION = { minConfidence: 0, maxResults: 10 };

describe('fusion', () => {
  const base: BarcodeResult = {
    value: '8901262260121',
    format: 'EAN-13',
    engine: 'ZXing-C++',
    variant: 'original',
    decodeTimeMs: 40,
    // No engine in this build reports a per-result score, and the type says so.
    engineConfidence: null,
  };

  it('merges identical payloads from different engines and raises confidence', () => {
    const fused = fuseBarcodeResults([base, { ...base, engine: 'ZBar', decodeTimeMs: 20 }], FUSION);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.engines.sort()).toEqual(['ZBar', 'ZXing-C++']);
    expect(fused[0]!.agreement).toBe(2);
    expect(fused[0]!.observations).toBe(2);
    expect(fused[0]!.confidence_source).toBe('derived');
    expect(fused[0]!.fastest_ms).toBe(20);
  });

  it('keeps different payloads separate instead of merging them', () => {
    const fused = fuseBarcodeResults([base, { ...base, value: '8906036670014', engine: 'ZBar' }], FUSION);
    expect(fused).toHaveLength(2);
    expect(fused.every((f) => f.agreement === 1)).toBe(true);
  });

  it('trims surrounding whitespace off a payload before grouping', () => {
    const fused = fuseBarcodeResults([base, { ...base, engine: 'ZBar', value: '8901262260121 ' }], FUSION);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.value).toBe('8901262260121');
    expect(fused[0]!.agreement).toBe(2);
  });

  it('drops a checksum-failing short reading when a valid GTIN is present', () => {
    // UPC-A and EAN-13 can read the same physical symbol with different
    // padding. When the padded reading fails its own check digit it is not a
    // second opinion, it is a misread, and it must not reach the caller.
    const fused = fuseBarcodeResults(
      [
        { ...base, value: '8901262260121', format: 'EAN-13', engine: 'ZXing-C++' },
        { ...base, value: '890126226012', format: 'UPC-A', engine: 'ZBar' },
      ],
      FUSION,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]!.value).toBe('8901262260121');
  });

  it('still reports a weak reading when it is the only candidate', () => {
    // No leader to compare against means nothing is silently suppressed.
    const fused = fuseBarcodeResults([{ ...base, value: '890126226012', format: 'UPC-A' }], FUSION);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.confidence_breakdown.structural).toBeLessThan(0.1);
  });

  it('picks the retail GTIN as primary over a URL payload', () => {
    const fused = fuseBarcodeResults([
      { ...base, value: 'https://sidsfarm.app.link/download-app', format: 'QR Code', engine: 'ZXing-C++' },
      { ...base, engine: 'ZBar' },
    ], FUSION);
    const primary = selectPrimaryBarcode(fused);
    expect(primary?.value).toBe('8901262260121');
    expect(primary?.is_retail_gtin).toBe(true);
  });

  it('returns null for an empty candidate list', () => {
    expect(selectPrimaryBarcode([])).toBeNull();
    expect(fuseBarcodeResults([], FUSION)).toEqual([]);
  });

  it('never reports an engine confidence that an engine did not provide', () => {
    const fused = fuseBarcodeResults([base], FUSION);
    expect(fused[0]!.engine_confidence.every((e) => e.confidence === null)).toBe(true);
    expect(fused[0]!.confidence_source).toBe('derived');
  });

  it('ranks a repeatedly reproduced payload above a single lucky misread', () => {
    // Both values pass the GTIN check digit, so the checksum cannot separate
    // them. Repeatability across (engine, variant) attempts is the only honest
    // discriminator, and it is the one a product lookup depends on.
    const misread: BarcodeResult = { ...base, value: '0777607162102' };
    const observed = Array.from({ length: 6 }, () => ({ ...base, variant: `v${Math.random()}` }));
    const fused = fuseBarcodeResults([misread, ...observed], FUSION);

    expect(fused.map((f) => f.value)).toEqual(['8901262260121', '0777607162102']);
    expect(selectPrimaryBarcode(fused)?.value).toBe('8901262260121');
    expect(fused[0]!.confidence_breakdown.consistency).toBeGreaterThan(
      fused[1]!.confidence_breakdown.consistency,
    );
  });

  it('scores a checksum-failing GTIN below a checksum-valid one', () => {
    const good = fuseBarcodeResults([base], FUSION)[0]!;
    const bad = fuseBarcodeResults([{ ...base, value: '8901262260122' }], FUSION)[0]!;
    expect(good.confidence_breakdown.structural).toBe(1);
    expect(bad.confidence_breakdown.structural).toBeLessThan(0.1);
    expect(good.confidence!).toBeGreaterThan(bad.confidence!);
  });
});

describe('GTIN check digits', () => {
  it('accepts known-good GTINs from the fixtures and the GS1 reference example', () => {
    for (const v of ['8901262260121', '8901262150989', '8906036670014', '8905694508257', '8901030770005', '77288752', '4006381333931']) {
      expect(isValidGtinCheckDigit(v), v).toBe(true);
    }
  });

  it('rejects a single wrong digit', () => {
    expect(isValidGtinCheckDigit('8901262260122')).toBe(false);
    expect(isValidGtinCheckDigit('8901030770006')).toBe(false);
    expect(isValidGtinCheckDigit('8901262160121')).toBe(false);
  });

  it('rejects values that are not GTIN-shaped', () => {
    expect(isValidGtinCheckDigit('89012622601')).toBe(false);
    expect(isValidGtinCheckDigit('890126226012a')).toBe(false);
  });
});

describe('preprocessing produces decodable variants', () => {
  /** Shrink a raster by an integer factor, mimicking a smaller upload. */
  async function downscale(raster: Raster, factor: number): Promise<Raster> {
    const out = await sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: 4 },
    })
      .resize({ width: Math.round(raster.width / factor) })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: out.info.width, height: out.info.height, data: new Uint8ClampedArray(out.data) };
  }

  it('grayscale + contrast + sharpen keep the barcode readable', async () => {
    const raster = await loadRaster('barcode-ean13.png');
    const { applyVariant } = await import('../src/imaging/preprocessing.js');
    const names = ['original', 'grayscale', 'clahe', 'sharpen'] as const;
    const variants = await Promise.all(names.map((n) => applyVariant(raster, n)));

    expect(variants).toHaveLength(4);
    for (const v of variants) {
      expect(v.width).toBe(raster.width);
      expect(v.height).toBe(raster.height);
      // Still RGBA so downstream engines see the layout they expect.
      expect(v.data.length).toBe(v.width * v.height * 4);
    }

    const zxing = registry.getPlan(1)[0]!;
    await zxing.initialise();
    const decodes = await Promise.all(variants.map((v) => zxing.decode(v, {})));
    expect(decodes.flat().some((d) => d.value === '8901262260121')).toBe(true);
  }, 60_000);

  it('upscale2x doubles the raster dimensions', async () => {
    const raster = await loadRaster('barcode-ean13.png');
    const { applyVariant } = await import('../src/imaging/preprocessing.js');
    const big = await applyVariant(raster, 'upscale2x');

    expect(big.width).toBe(raster.width * 2);
    expect(big.height).toBe(raster.height * 2);
    expect(big.data.length).toBe(big.width * big.height * 4);
  }, 60_000);

  it('recovers more engine agreement on a marginal read once binarised', async () => {
    // A barcode scaled down to ~95px is below the comfort zone: only one engine
    // reads it as handed over. Thresholding is what turns that into agreement.
    const raster = await loadRaster('barcode-ean13.png');
    const small = await downscale(raster, 3);
    const { applyVariant } = await import('../src/imaging/preprocessing.js');
    const engines = registry.getPlan(3);

    const hitsFor = async (variant: 'original' | 'otsu'): Promise<number> => {
      const img = await applyVariant(small, variant);
      let hits = 0;
      for (const e of engines) {
        if ((await e.decode(img, {})).some((d) => d.value === '8901262260121')) hits += 1;
      }
      return hits;
    };

    const raw = await hitsFor('original');
    const binarised = await hitsFor('otsu');
    expect(raw).toBeGreaterThan(0);
    expect(binarised).toBeGreaterThan(raw);
  }, 90_000);

  it('reports nothing rather than guessing below the resolution floor', async () => {
    // ~72px wide: past the point where the modules carry enough signal. The
    // contract is an honest empty result, not a plausible-looking GTIN.
    const raster = await loadRaster('barcode-ean13.png');
    const tiny = await downscale(raster, 4);
    const result = await pipeline.run(tiny, { plan: 'deep', maxVariants: 20, maxMs: 30_000 });

    expect(result.detected).toBe(false);
    expect(result.primary).toBeNull();
    expect(result.fused).toEqual([]);
    // It really did try, on every variant in the plan.
    expect(result.variantsUsed.length).toBeGreaterThan(5);
    expect(result.attempts.filter((a) => a.variants_tried > 0).length).toBeGreaterThan(1);
  }, 90_000);
});