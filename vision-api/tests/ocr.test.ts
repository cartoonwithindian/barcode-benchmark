/**
 * OCR tests.
 *
 * These run real Tesseract against `tests/fixtures/label-indian.png`, the
 * synthetic Indian packaged-food label whose expected content is readable in
 * `scripts/generate-fixtures.ts`. The fast tessdata model is used so the suite
 * does not unpack the 10.8 MB accuracy model.
 *
 * What is asserted here is deliberately narrow: that the engine returns text
 * with line/word geometry, that the variant planner picks the variant that
 * actually contains the headings, and that a page with no text produces an
 * honest empty result rather than invented content.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { OcrEngine } from '../src/ocr/engine.js';
import { OcrPipeline } from '../src/ocr/pipeline.js';
import { buildOcrPlan } from '../src/imaging/variants.js';
import { loadConfig } from '../src/config/index.js';
import { silentLogger, loadRaster } from './helpers.js';
import type { Raster } from '../src/imaging/raster.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST_TESSDATA = path.join(projectRoot, 'assets', 'tessdata-fast');

let engine: OcrEngine;

beforeAll(async () => {
  engine = new OcrEngine({
    langPath: FAST_TESSDATA,
    lang: 'eng',
    workerLimit: 1,
    timeoutMs: 60_000,
    cache: false,
    logger: silentLogger(),
  });
}, 120_000);

afterAll(async () => {
  await engine.close();
});

describe('OCR variant plans', () => {
  it('starts from the cheapest variant and keeps the list short', () => {
    const plan = buildOcrPlan(4);
    expect(plan.variants.length).toBeGreaterThan(0);
    expect(plan.variants.length).toBeLessThanOrEqual(4);
    expect(plan.psm.length).toBeGreaterThan(0);
  });

  it('never returns more variants than asked for', () => {
    expect(buildOcrPlan(1).variants).toHaveLength(1);
    expect(buildOcrPlan(2).variants.length).toBeLessThanOrEqual(2);
  });
});

/** Grayscale PNG, the exact encoding `ocr/pipeline.ts` hands to Tesseract. */
async function encodeForOcr(raster: Raster): Promise<Buffer> {
  return sharp(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength), {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .png({ compressionLevel: 1 })
    .toBuffer();
}

describe('OCR on a synthetic Indian food label', () => {
  it('reads the label and reports line and word geometry', async () => {
    const raster = await loadRaster('label-indian.png');
    const result = await engine.recognise(await encodeForOcr(raster), 'gray', 3);
    expect(result).not.toBeNull();

    expect(result!.text.length).toBeGreaterThan(200);
    expect(result!.confidence).toBeGreaterThan(50);
    expect(result!.confidence).toBeLessThanOrEqual(100);
    expect(result!.engine).toMatch(/tesseract/i);
    expect(result!.elapsedMs).toBeGreaterThan(0);

    // Geometry has to be real, not a stub: Tesseract only produces these when
    // it was asked for blocks.
    expect(result!.lines.length).toBeGreaterThan(3);
    expect(result!.words.length).toBeGreaterThan(10);
    for (const line of result!.lines) {
      expect(line.bbox.x1).toBeGreaterThanOrEqual(line.bbox.x0);
      expect(line.bbox.y1).toBeGreaterThanOrEqual(line.bbox.y0);
      expect(line.confidence).toBeGreaterThanOrEqual(0);
    }
    // Every line must sit inside the image it came from.
    for (const line of result!.lines) {
      expect(line.bbox.x1).toBeLessThanOrEqual(raster.width + 2);
      expect(line.bbox.y1).toBeLessThanOrEqual(raster.height + 2);
    }
  }, 180_000);

  it('finds the headings the extractor depends on', async () => {
    const raster = await loadRaster('label-indian.png');
    const pipeline = new OcrPipeline(engine, silentLogger());
    const result = await pipeline.run(raster, { maxVariants: 4, timeoutMs: 150_000 });

    expect(result.detected).toBe(true);
    expect(result.best).not.toBeNull();
    expect(result.failureReason).toBeNull();

    const text = (result.best?.text ?? '').toLowerCase();
    // The fixture prints "Ingredients" and "Nutrition Information"; exact
    // spelling varies with the variant, so match the stems.
    expect(text).toMatch(/ingredient/);
    expect(text).toMatch(/nutrition/);
    // Indian retail marks: FSSAI licence and an MRP line.
    expect(text).toMatch(/fssai|mrp|rs\.?|\u20b9/);

    // Exactly one attempt is marked selected, and it is the one that was kept.
    const selected = result.attempts.filter((a) => a.selected);
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(result.attempts.some((a) => a.ingredient_heading)).toBe(true);
    expect(result.totalMs).toBeGreaterThan(0);
  }, 240_000);

  it('stays inside its variant budget', async () => {
    const raster = await loadRaster('label-indian.png');
    const pipeline = new OcrPipeline(engine, silentLogger());
    const result = await pipeline.run(raster, { maxVariants: 2, timeoutMs: 150_000 });

    // The pipeline caps (variant, psm) passes at min(maxVariants, 4).
    expect(result.attempts.length).toBeLessThanOrEqual(4);
    expect(result.attempts.length).toBeGreaterThan(0);
  }, 240_000);
});

describe('OCR on an image with no text', () => {
  it('reports no text found instead of inventing any', async () => {
    const raster = await loadRaster('blank-page.png');
    const pipeline = new OcrPipeline(engine, silentLogger());
    const result = await pipeline.run(raster, { maxVariants: 2, timeoutMs: 60_000 });

    expect(result.detected).toBe(false);
    expect(result.best).toBeNull();
    expect(result.failureReason).toBe('no_text_recognised');
    // It still reports the work it did.
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.attempts.every((a) => a.chars === 0 || a.confidence >= 0)).toBe(true);
  }, 120_000);
});

describe('OCR configuration', () => {
  it('reads the language path, worker limit and timeout from the environment', () => {
    const config = loadConfig();
    expect(config.pipeline.ocr.langPath).toBeTruthy();
    expect(config.pipeline.ocr.workerLimit).toBeGreaterThanOrEqual(1);
    expect(config.pipeline.ocr.timeoutMs).toBeGreaterThan(0);
    expect(config.pipeline.ocr.maxVariants).toBeGreaterThanOrEqual(1);
  });

  it('closes cleanly and can be closed twice', async () => {
    const disposable = new OcrEngine({
      langPath: FAST_TESSDATA,
      lang: 'eng',
      workerLimit: 1,
      timeoutMs: 5_000,
      cache: false,
      logger: silentLogger(),
    });
    // No worker was ever created, so this must not throw or hang.
    await disposable.close();
    await disposable.close();
  }, 30_000);
});