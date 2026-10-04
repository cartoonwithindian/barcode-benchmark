# FoodGuard Vision API

A Fastify HTTP service that turns a photo of a packaged-food label into structured,
auditable data: barcodes (with an explainable confidence score), OCR text with
recorded corrections, ingredient items, nutrition values, allergens, and the
Indian regulatory fields (FSSAI licence, MRP, net quantity, veg marker).

The input is a URL, not a file. The service downloads the image itself, keeps it in
memory for the duration of the request, and never writes it to disk.

- [API reference](docs/API.md) — request/response contract, confidence model, error codes.
- [Operations guide](docs/OPERATIONS.md) — configuration reference, deployment, tuning, troubleshooting.

---

## The honesty contract

This service is deliberately unable to invent a result. Four rules govern the whole
codebase and every response field:

1. **A miss is a miss.** When a stage finds nothing it reports `detected: false`
   and `null` values. Nothing is back-filled with a plausible-looking default.
   (`src/analyze/orchestrator.ts:10-16`, `src/analyze/schema.ts:3-13`)
2. **Confidence is always attributed.** Every numeric score ships with a
   `confidence_source`. `engine` means an engine reported it; `derived` means this
   service computed it from observable evidence and the terms are listed in
   `confidence_breakdown`; `unknown` means the score is `null`. There is no third
   possibility and no silently-derived number. (`src/barcode/fusion.ts:9-17`)
3. **Unreadable input is surfaced, not swallowed.** A nutrition line the parser
   could not read appears verbatim in `nutrition.undeciphered_lines` instead of
   being dropped or guessed at. (`src/text/nutrition.ts:1-12`)
4. **Raw output is preserved.** `ocr.raw_text` is exactly what Tesseract returned;
   `ocr.normalized_text` is the corrected version and every change is listed in
   `ocr.corrections` with its character range and its own confidence.
   `ocr.normalization_confidence` is `1` when nothing changed.
   (`src/text/normalize.ts:3-16`)

There is no verdict field, no risk score, no health claim, and no product lookup.
The service reports what it read off the picture. What that means legally or
nutritionally is the caller's decision.

`GET /version` publishes this as a machine-readable attestation:

```json
{
  "attestation": {
    "fabricates_results": false,
    "statement": "Detection failures are reported as detected:false / null. Barcode confidences are derived (no engine in this build exposes a per-result score)."
  }
}
```

## What the pipeline actually does

`src/analyze/orchestrator.ts:1-16` is the authoritative description; the stages are:

| # | Stage | Where | Notes |
|---|-------|-------|-------|
| 1 | Download | `src/ingest/downloader.ts` | SSRF-hardened, manual redirects, byte cap, magic-byte sniff |
| 2 | Cache lookup | `src/analyze/cache.ts` | SHA-256 of image bytes + option fingerprint; download happens first |
| 3 | Decode | `src/ingest/decode.ts` | Dimension/pixel caps checked before full decode, EXIF applied once, downscaled to `WORKING_MAX_DIMENSION` (2200 px) |
| 4 | Barcode | `src/barcode/pipeline.ts` | Preprocessing variants × up to 3 engines, early exit on a confidence or agreement target |
| 5 | OCR | `src/ocr/pipeline.ts` | Raster capped to `OCR_MAX_DIMENSION` (1400 px), then Tesseract over a small variant plan, best-of scoring, early exit on the ingredients heading |
| 6 | Text | `src/text/*` | Normalise → locate sections → parse ingredients / nutrition / product fields |
| 7 | Respond | `src/analyze/schema.ts` | Stable, versioned JSON (`SCHEMA_VERSION = "1"`) |

Every stage is time-bounded. A stage that overruns is recorded as a warning and the
rest of the response is still produced.

### Barcode engines

Four adapters are registered in a fixed order (`src/barcode/registry.ts:34-44`).
At most three run per request (`src/barcode/pipeline.ts:95`), taken from whichever
report themselves available:

