/**
 * Runnable end-to-end example for the FoodGuard reference client.
 *
 *   npx tsx clients/foodguard-client/examples/analyze.ts <image-url>
 *   FOODGUARD_VISION_API_URL=http://127.0.0.1:8080 \
 *   FOODGUARD_VISION_API_KEY=<key> \
 *   npx tsx clients/foodguard-client/examples/analyze.ts <image-url> --json
 *
 * Flags:
 *   --url <url>     image URL (or pass it positionally, or set FOODGUARD_IMAGE_URL)
 *   --file <path>   base64-encode a local image and prove what the service does
 *                   with it — see the note printed in that branch. There is no
 *                   `image_base64` field in the contract.
 *   --ocr=false     skip OCR (barcode-only: seconds, not a minute)
 *   --plan <p>      fast | standard | deep
 *   --json          also print the raw analysis JSON
 *
 * There is no hardcoded key anywhere in this file. The key comes from
 * FOODGUARD_VISION_API_KEY (or --api-key) and this example refuses to run
 * against an authenticated service without one.
 */
import { readFile } from 'node:fs/promises';
import {
  FoodGuardClientError,
  VisionApiClient,
  describeDetection,
  extractSignals,
  summarizeForLookup,
  VisionApiError,
  VisionApiTimeoutError,
  VisionApiTransportError,
  type AnalyzeOptions,
} from '../src/index.js';

interface Args {
  url: string | null;
  file: string | null;
  json: boolean;
  options: AnalyzeOptions;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { url: null, file: null, json: false, options: {} };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`flag ${arg} needs a value`);
      i++;
      return value;
    };
    if (arg === '--url') args.url = next();
    else if (arg === '--file') args.file = next();
    else if (arg === '--json') args.json = true;
    else if (arg === '--plan') args.options.plan = next() as AnalyzeOptions['plan'];
    else if (arg === '--ocr') args.options.ocr = next() !== 'false';
    else if (arg === '--no-ocr') args.options.ocr = false;
    else if (arg === '--help' || arg === '-h') throw new UsageError('help');
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  if (args.url === null && positional.length > 0) args.url = positional[0] ?? null;
  if (positional.length > 1) throw new UsageError('only one image URL may be given');
  return args;
}

class UsageError extends Error {}

const USAGE = `usage: npx tsx clients/foodguard-client/examples/analyze.ts <image-url> [--json] [--plan fast|standard|deep] [--no-ocr]

environment:
  FOODGUARD_VISION_API_URL    service origin (default http://127.0.0.1:8080)
  FOODGUARD_VISION_API_KEY    API key; required by the service when API_KEYS is set
  FOODGUARD_IMAGE_URL         alternative to the positional URL
  FOODGUARD_VISION_TIMEOUT_MS client deadline override (default 60000)`;

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message === 'help' ? '' : `${error.message}\n\n`}${USAGE}\n`);
      return error.message === 'help' ? 0 : 2;
    }
    throw error;
  }

  const apiKey = process.env.FOODGUARD_VISION_API_KEY;
  const baseUrl = process.env.FOODGUARD_VISION_API_URL ?? 'http://127.0.0.1:8080';

  if (args.file !== null) return probeStrictBody(args, baseUrl, apiKey);

  const imageUrl = args.url ?? process.env.FOODGUARD_IMAGE_URL ?? null;
  if (imageUrl === null) {
    process.stderr.write(`no image URL given\n\n${USAGE}\n`);
    return 2;
  }
  if (!apiKey) {
    // Not fatal: the service starts with no authentication when API_KEYS is
    // empty (src/config/index.ts:48, 174). Say so rather than guessing.
    process.stderr.write(
      'warning: FOODGUARD_VISION_API_KEY is not set, so no key is sent.\n' +
        `         If the service reports 401, set it (the service reads API_KEYS; src/config/index.ts:48).\n`,
    );
  }

  const client = VisionApiClient.fromEnv(process.env, {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    logger: { warn: (message, fields) => process.stderr.write(`[client] ${message} ${JSON.stringify(fields)}\n`) },
  });

  process.stderr.write(`POST ${client.baseUrl}/v1/analyze (deadline ${client.timeoutMs}ms)\n`);
  const { data, requestId, attempts } = await client.analyzeWithMeta(
    { image_url: imageUrl, ...(Object.keys(args.options).length > 0 ? { options: args.options } : {}) },
    { ...(process.env.FOODGUARD_REQUEST_ID ? { requestId: process.env.FOODGUARD_REQUEST_ID } : {}) },
  );

  printSummary(data, requestId, attempts);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
  return 0;
}

/**
 * `--file <path>`: the service takes a URL, not bytes.
 *
 * The example encodes the file anyway and sends the body it *would* need, so the
 * contract is demonstrated rather than asserted: the body schema is `.strict()`
 * (src/routes/analyze.ts:22-36), so `image_base64` comes back as
 * `VALIDATION_ERROR` (400). Host the file and pass a URL for a real analysis.
 */
async function probeStrictBody(args: Args, baseUrl: string, apiKey: string | undefined): Promise<number> {
  const path = args.file as string;
  const bytes = await readFile(path);
  const base64 = bytes.toString('base64');
  process.stderr.write(
    `read ${path} (${bytes.length} bytes, ${base64.length} base64 chars)\n` +
      'note: POST /v1/analyze accepts image_url only. The body schema is .strict()\n' +
      '      (src/routes/analyze.ts:22-36), so image_base64 is rejected as VALIDATION_ERROR.\n' +
      '      Sending it once to show the real failure and the error the client maps it to.\n',
  );

  const client = new VisionApiClient({
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: 15_000,
  });

  // Deliberately off-contract so the rejection is visible; typed as unknown
  // because `AnalyzeRequest` has no such field and the client must not pretend
  // otherwise.
  const offContractBody = { image_url: 'https://example.invalid/ignored.jpg', image_base64: base64 };
  try {
    const response = await fetch(`${client.baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(offContractBody),
    });
    const text = await response.text();
    process.stdout.write(`HTTP ${response.status}\n${text}\n`);
    if (response.ok) {
      process.stderr.write('unexpected: the service accepted image_base64. Report it — the client needs updating.\n');
      return 1;
    }
    process.stderr.write('as expected: the strict body schema refused the extra field.\n');
    return 0;
  } catch (error) {
    // A transport failure here is a real problem with the service, not a demo.
    throw error;
  }
}

