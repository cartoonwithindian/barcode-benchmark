# FoodGuard reference client

A zero-dependency TypeScript client for the **FoodGuard Vision API**. One photo of
an Indian packaged-food label goes in; barcodes, OCR text, ingredients, nutrition
and the Indian retail fields come out.

- **Runtime dependencies: none.** `fetch` (Node 18+) and hand-written interfaces
  transcribed from `src/analyze/schema.ts`. No axios, no zod, no generated code.
- **Nothing invented.** Every field, endpoint, header and status in this package
  exists in the service source; the originating file is cited above each one. If
  the service is missing something, this client says so rather than filling the
  gap — see [Contract notes](#contract-notes).

## Layout

```
clients/foodguard-client/
  src/types.ts     the mirrored contract (response DTOs, error codes, endpoints)
  src/errors.ts    VisionApiError & friends, plus the retryable/non-retryable sets
  src/http.ts      transport: auth header, deadline, one bounded retry
  src/client.ts    VisionApiClient — analyze, health, version, metrics
  src/helpers.ts   summarizeForLookup, extractSignals, describeDetection
  src/index.ts     public exports
  examples/analyze.ts   runnable end-to-end example
  tsconfig.json    self-contained typecheck project
```

## Quick start

```ts
import { VisionApiClient, describeDetection, summarizeForLookup } from './src/index.js';

const client = new VisionApiClient({
  baseUrl: 'https://foodguard-vision-api.onrender.com',
  apiKey: process.env.FOODGUARD_VISION_API_KEY,
});

const response = await client.analyze({
  image_url: 'https://cdn.example.com/packs/amul-taaza.jpg',
});

const detection = describeDetection(response);   // not_attempted | no_barcode | low_confidence | detected
const lookup = summarizeForLookup(response);     // the GTIN to search on, or null
```

Or from the environment:

```ts
const client = VisionApiClient.fromEnv();
// FOODGUARD_VISION_API_URL, FOODGUARD_VISION_API_KEY, FOODGUARD_VISION_TIMEOUT_MS
```

## Requesting an analysis

`POST /v1/analyze` (`src/routes/analyze.ts:22-36`):

| field | type | notes |
|---|---|---|
| `image_url` | string, 8..2048 | required, publicly reachable. **There is no `image_base64`** — the body schema is `.strict()`, so any other key is a `VALIDATION_ERROR`. To analyse a local file, host it and pass the URL. |
| `options.plan` | `fast` \| `standard` \| `deep` | barcode-stage aggression, default `standard` |
| `options.ocr` | boolean | default `true`; `false` skips OCR entirely |
| `options.max_variants` | integer 1..40 | preprocessing variants |
| `options.timeout_ms` | integer 1000..300000 | **server-side** budget; clamped down to the service maximum |
| `options.normalize_text` | boolean | default `true` |

The client checks those bounds locally before sending, so an impossible request
costs nothing. It never widens what the server accepts.

## API surface

```ts
class VisionApiClient {
  constructor(options: VisionApiClientOptions)
  static fromEnv(env?, overrides?): VisionApiClient
  get baseUrl(): string
  get timeoutMs(): number

  analyze(request: AnalyzeRequest, options?: AnalyzeCallOptions): Promise<AnalysisResponse>
  analyzeWithMeta(request: AnalyzeRequest, options?): Promise<CallResult<AnalysisResponse>>
  health(options?): Promise<CallResult<HealthResponse>>
  version(options?): Promise<CallResult<VersionResponse>>
  metrics(options?): Promise<CallResult<MetricsResponse>>
}
```

`VisionApiClientOptions`: `baseUrl`, `apiKey`, `authHeader`
(`'x-api-key'` default, or `'authorization'` which sends `Authorization: Bearer <key>`),
`timeoutMs`, `fetch` (injection point for tests), `logger`, `retry`, `userAgent`.

`AnalyzeCallOptions`: `timeoutMs` (client deadline), `signal` (your
`AbortSignal`, composed with the deadline), `requestId` (forwarded as
`x-request-id`), `retry` (override or `false`), `serverTimeoutMs` (opt-in, maps
to `options.timeout_ms`).

`CallResult` adds `httpStatus`, `requestId` (from the `x-request-id` response
header, falling back to the id you sent), `attempts` (how many HTTP attempts were
really made) and `schemaVersionMismatch`. The analysis body itself carries
`request_id`; the two are the same value because the service adopts the header.

## Timeouts

`DEFAULT_TIMEOUT_MS` is **60 000 ms**, derived from the service's own budget
rather than picked by feel:

| stage | service default | source |
|---|---|---|
| image download | ≤ 12 000 ms | `DOWNLOAD_TIMEOUT_MS` (`src/config/index.ts:66`) |
| pipeline (barcode ≤ 9 000 ms, OCR ≤ 45 000 ms) | ≤ 45 000 ms | the route clamps `timeout_ms` to `max(BARCODE_MAX_MS, OCR_TIMEOUT_MS)` (`src/routes/analyze.ts:63`) |
| server wall clock | 90 000 ms | `REQUEST_TIMEOUT_MS` (`src/config/index.ts:63`) |

OCR dominates the cost by an order of magnitude. A barcode-only request
(`ocr: false`) finishes in seconds, so pass `timeoutMs: 15_000` there and save
yourself a minute of headroom. 60 s clears a legitimately slow full-label OCR
while staying under the server's own wall clock, so when the client deadline
fires the service has genuinely given up rather than still working.

The client deadline is enforced with `AbortSignal`; the server-side budget is a
separate, opt-in setting (`serverTimeoutMs`).

## Errors

```
FoodGuardClientError          requestId, attempts
├── VisionApiError            code, httpStatus, message, requestId, details, fields,
│                             retryAfterSeconds, failureStage, retryable
├── VisionApiTransportError   fetch itself failed (DNS, refused, reset, TLS)
└── VisionApiTimeoutError     the client's own deadline fired (timeoutMs)
```

`VisionApiError.code` is `null` when the response carried no recognisable
envelope — an HTML 502 from a proxy, say. The raw body is always on `details`, so
nothing the service said is lost. Nothing is swallowed: a failed call always
throws.

`details` is the whole raw response body, because the service's own
`AppError.details` is operator-only and `toPublicJSON()` never emits it
(`src/core/errors.ts:81-93`). There is no public `details` field to mirror.

### Retry policy

One extra attempt, full-jitter exponential backoff, `maxAttempts: 2`.

**Retryable** (`RETRYABLE_ERROR_CODES`): `RATE_LIMITED` (429), `DOWNLOAD_TIMEOUT`
(504), `DOWNLOAD_FAILED` (502), `ANALYSIS_FAILED` (500), `INTERNAL_ERROR` (500),
`SERVICE_UNAVAILABLE` (503) — plus any transport failure, plus any non-envelope
5xx.

**Not retryable** (`NON_RETRYABLE_ERROR_CODES`): `VALIDATION_ERROR`, `INVALID_URL`,
`BLOCKED_URL`, `UNSUPPORTED_SCHEME`, `INVALID_IMAGE` (400), `UNAUTHORIZED` (401),
`NOT_FOUND` (404), `DOWNLOAD_TOO_LARGE`, `IMAGE_TOO_LARGE` (413),
`UNSUPPORTED_MEDIA_TYPE` (415). Retrying these cannot succeed; it only burns a
round trip and, for 429, makes things worse.

A **client-side timeout is not retried**: the service is probably still working on
the image, and a second copy costs a second pipeline run. Raise `timeoutMs`
instead. A server-sent `Retry-After` / `retry_after_seconds` is honoured, clamped
to `maxDelayMs` (4 s) so the client never stalls; `respectRetryAfter: false`
ignores it. The backoff sleep aborts with your `signal`.

`EVERY_ERROR_CODE_IS_CLASSIFIED` is a compile-time constant: if a future build adds
an `ErrorCode` that is on neither list, the build fails until someone decides.

## Helpers

### `summarizeForLookup(response): LookupIdentifier | null`

The single best product identifier, or `null` when nothing was decoded. It mirrors
`selectPrimaryBarcode` (`src/barcode/fusion.ts:224-233`) rather than re-deciding
the rule: retail GTIN that is not a URL payload → Code 128 → any other 1D format →
the first rank-ordered candidate.

Returns the value, format, `confidence`, `confidenceSource`, which branch picked
it (`selection`), `lookupKeyKind` (`gtin` | `url` | `other`), engine evidence
(`engines`, `agreement`, `observations`), the four-term `confidenceBreakdown`,
and `matchesServicePrimary` — whether the service's own `barcode.primary` agrees.
It reads `barcode.results`, not `barcode.primary`, so the rule stays auditable.

### `extractSignals(response): RetailSignals`

Indian-retail signals, unwrapped, each with its confidence and the OCR evidence it
came from: `insCodes`, `ingredientCodes`, `allergens` (with `declaredInSection`),
`vegMarker`, `fssaiLicense`, `mrp`, `netQuantity`, `bestBefore`, `manufacturer`,
`countryOfOrigin`, `name`, `brand`, `variantOrFlavour`, `labelSignals`.

`insCodes` are canonicalised: `findInsCodes` turns `E621`, `E 621` and `INS 621`
into the same `INS 621` string (`src/text/normalize.ts:395-405`), so an E-number
and an INS number are **one** value here — do not present them as two
independent confirmations.

### `describeDetection(response): DetectionDescription`

| state | meaning |
|---|---|
| `not_attempted` | no engine ran (`stop_reason` says why) |
| `no_barcode` | engines ran and decoded nothing — a real answer, not an error |
| `low_confidence` | something decoded but the score is missing, unscored, or below `DEFAULT_MIN_BARCODE_CONFIDENCE` (0.5, the service's own `BARCODE_MIN_CONFIDENCE` default) |
| `detected` | a scored, above-bar detection. The only state a UI may call a success |

`confidence_source: 'unknown'` can **never** accompany `detected`. The service
produces it when a candidate has no supporting evidence at all
(`src/barcode/fusion.ts:15-17`), which is a gap in what we know — not a low score.
A GTIN lookup built on it would be a guess.

`isUsableForLookup` is only true for `detected` **and** `lookupKeyKind === 'gtin'`.
A QR URL is a real detection with a real score, but it is not a product code, and
saying "detected!" over a URL is how a UI ends up promising a lookup that cannot
work.

## Honesty notes — read this before shipping a UI on top

- **The service returns no verdict about a product.** No "safe", no "unsafe", no
  ingredient risk score, no pass/fail. It reports what is *printed on the pack*.
  FoodGuard's own judgement lives in FoodGuard; this client does not make it.
- **`confidence` is `derived`, not a calibrated probability.** No barcode engine
  in this build exposes a per-result score (`/version`'s `attestation` says so
  outright). The number is a weighted sum of four observable facts —
  engine agreement, repeatability across `(engine, variant)` attempts,
  structural validity such as a GTIN check digit, and a format prior
  (`src/barcode/fusion.ts:112-129`). Read `confidence_source` and
  `confidence_breakdown` before showing a number, and never render it as "X% sure
  this is safe". It is "how well does this reading survive these four checks".
- **Product `confidence` is the same kind of number.** `name` and `brand` are
  heuristic on a photo and are reported with deliberately low confidence plus
  `evidence`; fields read from an explicit printed label (`Net Qty: 500 ml`) score
  higher. `confidence: null` with `confidence_source: 'unknown'` means "nothing
  plausible was found" — that is not a score of zero.
- **The helpers return empty and null, never guesses.** `[]` means the label did
  not show it. `null` means we cannot say. `extractSignals` never falls back to
  the evidence text, never normalises a missing number to `0`, and drops a veg
  marker of `'unknown'` rather than reporting it as a dietary answer.
- **A 200 does not mean a detection.** `barcode.detected: false` with
  `ocr.detected: false` is a successful call that read nothing. Check
  `describeDetection(...).state`, not just the absence of an exception.
- **Evidence over values.** Every extracted field carries the exact OCR substring
  it was read from. Show it on a detail screen; it is what makes a wrong reading
  correctable instead of merely wrong.

## Contract notes

Things FoodGuard asked for that the service does not have, or where the DTO and the
route disagree. None of them are worked around in this client:

1. **No `image_base64`.** The task brief suggested one; `src/routes/analyze.ts:22-36`
   accepts `image_url` and `options` only and is `.strict()`. Sending
   `image_base64` returns `VALIDATION_ERROR` with
   `fields: ["body: Unrecognized key(s) in object: 'image_base64'"]` — verified
   against a running service. Host the image and pass a URL.
2. **The error envelope has no `details`.** `AppError.details` is operator-only and
   `toPublicJSON()` never emits it (`src/core/errors.ts:81-93`), so `VisionApiError.details`
   is the full raw body instead.
3. **The rate-limit envelope omits `request_id` and `meta`.**
   `src/server.ts:88-97` builds `{ success, error }` only, while the general
   handler (`src/server.ts:165-171`) includes both. The client reads
   `request_id` from the `x-request-id` header as a fallback.
4. **`product.veg_marker` loses its union.** The DTO types it as
   `ExtractedField<string>` (`src/analyze/schema.ts:181`) though the service's own
   type is `VegMarker['type']` (`src/text/sections.ts:323`). `isVegMarkerType()`
   narrows it back at runtime.
5. **`analysis_id` is declared but never set.** It exists on the DTO
   (`src/analyze/schema.ts:170`) and nothing populates it. Treat it as always absent.
6. **The route docstring advertises options the schema does not fully honour.**
   `src/routes/analyze.ts:4-7` documents the body accurately, but `timeout_ms` is
   silently clamped to the service maximum (`src/routes/analyze.ts:63-65`), so a
   large value buys no extra time.

## Running the example

```bash
# terminal 1 — the service, on an ephemeral port
PORT=8099 API_KEYS=test-key-alpha \
ALLOW_HTTP=true PRIVATE_HOST_ALLOWLIST=127.0.0.1,localhost ALLOWED_URL_PORTS=<image-port> \
OCR_LANG_PATH=assets/tessdata-fast OCR_WORKER_LIMIT=1 \
npx tsx src/index.ts

# terminal 2 — the client
FOODGUARD_VISION_API_URL=http://127.0.0.1:8099 \
FOODGUARD_VISION_API_KEY=test-key-alpha \
npx tsx clients/foodguard-client/examples/analyze.ts https://example.com/pack.jpg
```

Flags: `--url <url>`, `--json` (dump the raw body), `--plan fast|standard|deep`,
`--no-ocr`, `--file <path>` (see below), `--help`. `FOODGUARD_IMAGE_URL` works in
place of the positional URL.

There is no key in this file. The key comes from `FOODGUARD_VISION_API_KEY`; if it
is unset the example warns and proceeds without one, which only works against a
service started with an empty `API_KEYS`. Failures print the code, HTTP status,
request id, attempt count, failure stage, raw details and whether the client
considered it retryable, then exit `1`.

`--file <path>` base64-encodes a local image and sends it once on purpose, to show
that the strict body schema refuses it and that the client maps the rejection
correctly. It is a contract probe, not a way to analyse a local file.

## Typecheck

The service's root `tsconfig.json` covers `src/`, `tests/` and `scripts/` only, so
this package carries its own project:

```bash
npx tsc -p clients/foodguard-client/tsconfig.json --noEmit
```

`noUncheckedIndexedAccess` is on deliberately: an out-of-range index must produce
`undefined` rather than a confident wrong barcode.