| Engine | Module | Role |
|--------|--------|------|
| `ZXing-C++` | `zxing-wasm` | Primary. Leads the plan because it had the highest hit rate in the benchmark data the repo carries (`src/barcode/registry.ts:1-14`). |
| `ZBar` | `zbar.wasm` | Independent 1D cross-check. |
| `ZXing-TS` | `@zxing/library` | Pure-TypeScript third opinion. |
| `Quagga2` | `@ericblade/quagga2` | Registered, but reports `platform_unsupported` on Node unless `VISION_ENABLE_QUAGGA2=true` is set together with a canvas shim (`src/barcode/adapters/quagga2.adapter.ts:16-17,37,49`). |

An engine that fails to initialise never removes the others from the plan; it shows
up in `barcode.engines_unavailable` and `GET /version`.

### OCR

Tesseract via `tesseract.js`, running as WASM inside the Node process. The traineddata
is vendored at `assets/tessdata`, so no request-time network call and no CDN
dependency at runtime (`src/ocr/engine.ts:1-16`).

Variant order is `gray_upscale2x`, `gray`, `clahe`, `adaptive`, `original`
(`src/imaging/variants.ts:65-72`), PSM 3 and 6 when more than one variant is
planned. The winning pass is chosen by a quality score — heading recall dominates,
then character count, then Tesseract's own confidence — not by whichever ran first
(`src/ocr/pipeline.ts:180-187`).

Tesseract is never handed the full barcode raster. Before the plan runs, the raster is
copied and capped so its longest edge is at most `OCR_MAX_DIMENSION`, default 1400 px
(`src/analyze/orchestrator.ts:249`, `src/imaging/resize.ts:40`). That matters because
Tesseract's memory tracks pixel count while its accuracy plateaus early: on the
synthetic label, 1400 px scored the best mean confidence of a 800–4400 px sweep while
4400 px — what `gray_upscale2x` used to produce from a 2200 px raster — cost 465 MB
against 207 MB and scored *worse* (`src/imaging/resize.ts:12-22`). Upscaling is
therefore still wasteful, just bounded.

## Requirements

- Node.js `>= 22.0.0` (`package.json:8-10`)
- `assets/tessdata/eng.traineddata.gz` present in the working directory, or
  `OCR_LANG_PATH` pointed somewhere equivalent
- Native deps: `sharp` (libvips) and the WASM engines load at runtime. The
  `allowScripts` block in `package.json:43-48` is what permits those install scripts.

## Quick start

```bash
npm install
npm run dev          # tsx watch src/index.ts
curl -s localhost:8000/health
```

`PORT` defaults to **8000** and `HOST` to `0.0.0.0`
(`src/config/index.ts:39-40`). Set `PORT` explicitly if your platform assigns one.

Production build and run:

```bash
npm run build        # tsc -p tsconfig.build.json  ->  dist/
npm start            # node dist/index.js
```

Container build and run:

```bash
docker build -t foodguard-vision-api .
docker run --rm -p 8000:8000 -e API_KEYS=devkey foodguard-vision-api
```

The image bakes in `assets/tessdata`, so no language data is fetched at runtime. It
runs as uid 10001 and declares a `HEALTHCHECK` against `/health`. `render.yaml` is a
Render Blueprint that uses this same `Dockerfile`. Full detail, including the two
settings worth changing before a first deploy, is in the operations guide.

Other scripts:

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run dev` | `tsx watch src/index.ts` | Watch mode |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` | Types only, includes tests and scripts |
| `npm test` | `vitest run` | Unit tests against `tests/fixtures/` |
| `npm run test:watch` | `vitest` | Watch mode |
| `npm run fixtures` | `tsx scripts/generate-fixtures.ts` | Regenerate fixtures + `manifest.json` |

