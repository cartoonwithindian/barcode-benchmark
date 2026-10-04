/**
 * Deterministic test-fixture generator.
 *
 * Run with `npm run fixtures`. Everything here is synthetic except the three
 * `real-*` files, which are copied verbatim from the upstream
 * `cartoonwithindian/barcode-benchmark` photo set (their GTINs are recorded in
 * `fixtures/manifest.json`).
 *
 * Why generate rather than commit opaque blobs: the ground truth for a barcode
 * fixture is the value that was encoded, so a test can assert an exact match and
 * a regeneration can be reviewed as a diff.
 */
import { mkdir, copyFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bwipjs from 'bwip-js';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const outDir = path.join(projectRoot, 'tests', 'fixtures');
const upstreamDir = path.resolve(projectRoot, '..');

interface ManifestEntry {
  file: string;
  kind: 'generated' | 'upstream-photo';
  /** Ground truth that a correct pipeline must reproduce. */
  expect?: Record<string, unknown>;
  note?: string;
}

const manifest: ManifestEntry[] = [];

/** EAN-13 rendered as a PNG on a white background. */
async function ean13(value: string, file: string, scale = 3): Promise<void> {
  const png = await bwipjs.toBuffer({
    bcid: 'ean13',
    text: value,
    scale,
    height: 12,
    includetext: true,
    textxalign: 'center',
    barcolor: '000000',
    backgroundcolor: 'FFFFFF',
  });
  await sharp(png).png().toFile(path.join(outDir, file));
  manifest.push({ file, kind: 'generated', expect: { barcode: value, format: 'EAN-13' } });
}

/** QR code, used for the URL-payload path of the barcode response. */
async function qr(value: string, file: string): Promise<void> {
  const png = await bwipjs.toBuffer({
    bcid: 'qrcode',
    text: value,
    scale: 6,
    barcolor: '000000',
    backgroundcolor: 'FFFFFF',
  });
  await sharp(png).png().toFile(path.join(outDir, file));
  manifest.push({ file, kind: 'generated', expect: { barcode: value, format: 'QR Code' } });
}

/**
 * A hard barcode case: low contrast, gaussian-ish noise, a glare patch and a
 * slight rotation. Forces the preprocessing tier to do real work rather than
 * letting ZXing-C++ read the original.
 */
async function degradedEan13(value: string, file: string): Promise<void> {
  const base = await bwipjs.toBuffer({
    bcid: 'ean13',
    text: value,
    scale: 3,
    height: 10,
    includetext: false,
    barcolor: '303030',
    backgroundcolor: 'E8E8E8',
  });

  const svg = `
    <svg width="520" height="220" xmlns="http://www.w3.org/2000/svg">
      <rect width="520" height="220" fill="#cfcfcf"/>
      <circle cx="420" cy="40" r="95" fill="#ffffff" opacity="0.55"/>
    </svg>`;
  const backdrop = await sharp(Buffer.from(svg)).png().toBuffer();
  const bars = await sharp(base).rotate(-2, { background: '#cfcfcf' }).toBuffer();

  // Deterministic value noise (no RNG) so fixtures are byte-reproducible.
  const noise = Buffer.alloc(520 * 220 * 4);
  for (let i = 0; i < 520 * 220; i++) {
    const n = ((i * 2654435761) % 23) - 11;
    const v = Math.max(0, Math.min(255, 200 + n));
    noise[i * 4] = v;
    noise[i * 4 + 1] = v;
    noise[i * 4 + 2] = v;
    noise[i * 4 + 3] = 255;
  }

  await sharp(noise, { raw: { width: 520, height: 220, channels: 4 } })
    .composite([{ input: backdrop, blend: 'over' }, { input: bars, left: 40, top: 60 }])
    .jpeg({ quality: 82 })
    .toFile(path.join(outDir, file));

  manifest.push({
    file,
    kind: 'generated',
    expect: { barcode: value, format: 'EAN-13' },
    note: 'low contrast + glare + rotation + deterministic noise',
  });
}

/**
 * A barcode that *no* engine can read as-is.
 *
 * `degradedEan13` above is still solvable on the `original` variant, so it only
 * proves multi-engine agreement. This is the fixture that actually exercises the
 * preprocessing ladder: measured across all three wired engines, `original`,
 * `grayscale`, `sharpen`, `otsu`, `auto_polarity` and `denoise` return zero
 * hits, and the value only comes back on `clahe` and `adaptive_threshold`.
 *
 * The blur radius was chosen by measurement, not by feel: 1.10 leaves the
 * original readable by all three engines, 1.25 leaves it unreadable by every
 * variant, so 1.15 sits in the narrow middle where preprocessing is the only
 * route. `tests/barcode.test.ts` asserts the zero-hit-on-original property, so
 * if a change to the variant order or the binarisation shifts that boundary
 * the suite fails loudly instead of quietly testing nothing.
 */
async function hardEan13(value: string, file: string): Promise<void> {
  const base = await bwipjs.toBuffer({
    bcid: 'ean13',
    text: value,
    scale: 2,
    height: 12,
    includetext: false,
    barcolor: 'A8A8A8',
    backgroundcolor: 'F2F2F2',
  });

  const width = 420;
  const height = 200;
  const backdrop = await sharp(
    Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#F2F2F2"/></svg>`),
  )
    .png()
    .toBuffer();
  const bars = await sharp(base).rotate(-4, { background: '#F2F2F2' }).blur(1.15).toBuffer();

  // Same deterministic hash noise as the degraded fixture.
  const noise = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const n = ((i * 2654435761) % 51) - 25;
    const v = Math.max(0, Math.min(255, 190 + n));
    noise[i * 4] = v;
    noise[i * 4 + 1] = v;
    noise[i * 4 + 2] = v;
    noise[i * 4 + 3] = 255;
  }

  await sharp(noise, { raw: { width, height, channels: 4 } })
    .composite([{ input: backdrop, blend: 'over' }, { input: bars, left: 30, top: 60 }])
    .jpeg({ quality: 65 })
    .toFile(path.join(outDir, file));

  manifest.push({
    file,
    kind: 'generated',
    expect: { barcode: value, format: 'EAN-13' },
    note: 'zero hits on the original variant; recovered by clahe/adaptive_threshold',
  });
}