function printSummary(data: import('../src/types.js').AnalysisResponse, requestId: string | null, attempts: number): void {
  const detection = describeDetection(data);
  const lookup = summarizeForLookup(data);
  const signals = extractSignals(data);

  const lines: string[] = [];
  lines.push('');
  lines.push(`schema        ${data.schema_version}   request_id ${data.request_id}${requestId && requestId !== data.request_id ? ` (header ${requestId})` : ''}   attempts ${attempts}`);
  lines.push(`image         ${data.image.width}x${data.image.height} ${data.image.format} ${data.image.megapixels.toFixed(2)}MP quality=${data.signals.image_quality} (${data.signals.image_quality_score.toFixed(2)}) source=${data.image.source}`);
  lines.push(`barcode       ${detection.state.toUpperCase()} — ${detection.message}`);
  if (lookup) {
    lines.push(
      `  value       ${lookup.value} (${lookup.format}) confidence=${formatScore(lookup.confidence)} via ${lookup.confidenceSource}`,
    );
    lines.push(`  selection   ${lookup.selection}  gtin=${lookup.isRetailGtin} indian_gs1=${lookup.isIndianGs1} url_payload=${lookup.isUrlPayload} key=${lookup.lookupKeyKind}`);
    lines.push(`  evidence    engines=[${lookup.engines.join(',')}] agreement=${lookup.agreement} observations=${lookup.observations}`);
    lines.push(`  breakdown   ${JSON.stringify(lookup.confidenceBreakdown)}`);
    lines.push(`  usable      ${detection.isUsableForLookup} for a GTIN lookup`);
  }
  for (const reason of detection.reasons) lines.push(`  -           ${reason}`);

  lines.push(`ocr           detected=${data.ocr.detected} engine_confidence=${formatScore(data.ocr.confidence)} variants=${data.ocr.variants_attempted.length} selected=${data.ocr.best_variant ?? 'none'} ms=${Math.round(data.ocr.ms)}${data.ocr.failure_reason ? ` failure=${data.ocr.failure_reason}` : ''}`);
  lines.push(`ingredients   detected=${data.ingredients.detected} items=${data.ingredients.items.length} heading=${quote(data.ingredients.heading)}`);
  lines.push(`nutrition     detected=${data.nutrition.detected} values=${data.nutrition.values.length} basis=${quote(data.nutrition.basis)}`);
  lines.push('');
  lines.push('retail signals');
  lines.push(`  ins codes     ${formatList(signals.insCodes)}`);
  lines.push(`  allergens     ${formatList(signals.allergens.all)}${signals.allergens.declaredInSection ? ' (declared section present)' : ' (no allergen section printed)'}`);
  lines.push(`  cross-contam  ${formatList(signals.allergens.crossContamination)}`);
  lines.push(
    `  veg marker    ${signals.vegMarker ? `${signals.vegMarker.value} (confidence ${formatScore(signals.vegMarker.confidence)}, evidence ${quote(signals.vegMarker.evidence)})` : signals.vegMarkerUnresolved ? 'present but unclassifiable — not a dietary answer, so nothing is reported' : 'not printed on the pack'}`,
  );
  lines.push(`  fssai         ${printField(signals.fssaiLicense)}`);
  lines.push(`  mrp           ${printField(signals.mrp)}`);
  lines.push(`  net quantity  ${printField(signals.netQuantity)}`);
  lines.push(`  best before   ${printField(signals.bestBefore)}`);
  lines.push(`  manufacturer  ${printField(signals.manufacturer)}`);
  lines.push(`  origin        ${printField(signals.countryOfOrigin)}`);
  lines.push(`  name / brand  ${printField(signals.name)} / ${printField(signals.brand)}`);
  lines.push(`  label signals ${formatList(signals.labelSignals)}`);
  if (data.warnings.length > 0) lines.push(`warnings      ${formatList(data.warnings)}`);
  lines.push(`timings       ${JSON.stringify(data.diagnostics.timings_ms)}`);
  lines.push('');
  lines.push('raw JSON paths worth reading:');
  lines.push('  /barcode/primary                     the service\'s own pick for a lookup');
  lines.push('  /barcode/results/0/confidence_breakdown  why that number');
  lines.push('  /product/*/evidence                  the OCR text each field was read from');
  lines.push('  /ocr/raw_text                        untouched OCR, before any correction');
  lines.push('');
  lines.push('This service reports what is printed on the pack. It returns no verdict about the');
  lines.push('product, and `confidence` is derived, not a calibrated probability.');
  lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);
}