`npm run fixtures` synthesises the barcodes and the synthetic label from scratch and
copies the upstream photos from the parent directory. Ground truth for every fixture
lives in `tests/fixtures/manifest.json`.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/v1/analyze` | required when `API_KEYS` is set | The analysis endpoint |
| `GET` | `/v1/analyze/schema` | **required** | Machine-readable request schema |
| `GET` | `/v1/status` | **required** | Static service status document |
| `GET` | `/` | no | Route index |
| `GET` | `/health` | no | Liveness/readiness. `503` when no barcode engine is available |
| `GET` | `/version` | no | Version, engine registry, effective config, attestation |
| `GET` | `/metrics` | no | In-process counters, histograms and derived rates |

Auth is enforced by the `preHandler` hook in `src/server.ts:125-130`, which exempts
only `/`, `/health`, `/version` and `/metrics`. Note that `/v1/status` and
`/v1/analyze/schema` are **not** on that list and therefore need a key. See the
"Known divergences" section of the operations guide.

`GET /` answers the service root:

```json
{
  "service": "foodguard-vision-api",
  "version": "1.0.0",
  "schema_version": "1",
  "endpoints": {
    "analyze": "/v1/analyze",
    "schema": "/v1/analyze/schema",
    "status": "/v1/status",
    "health": "/health",
    "version": "/version",
    "metrics": "/metrics"
  }
}
```

(`src/server.ts:184-198`.)

## Calling it

```bash
curl -s -X POST http://localhost:8000/v1/analyze \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_KEY' \
  -d '{"image_url":"https://example.invalid/pack.jpg","options":{"plan":"standard"}}'
```

The example hostname above is deliberately non-resolvable. Point `image_url` at a
publicly reachable HTTPS image of your own; the service refuses loopback, link-local,
private and metadata addresses, so an address on your own machine or network will be
rejected by design.

`image_url` is the only accepted input. There is no base64 or multipart field —
see "Known divergences" below.

### TypeScript client

`clients/foodguard-client/` is a zero-dependency reference client for
`POST /v1/analyze` — `fetch` plus hand-written types mirroring the response schema.

```bash
npm install                            # at the repo root, provides tsx for the example
npm --prefix clients/foodguard-client run example
# reads FOODGUARD_VISION_API_URL, FOODGUARD_VISION_API_KEY, FOODGUARD_IMAGE_URL
```

It sends `X-API-Key` by default, defaults to a 60 s deadline (a full OCR pass), retries
retryable failures, and checks `schema_version` on every response. Note that its
default base URL is `http://127.0.0.1:8080` while the service listens on **8000**, so
set `FOODGUARD_VISION_API_URL` explicitly.

## Configuration

Everything is read from the environment and validated once at boot
(`src/config/index.ts`); an invalid value aborts startup with a readable list of the
offending keys rather than running with a silently wrong default.

The variables you are most likely to touch:

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `8000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `NODE_ENV` | `development` | `production` disables pretty logs |
| `API_KEYS` | empty | Comma-separated keys. **Empty disables authentication entirely.** |
| `TRUST_PROXY` | `false` | Must be `true` behind a proxy or rate limits key on the proxy IP |
| `ALLOW_HTTP` | `false` | Allows `http://` image URLs |
| `PRIVATE_HOST_ALLOWLIST` | empty | Hosts allowed to resolve to private IPs |
| `RATE_LIMIT_MAX` | `60` | Requests per window, per API key |
| `RATE_LIMIT_WINDOW` | `1 minute` | Window length |
| `CORS_ORIGINS` | empty | Empty disables CORS entirely |
| `BARCODE_MIN_CONFIDENCE` | `0.5` | Confidence floor used by fusion |
| `OCR_ENABLED` | `true` | Master OCR switch |
| `OCR_MAX_VARIANTS` | `3` | OCR variant attempts |
| `OCR_WORKER_LIMIT` | `1` | Tesseract worker pool size |
| `OCR_TIMEOUT_MS` | `45000` | Per-request OCR budget |
| `CACHE_ENABLED` | `true` | In-memory response cache |
| `CACHE_TTL_SECONDS` | `900` | Cache entry lifetime |
| `EXPOSE_METRICS` | `true` | `false` makes `/metrics` return 404 |