/**
 * A synthetic Indian packaged-food label: the exact field layout FoodGuard cares
 * about (INS codes with an OCR-confusable spelling, veg mark, FSSAI licence,
 * MRP, net quantity, nutrition table per 100 g). Text is rendered from the SVG
 * markup below, so the expected OCR content is readable in the source.
 */
async function indianLabel(file: string, gtin: string): Promise<void> {
  const barcodePng = await bwipjs.toBuffer({
    bcid: 'ean13',
    text: gtin,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: 'center',
  });

  const font = 'DejaVu Sans, sans-serif';
  const rows: Array<[string, string]> = [
    ['Protein', '2.0 g'],
    ['Total Fat', '1.5 g'],
    ['Total Carbohydrate', '14.0 g'],
    ['of which Sugars', '9.5 g'],
    ['Sodium', '95 mg'],
    ['Calcium', '110 mg'],
    ['Vitamin A', '50 ug'],
  ];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1250">
  <rect width="900" height="1250" fill="#ffffff"/>
  <rect x="18" y="18" width="864" height="1214" fill="none" stroke="#222222" stroke-width="3"/>

  <g font-family="${font}">
    <text x="60" y="105" font-size="52" font-weight="bold" fill="#111111">Amul Taaza</text>
    <text x="60" y="150" font-size="30" fill="#333333">Toned Fresh Milk</text>

    <rect x="60" y="180" width="26" height="26" fill="none" stroke="#0a7a0a" stroke-width="3"/>
    <text x="96" y="203" font-size="28" fill="#0a7a0a">VEG</text>

    <text x="60" y="270" font-size="30" font-weight="bold" fill="#111111">Ingredients:</text>
    <text x="60" y="310" font-size="25" fill="#222222">Milk, Sugar, INS 621 (Monosodium Glutamate),</text>
    <text x="60" y="348" font-size="25" fill="#222222">Refined Palm Oil, Milk Solids, INS 322,</text>
    <text x="60" y="386" font-size="25" fill="#222222">INS 330, INS 471, Citric Acid, Vitamins A, D, B12.</text>
    <text x="60" y="424" font-size="25" fill="#222222">May contain: Soy, Nuts.</text>

    <text x="60" y="500" font-size="30" font-weight="bold" fill="#111111">Nutrition Information (per 100 ml)</text>
    ${rows
      .map(
        ([k, v], i) =>
          `<text x="60" y="${545 + i * 36}" font-size="25" fill="#222222">${k}</text>` +
          `<text x="640" y="${545 + i * 36}" font-size="25" fill="#222222">${v}</text>`,
      )
      .join('\n    ')}

    <text x="60" y="845" font-size="25" fill="#222222">Net Qty: 500 ml</text>
    <text x="60" y="885" font-size="25" fill="#222222">MRP Rs. 34.00 (Incl. of all taxes)</text>
    <text x="60" y="925" font-size="25" fill="#222222">FSSAI Lic. No. 10012051000123</text>
    <text x="60" y="965" font-size="25" fill="#222222">Best Before: 6 months from manufacturing</text>
    <text x="60" y="1005" font-size="25" fill="#222222">Manufactured by: Amul Dairy, Anand, Gujarat</text>
    <text x="60" y="1045" font-size="25" fill="#222222">Made in India</text>
    <text x="60" y="1085" font-size="25" fill="#222222">Store in a cool place. Use within 3 days of opening.</text>
  </g>
</svg>`;

  const canvas = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  const canvasMeta = await sharp(canvas).metadata();
  const barcodeMeta = await sharp(barcodePng).metadata();
  // The barcode goes in the blank strip below the last text line so a failure
  // cannot be blamed on the barcode overlapping text.
  await sharp(canvas)
    .composite([
      {
        input: await sharp(barcodePng).toBuffer(),
        left: Math.round((canvasMeta.width! - barcodeMeta.width!) / 2),
        top: canvasMeta.height! - barcodeMeta.height! - 60,
      },
    ])
    .png()
    .toFile(path.join(outDir, file));

  manifest.push({
    file,
    kind: 'generated',
    expect: {
      barcode: gtin,
      format: 'EAN-13',
      net_quantity: '500 ml',
      mrp: { amount: 34, currency: 'INR' },
      fssai_license: '10012051000123',
      veg_marker: 'veg',
      ins_codes: ['INS 322', 'INS 330', 'INS 471', 'INS 621'],
      allergen_candidates: ['milk', 'soy', 'nuts'],
      nutrition_nutrients: [
        'protein',
        'total_fat',
        'total_carbohydrate',
        'sugars',
        'sodium',
        'calcium',
        'vitamin_a',
      ],
    },
    note: 'synthetic Indian label; text is in the SVG above',
  });
}

/** A PNG that is a valid image but contains no text and no barcode. */
async function blankPage(file: string): Promise<void> {
  await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 240, g: 240, b: 235 } },
  })
    .png()
    .toFile(path.join(outDir, file));
  manifest.push({ file, kind: 'generated', expect: { barcode: null, ocr_text: null }, note: 'blank page: honest "not found" case' });
}

/** Real product photos copied from the upstream benchmark repository. */
async function copyUpstream(): Promise<void> {
  const candidates: Array<{ rel: string; file: string; expect: Record<string, unknown>; note: string }> = [
    {
      rel: 'Amul-Taaza-Toned-Fresh-Milk-Pouch.jpeg',
      file: 'real-amul-pouch.jpeg',
      expect: { barcode: '8901262260121', format: 'EAN-13' },
      note: 'upstream photo; ZXing-C++ reads this in ~600 ms',
    },
    {
      rel: path.join('untitled folder', '13.jpg'),
      file: 'real-front-13.jpg',
      expect: { barcode: '8906036670014', format: 'EAN-13' },
      note: 'upstream photo; ZXing-C++ and ZBar agree',
    },
    {
      rel: path.join('untitled folder', '15.jpg'),
      file: 'real-qr-and-gtin-15.jpg',
      expect: { barcode: '8905694508257', format: 'EAN-13', also_expects: ['QR Code'] },
      note: 'upstream photo; QR payload plus a retail GTIN',
    },
  ];

  for (const c of candidates) {
    const src = path.join(upstreamDir, c.rel);
    if (!existsSync(src)) {
      console.warn(`skip: upstream photo not found at ${src}`);
      continue;
    }
    await copyFile(src, path.join(outDir, c.file));
    manifest.push({ file: c.file, kind: 'upstream-photo', expect: c.expect, note: c.note });
  }
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  await ean13('8901262260121', 'barcode-ean13.png');
  await qr('https://sidsfarm.app.link/download-app', 'barcode-qr.png');
  await degradedEan13('8901262150989', 'barcode-ean13-degraded.jpg');
  await hardEan13('8901030770005', 'barcode-ean13-hard.jpg');
  await indianLabel('label-indian.png', '8901262260121');
  await blankPage('blank-page.png');
  await writeFile(path.join(outDir, 'not-an-image.txt'), 'this file is plain text, not an image\n');

  await copyUpstream();

  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify({ generated_by: 'scripts/generate-fixtures.ts', fixtures: manifest }, null, 2)}\n`);

  const written = await readdir(outDir);
  console.log(`wrote ${written.length} files to ${path.relative(projectRoot, outDir)}`);
  for (const f of written.sort()) console.log(`  ${f}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});