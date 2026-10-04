# FoodGuard Vision API — Operations guide

For people running the service. For the HTTP contract see the
[API reference](API.md).

- [Runtime and requirements](#runtime-and-requirements)
- [Configuration reference](#configuration-reference)
- [Environment variables read outside the schema](#environment-variables-read-outside-the-schema)
- [Deploying](#deploying)
  - [Docker image](#docker-image)
  - [Render](#render)
  - [Any Node host](#any-node-host)
  - [Reference client](#reference-client)
- [Startup sequence](#startup-sequence)
- [Health checks](#health-checks)
- [Shutdown and restarts](#shutdown-and-restarts)
- [Logging](#logging)
- [Metrics](#metrics)
- [Resource limits](#resource-limits)
- [SSRF policy](#ssrf-policy)
- [Tuning](#tuning)
  - [Latency](#latency)
  - [Barcode detection](#barcode-detection)
  - [OCR](#ocr)
  - [Cache](#cache)
  - [Rate limiting and CORS](#rate-limiting-and-cors)
- [Troubleshooting](#troubleshooting)
- [Known divergences and dead configuration](#known-divergences-and-dead-configuration)

---

## Runtime and requirements

| Requirement | Value | Source |
|-------------|-------|--------|
| Node.js | `>= 22.0.0` | `package.json:8-10` |
| OCR language data | `assets/tessdata/eng.traineddata.gz` | `src/config/index.ts:83` |
| Native modules | `sharp` (libvips), `tesseract.js` WASM | `package.json:29-30` |
| Working directory | must contain `assets/` unless `OCR_LANG_PATH` is absolute | `src/ocr/engine.ts:124-133` |
| Disk writes | none at request time | `src/analyze/cache.ts:1-11` |

`package.json:43-48` carries an `allowScripts` block that permits the install scripts
for `sharp`, `esbuild` and `tesseract.js`. Without it those packages install without
their native/WASM payload and the service starts but every engine fails to
initialise.

## Configuration reference

Every variable is validated once at boot by a zod schema
(`src/config/index.ts:35-97`). An out-of-range or unparseable value aborts startup
with a readable list of the offending keys — it never falls back to a default
silently. Booleans accept `true|false|1|0|yes|no|on|off`. List variables are
comma-separated and whitespace-trimmed; an empty value yields an empty list.

### General

| Variable | Type | Default | Accepted | Notes |
|----------|------|---------|----------|-------|
| `NODE_ENV` | enum | `development` | `development`, `test`, `production` | `production` disables pretty-printed logs. |
| `HOST` | string | `0.0.0.0` | any | Listen address. |
| `PORT` | int | `8000` | 1–65535 | Listen port. |
| `TRUST_PROXY` | bool | `false` | see above | **Must be `true` behind a proxy.** |
| `LOG_LEVEL` | enum | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | |
| `LOG_PRETTY` | bool | `false` | see above | Forced off when `NODE_ENV=production` (`src/core/logger.ts:23`). |

### Security

| Variable | Type | Default | Notes |
|----------|------|---------|-------|
| `API_KEYS` | list | empty | Accepted keys. **Empty disables authentication for every route.** |
| `ALLOW_HTTP` | bool | `false` | Permit `http://` image URLs. |
| `HTTP_ALLOWED_HOSTS` | list | empty | Hosts that may be fetched over `http` even when `ALLOW_HTTP=false`. |
| `PRIVATE_HOST_ALLOWLIST` | list | empty | Hosts exempt from the private-IP checks. See [SSRF policy](#ssrf-policy). |
| `ALLOWED_IMAGE_HOSTS` | list | empty | When non-empty, only these hosts and their subdomains may be fetched. |
| `ALLOWED_URL_PORTS` | list | empty | Extra permitted ports. Non-integer or out-of-range entries are dropped silently. |
| `CORS_ORIGINS` | list | empty | Empty disables CORS entirely (no CORS headers at all). |
| `RATE_LIMIT_MAX` | int | `60` | Range 1–100000. Requests per window per key. |
| `RATE_LIMIT_WINDOW` | string | `1 minute` | Any `@fastify/rate-limit` time-window string. |
| `BODY_LIMIT_BYTES` | int | `16384` | Range 256–1048576. The body only carries a URL. |
| `REQUEST_TIMEOUT_MS` | int | `90000` | Range 1000–600000. **Parsed and logged, never enforced** — see [known divergences](#known-divergences-and-dead-configuration). |

### Ingestion

| Variable | Type | Default | Range | Notes |
|----------|------|---------|-------|-------|
| `DOWNLOAD_TIMEOUT_MS` | int | `12000` | 500–120000 | Total budget for one URL, redirects included. |
| `DOWNLOAD_MAX_BYTES` | int | `8388608` (8 MiB) | 10000–67108864 | Checked against `Content-Length` and again while streaming. |
| `MAX_REDIRECTS` | int | `3` | 0–10 | Each hop is fully re-validated. |
| `MAX_IMAGE_DIMENSION` | int | `6000` | 64–20000 | Longest side, checked before full decode. Exceeding it is a rejection, not a downscale. |
| `MAX_IMAGE_PIXELS` | int | `40000000` (40 MP) | 10000–500000000 | Also passed to sharp as `limitInputPixels`. |
| `WORKING_MAX_DIMENSION` | int | `2200` | 320–6000 | Longest side of the raster the barcode engines and preprocessing variants actually see. Applied with `fit: 'inside', withoutEnlargement`, after EXIF rotation. The effective cap is `min(MAX_IMAGE_DIMENSION, WORKING_MAX_DIMENSION)` (`src/ingest/decode.ts:99`). **The dominant multiplier on memory and barcode latency** — see [Tuning](#tuning). |

### Barcode and OCR pipeline

| Variable | Type | Default | Range | Notes |
|----------|------|---------|-------|-------|
| `BARCODE_MAX_VARIANTS` | int | `6` | 1–40 | Hard ceiling; a request's `max_variants` is clamped down to this. |
| `BARCODE_MAX_MS` | int | `9000` | 200–120000 | Barcode stage budget. |
| `BARCODE_MIN_CONFIDENCE` | number | `0.5` | 0–1 | Not an integer. Consulted by fusion only when the leading candidate has no confidence — see the API reference. |
| `OCR_ENABLED` | bool | `true` | see above | Master switch. Requests that asked for OCR get the warning `ocr_disabled_by_configuration`. |
| `OCR_MAX_VARIANTS` | int | `3` | 0–12 | OCR variant attempts. Independent of the request's `max_variants`. |
| `OCR_TIMEOUT_MS` | int | `45000` | 1000–300000 | Per-request OCR budget and per-pass worker timeout. |
| `OCR_LANG_PATH` | string | `assets/tessdata` | path | Relative paths resolve against the process working directory. |
| `OCR_LANG` | string | `eng` | Tesseract language code | Must match a file in `OCR_LANG_PATH`. |
| `OCR_WORKER_LIMIT` | int | `1` | 1–8 | Worker pool size. Higher values trade memory for concurrency. |
| `OCR_MAX_DIMENSION` | int | `1400` | 400–4000 | Longest side handed to Tesseract. The working raster is copied and capped to this before the OCR plan runs (`src/analyze/orchestrator.ts:249`). Barcodes still get the full `WORKING_MAX_DIMENSION` raster. Raising it above ~1800 costs memory roughly in proportion to pixel count without improving accuracy — see [Tuning](#tuning). |
| `OCR_CACHE` | bool | `false` | see above | Tesseract's own traineddata cache. Has no effect on the analysis response cache. |

### Response cache

| Variable | Type | Default | Range | Notes |
|----------|------|---------|-------|-------|
| `CACHE_ENABLED` | bool | `true` | see above | |
| `CACHE_MAX_ENTRIES` | int | `128` | 0–10000 | `0` disables storage. |
| `CACHE_TTL_SECONDS` | int | `900` | 1–86400 | |

### Diagnostics

| Variable | Type | Default | Notes |
|----------|------|---------|-------|
| `EXPOSE_METRICS` | bool | `true` | `false` makes `GET /metrics` return `404`. |
| `LOG_OCR_TEXT` | bool | `false` | Parsed and carried in the config object but **never read** — see [known divergences](#known-divergences-and-dead-configuration). |

## Environment variables read outside the schema

Two variables are read directly from `process.env` and are **not** validated, not
range-checked, and not reported by `GET /version`:

| Variable | Default | Read at | Notes |
|----------|---------|---------|-------|
| `SHUTDOWN_GRACE_MS` | `10000` | `src/index.ts:15` | Force-exit deadline during graceful shutdown. A non-numeric value becomes `NaN` and `setTimeout` treats it as "fire immediately". |
| `VISION_ENABLE_QUAGGA2` | unset | `src/barcode/adapters/quagga2.adapter.ts:49` | Must be exactly `'true'` to make the Quagga2 adapter report `available`. Only useful together with a canvas shim; without one its decode stage returns nothing. |
| `RENDER_GIT_COMMIT` | unset | `src/routes/operational.ts:56` | Set by Render; surfaces as `build_sha` in `GET /version`. |

`NODE_ENV` is also read by nothing else; `isProduction` is derived from it.

## Deploying

Four deployment files are checked in. They are the authoritative configuration; this
section explains what they do and where they disagree with the code or with each other.

| File | Purpose |
|------|---------|
| `render.yaml` | Render Blueprint. One `type: web` service, `runtime: docker`, and the full env-var set. |
| `Dockerfile` | Multi-stage production image: `deps` → `build` → `runtime`. |
| `.dockerignore` | Keeps `assets/` and `src/`; excludes `dist`, `node_modules`, `tests`, `docs`, `clients`, `.scratch`, `.env*`. |
| `.env.example` | Every schema variable at its real default, for local development only. |

`The schema has 39 variables (`src/config/index.ts:35-120`). `.env.example` and
`render.yaml` each set 36 of them, and the two sets are identical. The three neither
file sets:

| Variable | Why it is absent |
|----------|------------------|
| `NODE_ENV` | The platform and the Docker image set it to `production`. |
| `WORKING_MAX_DIMENSION` | Added to the schema after both files were written; falls back to 2200. |
| `OCR_MAX_DIMENSION` | Same; falls back to 1400. |

Where they do set a value, it matches the schema default except for the ones the
platform or an operator is expected to override (`PORT`, `TRUST_PROXY`,
`REQUEST_TIMEOUT_MS`). Neither file sets `SHUTDOWN_GRACE_MS`, `VISION_ENABLE_QUAGGA2`
or `RENDER_GIT_COMMIT` — those are read outside the schema, so the platform supplies
the third and the first two keep their defaults.

### Docker image

`Dockerfile` is a three-stage build:

| Stage | Base | What it does |
|-------|------|--------------|
| `deps` | `node:24-slim` | `npm ci --omit=dev --ignore-scripts=false`. Scripts must run: `sharp` needs its install step to place the glibc libvips prebuild. |
| `build` | `node:24-slim` | Full `npm ci`, then `tsc -p tsconfig.build.json` into `dist/`. |
| `runtime` | `node:24-slim` | Copies only `node_modules` (from `deps`), `dist`, `package.json` and `assets`. Runs as uid 10001 (`nodeapp`). |

Facts worth knowing before you change it:

- `EXPOSE 8000` and `ENV PORT=8000` (`Dockerfile:63,70`) match the config default.
  `HOST` is not set in the image; the default `0.0.0.0` from `src/config/index.ts:39`
  is what makes the container reachable.
- `COPY --chown=nodeapp:nodeapp assets ./assets` (`Dockerfile:61`) is load-bearing.
  `.dockerignore` deliberately does **not** exclude `assets/`, because
  `assets/tessdata/eng.traineddata.gz` is the default `OCR_LANG_PATH` target and the
  service must never fetch language data from a CDN at runtime.
- `WORKDIR /app` is set in the base stage and inherited, so the relative default
  `OCR_LANG_PATH=assets/tessdata` resolves to `/app/assets/tessdata` without any extra
  configuration. On a non-container host the working directory is whatever you launch
  from, so pass an absolute path there.
- `HEALTHCHECK` (`Dockerfile:72-73`) polls `/health` every 30 s with a 10 s start
  period and 3 retries. `/health` returns `503` until a barcode engine reports
  available, so on a cold start the container may be marked unhealthy during the warm-up
  window and then recover.
- `STOPSIGNAL SIGTERM` (`Dockerfile:76`) is what triggers the graceful path in
  `src/index.ts:45-68`, including the Tesseract worker teardown. Do not override it
  with `SIGKILL` in the platform config or the process will be killed before
  `visionService.close()` runs.
- The image sets `NODE_ENV=production`, which is what makes the logger emit JSON
  rather than pretty output.

The parent `render.yaml` belongs to the Angular front end and has nothing to do with
this service; the service's own blueprint is `vision-api/render.yaml`.

### Render

Launch the checked-in blueprint rather than configuring by hand:

```
Render Dashboard > Blueprints > New Blueprint Instance
```

or, from the header comment at `render.yaml:3-4`:

```bash
render blueprint launch https://github.com/barcode-benchmark/vision-api --branch main --path .
```

What the blueprint sets (`render.yaml:17-37`):

| Setting | Value | Note |
|---------|-------|------|
| `runtime` | `docker` | Uses the `Dockerfile` above, so assets and native deps are reproducible. |
| `plan` | `starter` | The comment at `render.yaml:23` notes 512 MB is the floor for WASM + `sharp` + OCR. |
| `region` | `oregon` | Change to whatever is nearest your users. |
| `healthCheckPath` | `/health` | Public, cheap, engine-state aware. |
| `numRetries` | `2` | Restart attempts on health-check failure. |
| `dockerCommand` | `node dist/index.js` | Identical to the Dockerfile `CMD`; harmless duplication. |
| `buildFilter` | 6 path globs | Rebuild only when `Dockerfile`, manifests, tsconfigs, `src/`, `assets/` or `scripts/` change. |
| `API_KEYS` | `sync: false` | Render prompts for it on first launch. Leaving it empty starts the service with **no authentication**. |

Two things to get right before the first deploy:

1. **Set `API_KEYS`.** It is the only `sync: false` variable, so it is the one value
   Render cannot fill in for you. With it empty, `POST /v1/analyze` is open to anyone
   who can reach the service.
2. **`TRUST_PROXY` ships as `false` in the blueprint** (`render.yaml:44-45`). Render
   terminates TLS and forwards the caller's address in `X-Forwarded-For`. With
   `TRUST_PROXY=false`, `request.ip` is Render's own proxy for every request, so
   **every caller shares one rate-limit bucket** and the `RATE_LIMIT_MAX=60` limit
   applies to the whole service rather than per client. Flip this to `true` unless you
   know the service is reachable only through something that already normalises the
   header.

Do not hardcode `PORT`: Render injects it, and the config reads it from the
environment.

### Any Node host

The container is the supported deployment shape, but nothing in `src/**` requires it:

```bash
npm ci
npm run build
NODE_ENV=production OCR_LANG_PATH="$PWD/assets/tessdata" TRUST_PROXY=true \
  API_KEYS=... node dist/index.js
```

Put it behind a reverse proxy that sets `X-Forwarded-For`, and set `TRUST_PROXY=true`
so the rate limiter keys on the caller. If your proxy terminates TLS, `ALLOW_HTTP`
still defaults to `false` — that setting is about the *source image URL*, not about
how clients reach this service.

`dist/index.js` is the single entrypoint (`package.json:14`); the ESM output expects
the `assets/` directory to sit next to wherever you run it from.

Memory: the process holds one decoded RGBA raster per in-flight request, a second
capped copy for OCR, every preprocessing variant (each a full RGBA copy) and the
Tesseract worker pool. A 2200×2200 raster is 19.4 MB and a 1600×1600 one is 10.2 MB —
those two figures come from `src/config/index.ts:104-105`, not from my own measurement.
Tesseract peak RSS measured on the synthetic label with `tessdata-fast`
(`src/imaging/resize.ts:12-17`):

| Longest edge fed to Tesseract | Pixels | Peak RSS | Mean confidence |
|------------------------------|--------|----------|-----------------|
| 800 px | 0.9 MP | 191 MB | 92 |
| 1400 px | 2.7 MP | 207 MB | 93 |
| 1800 px | 4.5 MP | 245 MB | 93 |
| 3170 px (upscaled) | 14.0 MP | 361 MB | 92 |
| 4400 px (upscaled) | 26.9 MP | 465 MB | 90 |

That table is the reason `OCR_MAX_DIMENSION` defaults to 1400: past ~1800 px the
process grows by roughly 70 MB per doubling of pixels while confidence does not move.
On a 512 MB instance the old 4400 px path was the difference between running and being
OOM-killed. `OCR_WORKER_LIMIT` is the other memory knob.

### Reference client

`clients/foodguard-client/` is a zero-dependency TypeScript client for
`POST /v1/analyze`, published as a workspace-local package
(`clients/foodguard-client/package.json`, `private: true`, `main`/`types` pointing at
the raw `src/index.ts` — it is not built and not published to a registry).

| Item | Value |
|------|-------|
| Auth header | `X-API-Key` by default; `authHeader: 'authorization'` switches to `Authorization: Bearer <key>`. |
| Default timeout | `DEFAULT_TIMEOUT_MS = 60000` (`clients/foodguard-client/src/http.ts:111`) — sized for a full OCR pass. |
| Retry | `DEFAULT_RETRY` (`clients/foodguard-client/src/http.ts:56`), overridable per call with `retry: false`. |
| Default base URL | `http://127.0.0.1:8080` (`clients/foodguard-client/src/client.ts:104`) — **note the mismatch with the service's real default port of 8000.** |
| Env vars | `FOODGUARD_VISION_API_URL`, `FOODGUARD_VISION_API_KEY`, `FOODGUARD_VISION_TIMEOUT_MS`, `FOODGUARD_IMAGE_URL`, `FOODGUARD_REQUEST_ID`. |
| Run the example | `npm --prefix clients/foodguard-client run example`. The client declares no dependencies of its own, so this resolves `tsx` from the repository root's `node_modules/.bin` — run `npm install` at the root first. Set `FOODGUARD_VISION_API_KEY`, or expect a 401. |

The client's `types.ts` mirrors `src/analyze/schema.ts` by hand and asserts
`schema_version` on every response (`clients/foodguard-client/src/client.ts:296`), so a schema bump surfaces as
an error rather than silent drift. That mirroring is manual: the two files can and do
fall out of step.

## Startup sequence

1. `loadConfig()` validates the environment. Failure here exits non-zero with a
   `fatal: failed to start foodguard-vision-api:` line on stderr
   (`src/index.ts:79-84`) — no logger exists yet at that point.
2. The Fastify app is built: helmet, CORS, rate limit, request context, request-id
   header, auth, 404 handler, error handler, then routes.
3. Engine warm-up is fired **without awaiting** (`src/index.ts:25-28`), so the port
   opens immediately and the health check can answer. Warm-up failure is logged as a
   warning; the service still serves.
4. The listening log line reports version, port, host, env, `auth_enabled`,
   `ocr_enabled`, `rate_limit_max` and `request_timeout_ms`.

Watch for this line to confirm the configuration the process actually took:

```json
{"level":30,"service":"foodguard-vision-api","version":"1.0.0","port":8000,"host":"0.0.0.0","env":"production","auth_enabled":true,"ocr_enabled":true,"rate_limit_max":60,"request_timeout_ms":90000,"msg":"foodguard-vision-api listening"}
```

## Health checks

`GET /health` — public, rate-limit exempt, no image work.

| Status | Meaning |
|--------|---------|
| `200`, `status: "ok"` | At least one barcode engine reports `available`. |
| `503`, `status: "degraded"` | No barcode engine is available. Requests will still be served but no barcode will ever be found. |

The `engines` block reports `total`, `available` and the names of the available
engines. There is no OCR readiness signal: a missing or broken tessdata file does not
affect `/health` at all.

Use `/health` as the platform health check. Do not use `/v1/status` for this — it is a
static document that checks nothing.

## Shutdown and restarts

`SIGTERM` and `SIGINT` both trigger the same path (`src/index.ts:45-68`):

1. A `SHUTDOWN_GRACE_MS` (default 10000) force-exit timer starts, `unref`'d so it never
   holds the process open.
2. `app.close()` drains in-flight HTTP requests.
3. `app.visionService.close()` terminates the Tesseract workers and rejects anything
   still parked waiting for one (`src/ocr/engine.ts:278-297`). This step matters:
   Tesseract keeps native handles open and the process will not exit without it.
4. A final metrics snapshot is logged and the process exits `0`.

If anything throws, the process exits `1`. If the grace period expires first, it
exits `1` with `graceful shutdown timed out; forcing exit`.

On Render, give the service at least ~15 s of termination grace so step 3 can run.

An `uncaughtException` exits `1` immediately without draining. An `unhandledRejection`
is logged at `error` and the process keeps running.

## Logging

pino, one JSON object per line, `service: "foodguard-vision-api"` on every line and an
ISO timestamp (`src/core/logger.ts:29-55`).

Redacted paths: `req.headers.authorization`, `req.headers["x-api-key"]`,
`req.headers.cookie`, `headers.authorization`, `headers["x-api-key"]`, `*.image_url`,
`*.imageUrl`, `api_key`, `apiKey`. Image URLs in diagnostics are reduced to
`protocol//host/path` with no query string.

Messages worth alerting on:

| Message | Level | Meaning |
|---------|-------|---------|
| `foodguard-vision-api listening` | info | Startup succeeded. |
| `barcode engines warmed` | info | Warm-up finished; `engines` lists what came up. |
| `engine warm-up failed; the service will still serve requests` | error | At least one engine could not be loaded. |
| `engine initialisation failed; continuing without it` | warn | One engine failed; others still run. |
| `discarding busy ocr worker` | warn | A Tesseract pass overran `OCR_TIMEOUT_MS`. Recurring at this level means OCR cannot keep up. |
| `ocr worker unavailable` | warn | `acquire()` timed out. |
| `analysis served from cache` | info | Cache hit. |
| `analysis complete` | info | One line per analysis: totals, detections, quality, warnings. |
| `request failed` | error | 5xx, with a stack trace in the payload. |
| `request rejected` | info | 4xx, no stack. |
| `shutdown requested` / `shutdown complete` | info | Rolling deploy lifecycle. |
| `fatal: failed to start foodguard-vision-api: ...` | stderr | Configuration or startup failure; the process exited. |

Set `LOG_LEVEL=debug` to get per-variant barcode timings (`barcode variant complete`
with `variant_ms` and `cumulative_ms`). This is the most useful level when tuning, and
noisy in production.

## Metrics

`GET /metrics` — public unless `EXPOSE_METRICS=false`, in which case it returns `404`.
JSON, in-process, reset on restart. Full field reference in the
[API reference](API.md#metrics-reference).

Because metrics are per-process, a horizontally scaled deployment reports each
instance separately. Scrape each one and sum or aggregate upstream. There is no
Prometheus text exposition format and no push path.

`GET /version` is the better first stop when diagnosing: it reports the effective
config, the engine registry with per-engine status and last error, and the live cache
statistics.

## Resource limits

Per request:

| Limit | Value | Enforced at |
|-------|-------|-------------|
| Request body | 16384 bytes | Fastify `bodyLimit` |
| Download | 8 MiB | `Content-Length` check plus streaming counter |
| Download wall clock | 12000 ms | `AbortSignal` plus undici connect/header/body timeouts |
| Redirects | 3 | manual loop, each hop re-validated |
| Image longest side | 6000 px | before full decode |
| Image pixels | 40 MP | before full decode, and as sharp's `limitInputPixels` |
| Working resolution | `WORKING_MAX_DIMENSION`, 2200 px | downscale after decode and EXIF rotation (`src/ingest/decode.ts:99-116`) |
| OCR raster cap | `OCR_MAX_DIMENSION`, 1400 px | copy-and-cap before the OCR plan (`src/analyze/orchestrator.ts:249`) |
| Barcode stage | 9000 ms (`standard`) | per-variant check plus an outer `withTimeout` |
| OCR stage | 45000 ms | outer `withTimeout` plus a per-pass worker race |
| OCR passes | `min(OCR_MAX_VARIANTS, 4)` = 3 by default | `src/ocr/pipeline.ts:80` |
| OCR workers | 1 | pool size; extras queue with a hard wait timeout |

Per process:

| Resource | Bound |
|----------|-------|
| Response cache | 128 entries |
| Log redaction | applied at the pino layer, no size cap configured |
| WASM engine modules | one instance per engine, initialised once |

## SSRF policy

`image_url` is the only untrusted input the service acts on, and it is the only SSRF
surface. The defences are layered; each layer is independently sufficient to stop a
class of attack.

**1. URL syntax** (`src/ingest/urlPolicy.ts:36-112`)

- Absolute URL required; length capped at 2048 characters.
- Scheme must be `http:` or `https:`.
- Credentials in the URL are rejected outright.
- A hostname is required.
- Decimal-encoded IPv4 (`http://2130706433/`) is rejected.
- Hex-encoded IPv4 (`http://0x7f000001/`) is rejected.

**2. Hostname blocklist** (`src/ingest/urlPolicy.ts:25-34`)

`localhost`, `*.local`, `*.internal`, `*.localdomain`, `metadata`, `metadata.*`,
anything containing `metadata`, and the literal `169.254.` prefix.

**3. Scheme enforcement** (`src/ingest/urlPolicy.ts:82-87`)

`http://` requires `ALLOW_HTTP=true` or the host appearing in `HTTP_ALLOWED_HOSTS`.

**4. Port allowlist** (`src/ingest/urlPolicy.ts:89-98`)

Only 443 for `https` and 80 for `http` unless the port is in `ALLOWED_URL_PORTS`.

**5. Host allowlist** (`src/ingest/urlPolicy.ts:100-109`)

When `ALLOWED_IMAGE_HOSTS` is non-empty, only those hosts and their subdomains are
fetchable. This is the strongest single control: an explicit egress allowlist.

**6. IP range classification** (`src/ingest/ipPolicy.ts`)

IPv4 blocked: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`,
`192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`,
`203.0.113/24`, `224/4`, `240/4`. Leading zeros in an octet are rejected outright
rather than guessed at.

IPv6 blocked: unspecified, loopback, IPv4-mapped and IPv4-compatible forms (judged as
the embedded IPv4), link-local, unique local `fc00::/7`, multicast `ff00::/8`,
`2001:db8::/32` documentation, `100::/64` discard, Teredo, and `2002::/16`.

**7. Post-resolution check** (`src/ingest/urlPolicy.ts:154-166`)

Every address in the DNS answer is classified, and **one** blocked answer rejects the
whole request. Mixing public and private answers is exactly the DNS-rebinding setup.

**8. Redirect re-validation** (`src/ingest/downloader.ts:156-171`)

Redirects are followed manually, never by the HTTP client, and every hop goes through
validation steps 1–7 again. A redirect to `169.254.169.254` is blocked.

**9. Connection-time re-check** (`src/ingest/urlPolicy.ts:182-223`)

A custom `lookup` is installed on the undici agent, so the range check runs again at
connect time. An answer that changes between validation and connection cannot slip
through.

**10. Content verification** (`src/ingest/downloader.ts:193-236`)

The response content type must be an image type (`application/octet-stream` is
tolerated), and the bytes must independently sniff as a supported image. A text page
or an HTML error page is rejected regardless of headers.

**11. Bounds**

8 MiB, 12 s, 3 redirects, streamed with a hard byte counter, never buffered to disk.

### `PRIVATE_HOST_ALLOWLIST`

The single exemption from steps 6, 7 and 9. It exists so an operator can point the
service at internal object storage. Use it only for hosts you control, and prefer
`ALLOWED_IMAGE_HOSTS` where it suffices — the allowlist is the narrower control.

## Tuning

### Latency

OCR dominates. In a captured run on a 1584×2200 label, OCR was 7072 ms of an 8937 ms
request; on the same machine a 286×126 barcode-only PNG took 275 ms of 325 ms.

| Goal | Change |
|------|--------|
| Cut latency for barcode-only scans | `options.ocr: false` per request. |
| Cut latency for all requests | Lower `OCR_MAX_VARIANTS` to `1` — one variant, PSM 3. |
| Cut latency further | Lower `OCR_TIMEOUT_MS`; the pass is raced and a timeout discards the worker. |
| Cut barcode latency | `options.plan: "fast"` — 4 variants, 8000 ms cap instead of 9000. |
| Cut cost on large images | `MAX_IMAGE_DIMENSION` lower than 6000 rejects rather than downscales, so use it as a rejection policy you advertise, not as a resize knob. To shrink the raster instead of rejecting it, lower `WORKING_MAX_DIMENSION`. |
| Survive on a 512 MB instance | Lower `WORKING_MAX_DIMENSION` to 1600 and leave `OCR_MAX_DIMENSION` at 1400. Both are the settings the measurements above point at. |

`OCR_WORKER_LIMIT` above 1 lets concurrent requests progress instead of queueing, at
the cost of one WASM heap per worker. With the default of 1, concurrent requests
serialise behind the single worker and can each hit the acquire timeout.

### Barcode detection

| Goal | Change |
|------|--------|
| Recover a low-contrast or glared code | `options.plan: "deep"` — 21 variants including `auto_roi`, `barcode_crop`, `deskew`, `sauvola`, `perspective_correction`. Costs the most time. |
| Raise the bar for what counts as a detection | `BARCODE_MIN_CONFIDENCE`. Read the caveat in the API reference first: it is not a hard filter. |
| Change how many engines run | Not configurable. `getPlan(3)` is hardcoded (`src/barcode/pipeline.ts:95`). |
| Trade resolution for memory | `WORKING_MAX_DIMENSION`. Every preprocessing variant is a full RGBA copy of the working raster, so this is a near-linear memory multiplier *and* a large latency one: ZXing-C++ measured 858 ms at 2200 px against 189 ms at 1600 px on the same image (`src/config/index.ts:104-107`). Lower it on a small host; raise it only if you have measured that small barcodes need it. |
| Add Quagga2 | `VISION_ENABLE_QUAGGA2=true` **and** a canvas shim. Without both it reports `platform_unsupported` and is excluded. |

Fusion weights, format priors and the early-exit thresholds are compile-time constants
in `src/barcode/fusion.ts` and `src/barcode/pipeline.ts`. They are not configurable.

### OCR

| Variable | Effect |
|----------|--------|
| `OCR_MAX_VARIANTS` | More variants means more passes and a better chance of readable text. `0` and `1` both collapse to a single variant (`Math.max(1, ...)` in `src/imaging/variants.ts:67`). |
| `OCR_TIMEOUT_MS` | Serves three purposes at once: the outer stage deadline, the per-pass race, and the worker acquire timeout. Raising it also lets a pathological pass hold a worker longer. |
| `OCR_WORKER_LIMIT` | Pool size. Memory scales with it. |
| `OCR_MAX_DIMENSION` | Longest edge handed to Tesseract. Raising it past ~1800 buys memory, not accuracy — see the table in [Deploying](#deploying). Lowering it below 400 is rejected by the schema. Lowering it is the cheapest way to fit a small-RAM host. |
| `OCR_LANG` | Adding languages changes `OCR_LANG_PATH` requirements and OCR accuracy. |
| `OCR_CACHE` | Tesseract's traineddata cache only. Safe to enable if the traineddata is writable; it does nothing for the analysis response cache. |

When OCR is the problem, check `ocr.variants_attempted` in a response before tuning.
It shows every pass with its confidence, character count and duration, and which one
won.

### Cache

| Goal | Change |
|------|--------|
| Raise hit rate for repeated scans | `CACHE_TTL_SECONDS` and `CACHE_MAX_ENTRIES`. |
| Guarantee no cross-request state | `CACHE_ENABLED=false`. |
| Understand current behaviour | `cache` object in `GET /metrics` or `GET /version`. |

The key is the image content hash, so a change of CDN URL for identical bytes still
hits. `timeout_ms` is not part of the key. A cache hit still downloads the image.

### Rate limiting and CORS

| Goal | Change |
|------|--------|
| Per-caller limits behind a proxy | `TRUST_PROXY=true`, then `RATE_LIMIT_MAX` per key. |
| Never rate-limit | `RATE_LIMIT_MAX` cannot be disabled; raise it. Operational endpoints are exempt regardless. |
| Browser clients | `CORS_ORIGINS` must be non-empty or no CORS headers are sent at all. Credentials are not permitted (`credentials: false`). |

## Troubleshooting

| Symptom | Likely cause | What to check |
|---------|--------------|----------------|
| `401` on every request | `API_KEYS` set but the header is missing or wrong | Both `X-API-Key` and `Authorization: Bearer` are read; `x-api-key` wins. `/health` and `/version` stay public. |
| `401` from a path that does not exist | The auth hook runs before the not-found handler | Send a key; the 404 then appears. |
| `429` immediately | `TRUST_PROXY` false behind a proxy, so all callers share the proxy IP's bucket | Set `TRUST_PROXY=true`. |
| `429` on `/health` | Requesting `/health/` with a trailing slash | The rate-limit allowlist compares `request.url` exactly; use the bare path. |
| `400 VALIDATION_ERROR` on a valid-looking body | The schema is `.strict()`; an unexpected key at either level | Compare against `GET /v1/analyze/schema`. `image_base64` is not a valid field. |
| `400 BLOCKED_URL` on a legitimate image | The host resolves into a private range, or is not in `ALLOWED_IMAGE_HOSTS` | The reason is logged, not returned. If the host is yours, add it to `PRIVATE_HOST_ALLOWLIST`. |
| `400 UNSUPPORTED_SCHEME` | `http://` while `ALLOW_HTTP=false` | Use `https://`, or allow that host in `HTTP_ALLOWED_HOSTS`. |
| `400 INVALID_URL` with no explanation | Port not permitted, credentials in the URL, or a decimal/hex IP literal | Check the port against `ALLOWED_URL_PORTS`. |
| `502 DOWNLOAD_FAILED` | DNS failure, non-2xx, or too many redirects | `download_failed_total` is incremented. The upstream status is in the logged `details`. |
| `504 DOWNLOAD_TIMEOUT` | Slow origin | Raise `DOWNLOAD_TIMEOUT_MS` or use a faster source. |
| `413 DOWNLOAD_TOO_LARGE` | Image over `DOWNLOAD_MAX_BYTES` | Raise the cap, or compress the image before publishing it. |
| `400 INVALID_IMAGE` | The URL did not return image bytes | A signed URL that has expired, an HTML error page, or a content type mismatch. The magic-byte sniff is authoritative. |
| `413 IMAGE_TOO_LARGE` | Over `MAX_IMAGE_DIMENSION` or `MAX_IMAGE_PIXELS` | Both are advertised limits. `image_too_large_total` counts it. |
| `barcode.detected` false on a visible barcode | The sweep exhausted its budget or its variants | Read `barcode.stop_reason`: `time_budget_exhausted` means raise `BARCODE_MAX_MS` or lower resolution; `variant_budget_exhausted` means raise `BARCODE_MAX_VARIANTS` or use `plan: "deep"`. |
| Barcode found but `confidence` looks low | Only one engine agreed | Check `confidence_breakdown.consistency`: a single observation scores `0`. Re-running the same image under a different URL will not help — the cache is keyed on content, and confidence is not cached differently. |
| `confidence` lower than expected for a correct GTIN | The `consistency` term is log-shaped and needs repeat observations | This is deliberate: a checksum-valid misread is indistinguishable from a true read on structural grounds alone. |
| `ocr.detected` true but `ingredients.detected` false | OCR returned text without a recognisable ingredients heading | Inspect `ocr.raw_text`. The heading match is regex-based (`src/text/sections.ts`). |
| `ocr.detected` false, `failure_reason: "ocr_disabled"` | `options.ocr: false` or `OCR_ENABLED=false` | Check `warnings` for `ocr_disabled_by_configuration`. |
| `ocr.detected` false on the first call after deploy | Cold Tesseract init lost the race against the acquire timeout | Expected on a cold start; retry. `/health` does not cover OCR. |
| Repeated `discarding busy ocr worker` warnings | OCR passes overrunning `OCR_TIMEOUT_MS` | Lower `OCR_MAX_VARIANTS` or raise `OCR_TIMEOUT_MS`; a discarded worker is destroyed and replaced, which costs an init. |
| `warnings` contains `barcode_stage_failed` | The barcode stage threw or overran its hard deadline | `diagnostics.engines[].error` holds the engine-level error. |
| `diagnostics.timings_ms` does not match wall clock on a cache hit | Cache-hit responses carry the original run's stage timings | `cache_hit: true` and `cache_lookup_ms` tell you so. |
| `GET /metrics` returns 404 | `EXPOSE_METRICS=false` | Flip it back. The 404 body is `{ "error": { "code": "NOT_FOUND", "message": "Metrics are disabled." } }` — a different shape from the route 404. |
| Metrics counters reset unexpectedly | They are process-local | Expected on deploy or restart. There is no persistence. |
| Service exits at boot with `Invalid environment configuration` | A variable is out of range | The message lists every offending key and the zod reason. |
| Nothing is written to disk, ever | By design | The image lives only for the request; the response cache is in memory. |
| Service hangs on shutdown | Tesseract workers were not terminated | `visionService.close()` handles this. A `SHUTDOWN_GRACE_MS` timeout forces exit `1`; raise the platform's termination grace. |

## Known divergences and dead configuration

Documented rather than fixed, since this service's source is owned elsewhere. Each is
traceable to a line.

| Item | Detail |
|------|--------|
| Default port contradiction | `src/index.ts:4` says the local default is 8080. `src/config/index.ts:40` defaults it to 8000. 8000 is the real default. |
| `REQUEST_TIMEOUT_MS` is inert | Parsed and validated at `src/config/index.ts:63`, logged at `src/index.ts:40`, never enforced. The comment at `src/config/index.ts:62` and at `src/routes/operational.ts:86` claims the client gets a 504 past it; no code path produces that. Per-stage budgets are what actually bound a request. |
| `LOG_OCR_TEXT` is dead | Parsed at `src/config/index.ts:119` and carried as `diagnostics.logOcrText`, never read by any other module. Setting it does nothing. |
| `SHUTDOWN_GRACE_MS` unvalidated | Read straight from `process.env` at `src/index.ts:15`, bypassing the schema. |
| `BARCODE_MIN_CONFIDENCE` is not a hard filter | `src/barcode/fusion.ts:211-216` applies it only when the leader has no confidence. In the normal path the filter is `confidence >= leader * 0.6`. |
| Auth exemption list is hardcoded | `src/server.ts:131` exempts `/`, `/health`, `/version`, `/metrics` only, so `/v1/status` and `/v1/analyze/schema` require a key. |
| Rate-limit allowlist is exact-match | `src/server.ts:93` compares `request.url`, so `/health/` is rate-limited despite `ignoreTrailingSlash: true`. |
| No-op ternary | `src/ingest/downloader.ts:178` evaluates `status === 404 \|\| status === 410 ? DOWNLOAD_FAILED : DOWNLOAD_FAILED`. |
| Unreachable pipeline stages | `PipelineStage` declares `validated`, `preprocess` and `fusion` (`src/core/requestContext.ts:9-19`), but `setStage` is only ever called with `received`, `download`, `decode`, `barcode`, `ocr`, `text` and `respond`. Those three values never appear in `meta.failure_stage`. |
| `confidence_source: "engine"` is never observed for barcodes | Declared in the schema at `src/analyze/schema.ts:43`; no wired engine exposes a per-result score (`src/barcode/fusion.ts:9-12`). It *is* observed for OCR, where `ocr.confidence_source` is `engine`. |
| Misleading variable name | `src/barcode/fusion.ts:230` names the non-2D fallback `twoD`; the predicate is `!TWO_D_FORMATS.has(...)`. Behaviour is correct, the name is not. |
| HTTP-layer test does not compile | `tests/api.test.ts` closes its outer `describe` at line 58, orphaning the `imgServer` binding declared at line 11. `npx tsc -p tsconfig.json --noEmit` reports `TS2304: Cannot find name 'imgServer'` at lines 93, 103, 139, 149, 180, 189, 212, 222. `src/**` typechecks clean, so `npm run build` and the Docker build are unaffected; `npm test` is not. |
| `tests/helpers.ts` exports are unused | `startTestServer` and `TEST_ENV` are exported but the only importer, `tests/api.test.ts:2`, imports `startImageServer`, `withEnv`, `TEST_ENV` and `TEST_API_KEY`. `startTestServer` has no caller. |
| Schema endpoint advertises a limit the route removes | `src/routes/analyze.ts:104` publishes `timeout_ms` with `max: 300000`, but `src/routes/analyze.ts:66-70` clamps it to `max(BARCODE_MAX_MS, OCR_TIMEOUT_MS)` — 45000 ms with defaults. The clamp is disclosed in an `x-timeout-clamped-ms` response header (`src/routes/analyze.ts:79`), not in `warnings`, so a client that only parses the body is not told. |
| Upscaling OCR variant survives a change that made it pointless | `src/imaging/resize.ts:19-22` argues that upscaling "inflating a 2200 px raster to 4400 px to *lower* mean confidence" was the OOM cause, yet `gray_upscale2x` is still first in the default OCR variant order (`src/imaging/variants.ts:66`). The new cap in front of the plan (`src/analyze/orchestrator.ts:249`) makes it harmless rather than removing it: it now upscales from ≤1400 px. Cost is still wasted work per OCR pass. |
| `gray_upscale2x` is capped, not removed | Consequence of the above: `OCR_MAX_DIMENSION` is applied once, before the variant plan, so an in-plan upscale can still exceed the cap. Nothing re-caps between variants. |
| Dead AJV configuration | `src/server.ts:48` sets `removeAdditional: false` and `coerceTypes: false`, but no route registers a Fastify JSON schema — validation is zod-only. |
| Stray debug files | `ocrprobe.mjs`, `zxingprobe.mjs` and `.scratch/` sit in the service root. `.scratch/` is excluded from the build (`tsconfig.build.json:9`) and from the image (`.dockerignore`); the two `.mjs` files are not referenced by any script. |
| Blueprint disables `TRUST_PROXY` | `render.yaml:44-45` sets `TRUST_PROXY: false`. Behind Render's proxy that makes `request.ip` constant for every caller, so `RATE_LIMIT_MAX` becomes a service-wide bucket instead of a per-client one. Everything else the blueprint sets agrees with `src/config/index.ts`. |
| Blueprint does not set the new resolution knobs | `render.yaml` and `.env.example` predate `WORKING_MAX_DIMENSION` and `OCR_MAX_DIMENSION`, so both fall back to the schema defaults (2200 / 1400). Harmless today, but the `starter` plan's 512 MB is exactly the case `src/imaging/resize.ts:21-22` was written for; consider pinning `WORKING_MAX_DIMENSION: 1600` in the blueprint. |
| Reference client points at the wrong default port | `clients/foodguard-client/src/client.ts:104` and `examples/analyze.ts:91` default to `http://127.0.0.1:8080`, the same stale 8080 that appears in `src/index.ts:4`. The service listens on 8000. |
| Reference client ships no README | `clients/foodguard-client/package.json:19` lists `README.md` in `files`, and `clients/foodguard-client/src/index.ts:10` points the reader at `./README.md`, but no such file exists in that directory. `npm pack` would silently omit it. |