The complete table, with every range and validation rule, is in the
[operations guide](docs/OPERATIONS.md#configuration-reference).

## Security posture

- **SSRF defence in depth.** URL syntax vetting, a suspicious-hostname blocklist,
  decimal/octal/hex IP-literal rejection, per-address IP range checks after DNS
  resolution, manual redirect following with every hop re-validated, and a second
  range check inside the socket `lookup` hook to close the DNS-rebinding window.
  Full list in the [operations guide](docs/OPERATIONS.md#ssrf-policy).
- **No writes to disk.** The image buffer lives only for the request. The response
  cache is keyed on the SHA-256 of the image bytes and is in-process only.
- **No credential leakage.** API keys are compared in constant time after hashing;
  rate-limit keys are a 32-bit FNV hash, never the raw key; `authorization`,
  `x-api-key` and `cookie` headers are redacted by the logger; image URLs are logged
  and reported as `protocol//host/path` with no query string.
- **Bounded work.** 8 MiB download cap, 6000 px dimension cap, 40 MP pixel cap,
  per-stage wall-clock budgets, a bounded OCR worker pool, and a 16 KiB request body
  limit (the request is only ever a URL).

## Performance

Decoding cost dominates and scales with pixel count, so images are downscaled to a
2200 px working resolution before the engines see them (`src/ingest/decode.ts:19-20,89-90`).

Measured ZXing-C++ (`zxing-wasm` `readBarcodes`) timings against
`tests/fixtures/real-qr-and-gtin-15.jpg` (originally 5401×5401), downscaled to each
size, on a single warm process, one run per configuration:

| Working size | All 13 formats, `tryHarder`+rotate+invert+downscale | 1D formats only | Symbols found |
|-------------|-------------------------------------------------------|-----------------|---------------|
| 2200×2200 | 875 ms | 76 ms | 2 |
| 1600×1600 | 193 ms | 40 ms | 2 |
| 1200×1200 | 127 ms | 27 ms | 1 |
| 900×900 | 63 ms | 25 ms | 0 |

Conditions and caveats: these are single samples, not averages; the numbers are
machine-dependent and were taken on the development container, not on a Render
instance; and the *hit rate* degrades as the image shrinks — at 900 px the engine
found nothing in this run even though the same image at 1600 px yielded both the QR
payload and the EAN-13. Narrowing to 1D formats was about 11× faster at 2200 px and
about 2.5× faster at 900 px. Treat this table as evidence that resolution and format
breadth both cost real time, not as a service-level guarantee.

The `standard` plan's barcode budget is 9000 ms
(`min(BARCODE_MAX_MS, PLAN_MAX_MS.standard * 2)`, `src/analyze/orchestrator.ts:189-193`),
so a single ZXing-C++ sweep at the working resolution can consume a large fraction of
it. The pipeline's early exit — stop at confidence ≥ 0.85, or at two agreeing engines
on a retail GTIN — is what keeps the common case fast.

## Project layout

```
vision-api/
├── package.json               # scripts, dependencies, node >= 22 engine constraint
├── tsconfig.json              # typecheck config (src + tests + scripts)
├── tsconfig.build.json        # build config (src only, emits dist/)
├── vitest.config.ts           # serial test execution, 180 s timeouts, v8 coverage
├── Dockerfile                 # multi-stage deps -> build -> runtime image, non-root
├── .dockerignore              # keeps assets/ + src/; excludes tests, docs, clients, .env*
├── render.yaml                # Render Blueprint: docker runtime, 36 of the 39 env vars
├── .env.example               # every schema variable at its real default (local only)
├── assets/
│   ├── tessdata/              # eng.traineddata.gz — default OCR_LANG_PATH
│   └── tessdata-fast/         # fast integer model, used by the test environment
├── clients/
│   └── foodguard-client/      # zero-dependency TS client for POST /v1/analyze
├── docs/
│   ├── API.md                 # HTTP contract
│   └── OPERATIONS.md          # configuration, deployment, troubleshooting
├── scripts/
│   └── generate-fixtures.ts   # regenerates tests/fixtures + manifest.json
├── src/
│   ├── index.ts               # entrypoint: listen, warm engines, SIGTERM/SIGINT shutdown
│   ├── server.ts              # Fastify factory, middleware order, all routes, error handler
│   ├── analyze/
│   │   ├── cache.ts           # SHA-256 keyed LRU with TTL
│   │   ├── orchestrator.ts    # the request pipeline
│   │   └── schema.ts          # response DTOs, SCHEMA_VERSION, API_VERSION
│   ├── barcode/
│   │   ├── adapter.ts         # BarcodeScannerAdapter interface
│   │   ├── adapters/          # zxingCpp, zbarWasm, zxingTs, quagga2
│   │   ├── formats.ts         # canonical format names, GTIN check digit, URL detection
│   │   ├── fusion.ts          # grouping, derived confidence, ranking, primary selection
│   │   ├── pipeline.ts        # variant × engine sweep with early exit
│   │   ├── registry.ts        # engine order, availability, warm-up
│   │   └── types.ts           # BarcodeResult, format union, engine status union
│   ├── config/
│   │   └── index.ts           # zod env schema, defaults, ranges, loadConfig()
│   ├── core/
│   │   ├── async.ts           # withTimeout, settledMap/parallelMap, sinceMs, Mutex
│   │   ├── errors.ts          # ErrorCode taxonomy -> HTTP status
│   │   ├── logger.ts          # pino, redaction, safeUrlTag
│   │   ├── metrics.ts         # counters, reservoir-sampled histograms, derived rates
│   │   └── requestContext.ts  # AsyncLocalStorage request id + pipeline stage
│   ├── imaging/
│   │   ├── preprocessing.ts   # ~40 preprocessing variants
│   │   ├── raster.ts          # RGBA Raster, quality assessment
│   │   ├── resize.ts          # caps the raster before OCR (OCR_MAX_DIMENSION)
│   │   └── variants.ts        # fast/standard/deep plans, OCR variant plan
│   ├── ingest/
│   │   ├── decode.ts          # sharp decode, bomb protection, EXIF, downscale
│   │   ├── downloader.ts      # undici fetch, redirects, byte cap, format sniff
│   │   ├── ipPolicy.ts        # IPv4/IPv6 range classification
│   │   └── urlPolicy.ts       # syntax vetting, DNS resolution, pinned lookup
│   ├── ocr/
│   │   ├── engine.ts          # Tesseract worker pool, timeouts, worker recycling
│   │   └── pipeline.ts        # variant × PSM sweep, best-of scoring
│   ├── routes/
│   │   ├── analyze.ts         # POST /v1/analyze, GET /v1/analyze/schema
│   │   └── operational.ts     # /health, /version, /metrics
│   ├── security/
│   │   └── auth.ts            # X-API-Key / Bearer, constant-time comparison
│   ├── text/
│   │   ├── ingredients.ts     # item parsing, sub-ingredients, allergens, confidence
│   │   ├── normalize.ts       # OCR text correction with per-change confidence
│   │   ├── nutrition.ts       # nutrient parsing, undeciphered_lines, confidence
│   │   ├── product.ts         # labelled field extraction with evidence strings
│   │   └── sections.ts        # section heading detection
│   └── types/
│       ├── fastify.d.ts       # VisionServer module augmentation
│       └── globals.d.ts       # ambient declarations
└── tests/
    ├── api.test.ts            # HTTP layer: health, version, metrics, analyze, auth, 429
    ├── barcode.test.ts
    ├── ingest.test.ts
    ├── ocr.test.ts
    ├── text.test.ts
    ├── helpers.ts             # fixture loading, env isolation, local image server
    └── fixtures/
        ├── manifest.json      # ground truth per fixture
        └── *.png *.jpg *.jpeg *.txt
```

`.scratch/`, `ocrprobe.mjs` and `zxingprobe.mjs` are untracked debugging scratch
files. They are excluded from the build (`tsconfig.build.json:9`) and are not part
of the service.

## Testing

```bash
npm test
```

The suite runs serially (`vitest.config.ts:7-8`) because the WASM engines and Tesseract
are CPU-heavy, with 180 s timeouts. It covers the barcode pipeline against the
generated and upstream fixtures, the ingest layer including the SSRF policy, the OCR
pipeline, and the text extraction modules.

`tests/api.test.ts` covers the HTTP layer: `/health`, `/version`, `/metrics`,
`POST /v1/analyze` against fixture images served by a local image server, auth, rate
limiting, `x-request-id` echo, validation and error-envelope shape. The full suite
(6 files / 130 tests) passes as of the current commit.

## Known divergences from the design brief

Recorded here so an integrator is not surprised. Each is traceable to source.

| Item | Reality |
|------|---------|
| Base64 image input | Not accepted. `POST /v1/analyze` takes `image_url` only, and the body schema is `.strict()` (`src/routes/analyze.ts:22-36`). A `image_base64` field is rejected with `VALIDATION_ERROR`. |
| Default port | 8000 (`src/config/index.ts:40`). The entrypoint's own doc comment says 8080 (`src/index.ts:4`); the doc comment is wrong, the default is 8000. |
| `GET /v1/status`, `GET /v1/analyze/schema` | Both exist and both require an API key, because the auth hook exempts only `/`, `/health`, `/version`, `/metrics` (`src/server.ts:127`). |
| Request timeout | `REQUEST_TIMEOUT_MS` is parsed, validated and logged but never enforced — no code path produces a 504 for it (`src/config/index.ts:62-63`, `src/index.ts:40`). Per-stage budgets do the real work. |
| Engine confidence | `confidence_source: "engine"` is a valid schema value (`src/analyze/schema.ts:43`) but no wired engine exposes a per-result score, so it is never observed in practice (`src/barcode/fusion.ts:9-12`). |
| `options.timeout_ms` is clamped, and `GET /v1/analyze/schema` does not say so | The route lowers it to `max(BARCODE_MAX_MS, OCR_TIMEOUT_MS)` — 45000 ms with defaults (`src/routes/analyze.ts:66-70`, `src/server.ts:214`). The clamp is reported in an `x-timeout-clamped-ms` response header, not in `warnings`, while the schema endpoint still advertises `max: 300000` (`src/routes/analyze.ts:104`). |
| ~30 s connection cut in front of the service | Observed on the live free-tier deployment: a 37 s analysis completed server-side (HTTP 200 in the service log, result cached) while the client's connection was severed at ~30 s with a 502. Callers must tolerate this: use the `clients/foodguard-client` retry policy, which treats a severed connection on `/v1/analyze` as retryable, or keep the deadline under 30 s. |

## Live deployment (Render free tier)

Deployed 2026-10-04: `https://foodguard-vision-api.onrender.com` (service id
`srv-db13pjm0tbcc739cdsng`, Docker runtime, `vision-api/` as root directory).

Free-tier env (the sizing was measured, not guessed — see `docs/OPERATIONS.md`):
`WORKING_MAX_DIMENSION=1600`, `MAX_CONCURRENT_ANALYSES=1`,
`NODE_OPTIONS=--max-old-space-size=384`, `OCR_LANG_PATH=assets/tessdata-fast`,
`OCR_MAX_VARIANTS=3`, `OCR_TIMEOUT_MS=25000`, `REQUEST_TIMEOUT_MS=55000`,
`CACHE_ENABLED=true` — peak RSS measured at ~452 MB against the 512 MB cap,
with 130/130 tests passing.

Measured on the live instance (standard plan, cached results return in <1 s):

| Fixture | Barcode | OCR | Ingredients | Total |
|---------|---------|-----|-------------|-------|
| `real-amul-pouch.jpeg` | `8901262260121` EAN-13 conf 0.611 | 562 chars, conf 69 | not on this photo | 37 s cold / 0.8 s cached |
| `label-indian.png` | detected (QR) | 868 chars, conf 93 | **0.883** — Milk, Sugar, INS 621 (Monosodium Glutamate), Refined Palm Oil, Milk Solids, INS 322, INS 330, INS 471, Citric Acid | 13.6 s |

Free-tier caveats: the instance spins down after ~15 min idle (~1 min spin-up on
the next request, billed to your 750 h/month), and expect roughly 25-40 s per
cold analysis on the 0.1-CPU allocation. Connection idle time beyond ~30 s may
be cut by a proxy in front of the service even though the analysis still
completes and lands in the cache — see the divergences table.

## Licence

MIT (`package.json:6`).