function formatScore(value: number | null): string {
  return value === null ? 'none' : value.toFixed(3);
}

function printField(field: { value: unknown; confidence: number | null; evidence: string | null } | null): string {
  if (field === null) return 'not found';
  // `mrp` is the one structured field ({ amount, currency }); the rest are strings.
  const rendered =
    typeof field.value === 'object' && field.value !== null ? JSON.stringify(field.value) : String(field.value);
  return `${rendered} (confidence ${formatScore(field.confidence)}, evidence ${quote(field.evidence)})`;
}

function quote(value: string | null): string {
  return value === null || value.length === 0 ? 'none' : `"${value.replace(/\s+/g, ' ').slice(0, 60)}"`;
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

try {
  process.exitCode = await main();
} catch (error) {
  // Fail loudly and readably: name the class, the code, the status and the id
  // so a log line is enough to find the request in the service's own logs.
  if (error instanceof VisionApiError) {
    process.stderr.write(
      `\nVision API rejected the request\n` +
        `  code         ${error.code ?? '(no envelope)'}\n` +
        `  http status  ${error.httpStatus}\n` +
        `  message      ${error.message}\n` +
        `  request id   ${error.requestId ?? 'none'}\n` +
        `  attempts     ${error.attempts}\n` +
        (error.fields.length > 0 ? `  fields       ${error.fields.join('; ')}\n` : '') +
        (error.failureStage ? `  stage        ${error.failureStage}\n` : '') +
        `  details      ${safeJson(error.details)}\n` +
        `  retryable    ${error.retryable}\n`,
    );
    process.exitCode = 1;
  } else if (error instanceof VisionApiTimeoutError) {
    process.stderr.write(`\n${error.message}\n  request id ${error.requestId ?? 'none'}\n  raise FOODGUARD_VISION_TIMEOUT_MS or pass timeoutMs.\n`);
    process.exitCode = 1;
  } else if (error instanceof VisionApiTransportError) {
    process.stderr.write(`\n${error.message}\n  is the Vision API running and reachable at FOODGUARD_VISION_API_URL?\n`);
    process.exitCode = 1;
  } else if (error instanceof FoodGuardClientError) {
    process.stderr.write(`\n${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`\nunexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}

function safeJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n… (${text.length} bytes)` : text;
}