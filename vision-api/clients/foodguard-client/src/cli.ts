/**
 * `fgv` - command line access to the FoodGuard Vision API.
 *
 * Zero dependencies, same code path as the library client, so anything it
 * prints is exactly what an integration would get back.
 *
 *   npx tsx clients/foodguard-client/src/cli.ts <image-url> [options]
 *
 * Environment:
 *   FOODGUARD_VISION_API_URL   service origin (default the public deployment)
 *   FOODGUARD_VISION_API_KEY   API key; falls back to --key
 *
 * Flags:
 *   --text-only        skip the barcode stage and spend the budget on OCR
 *   --key <key>        API key (use an env var in shared terminals instead)
 *   --url <origin>     service origin
 *   --plan <name>      fast | standard | deep (barcode preprocessing budget)
 *   --timeout <ms>     per-request deadline (default 90000)
 *   --json             print the raw response JSON instead of the summary
 */
import { VisionApiClient } from './client.js';
import { VisionApiError } from './errors.js';
import type { AnalysisResponse } from './types.js';

const DEFAULT_BASE_URL = 'https://foodguard-vision-api.onrender.com';

interface Flags {
  imageUrl: string;
  textOnly: boolean;
  json: boolean;
  plan?: 'fast' | 'standard' | 'deep';
  key?: string;
  url?: string;
  timeoutMs?: number;
}

function parseArgs(argv: string[]): Flags | { error: string } {
  const [imageUrl, ...rest] = argv;
  if (!imageUrl || imageUrl === '--help' || imageUrl === '-h') return { error: 'usage' };

  const flags: Flags = { imageUrl, textOnly: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--text-only':
        flags.textOnly = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--key':
        flags.key = rest[++i];
        break;
      case '--url':
        flags.url = rest[++i];
        break;
      case '--plan': {
        const value = rest[++i];
        if (value !== 'fast' && value !== 'standard' && value !== 'deep') {
          return { error: `--plan must be fast, standard or deep (got "${value}")` };
        }
        flags.plan = value;
        break;
      }
      case '--timeout': {
        const value = Number(rest[++i]);
        if (!Number.isFinite(value) || value < 1000) return { error: '--timeout must be a number of ms (>= 1000)' };
        flags.timeoutMs = value;
        break;
      }
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }
  return flags;
}

function report(r: AnalysisResponse): void {
  const primary = r.barcode.primary;
  const detail = primary
    ? r.barcode.results.find((x) => x.value === primary.value)
    : undefined;
  console.log(`image     ${r.image.width}x${r.image.height} ${r.image.format}`);
  console.log(
    `barcode   ${
      primary
        ? `${primary.value}  ${primary.format}  confidence ${
            primary.confidence === null ? 'unknown' : primary.confidence.toFixed(3)
          } (${primary.confidence_source}${detail?.engines.length ? `, engines: ${detail.engines.join(', ')}` : ''})`
        : r.warnings.includes('barcode_skipped_by_request')
          ? 'skipped (--text-only)'
          : 'not detected'
    }`,
  );
  if (detail?.is_indian_gs1) console.log('          Indian GS1 prefix (890...)');

  console.log(`ocr       ${r.ocr.detected ? `confidence ${r.ocr.confidence}` : 'no text detected'}`);
  if (r.ocr.raw_text.trim()) {
    console.log('--- text -----------------------------------------------------------');
    console.log(r.ocr.raw_text.trim());
    console.log('---------------------------------------------------------------------');
  }

  const items = r.ingredients.items ?? [];
  console.log(`ingredients ${r.ingredients.detected ? `${items.length} found (confidence ${r.ingredients.confidence})` : 'not found'}`);
  for (const item of items) console.log(`  - ${item.raw}${item.normalized !== item.raw.toLowerCase() ? `  (${item.normalized})` : ''}`);

  const signals = r.signals;
  console.log(
    `signals   ingredient_list=${signals.ingredient_list_found} nutrition_panel=${signals.nutrition_panel_found} ` +
      `quality=${signals.image_quality ?? signals.image_quality_score} ins_codes=${signals.ins_codes.join(', ') || '-'}`,
  );
  const allergens = [...new Set([...r.allergens.declared, ...r.allergens.from_ingredients])];
  if (allergens.length) console.log(`allergens ${allergens.join(', ')}`);
  console.log(`took      ${r.diagnostics.processing_time_ms} ms${r.diagnostics.cache_hit ? ' (cache hit)' : ''}`);
  if (r.warnings.length) console.log(`warnings  ${r.warnings.join(', ')}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error === 'usage' ? 'usage: cli.ts <image-url> [--text-only] [--json] [--plan fast|standard|deep] [--timeout ms]' : parsed.error);
    process.exit(parsed.error === 'usage' ? 0 : 2);
  }

  const client = VisionApiClient.fromEnv(process.env, {
    baseUrl: parsed.url ?? process.env.FOODGUARD_VISION_API_URL ?? DEFAULT_BASE_URL,
    apiKey: parsed.key ?? process.env.FOODGUARD_VISION_API_KEY,
    timeoutMs: parsed.timeoutMs,
  });

  const response = await client.analyze({
    image_url: parsed.imageUrl,
    options: { detect_barcode: !parsed.textOnly, plan: parsed.plan },
  });

  if (parsed.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  report(response);
}

main().catch((err: unknown) => {
  if (err instanceof VisionApiError) {
    console.error(`error ${err.code ?? ''} ${err.httpStatus}: ${err.message}`.trim());
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});