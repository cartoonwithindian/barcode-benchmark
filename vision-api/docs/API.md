# FoodGuard Vision API — HTTP reference

Base URL in development: `http://localhost:8000` (`PORT` default, `src/config/index.ts:40`).
All request and response bodies are `application/json`.

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Rate limiting](#rate-limiting)
- [`POST /v1/analyze`](#post-v1analyze)
  - [Request body](#request-body)
  - [Options](#options)
  - [Response body](#response-body)
  - [Worked example — minimal](#worked-example--minimal)
  - [Worked example — Indian retail label](#worked-example--indian-retail-label)
  - [The confidence model](#the-confidence-model)
  - [Warnings](#warnings)
  - [Cache semantics](#cache-semantics)
- [Errors](#errors)
  - [Envelope](#envelope)
  - [Error codes](#error-codes)
  - [Envelope variations](#envelope-variations)
- [`GET /`](#get-)
- [`GET /health`](#get-health)
- [`GET /version`](#get-version)
- [`GET /metrics`](#get-metrics)
- [`GET /v1/status`](#get-v1status)
- [`GET /v1/analyze/schema`](#get-v1analyzeschema)
- [Metrics reference](#metrics-reference)

---

## Conventions

**Request IDs.** Every response carries an `x-request-id` header. If the request
supplied `x-request-id`, that value is used verbatim; otherwise a
`crypto.randomUUID()` is generated (`src/server.ts:46-47`, `src/core/requestContext.ts:42-44`).
The same value is echoed in the body as `request_id`. Quote it when reporting a problem.

**Trailing slashes.** The router is configured with `ignoreTrailingSlash: true`, so
`/v1/analyze` and `/v1/analyze/` route identically (`src/server.ts:45`). See
[envelope variations](#envelope-variations) for the one place where this does not
hold.

**Versioning.** `schema_version` is `"1"` and the API prefix is `v1`
(`src/analyze/schema.ts:20-21`). Adding a field is a minor change; renaming or
removing one is breaking and requires a `schema_version` bump. The value is echoed in
every success response, in `GET /health`, and in `GET /version`.

**Content type.** Requests must be `application/json`. Anything else returns
`UNSUPPORTED_MEDIA_TYPE` (415). Request bodies are capped at `BODY_LIMIT_BYTES`
(default 16384 bytes) because the body only ever carries a URL.

## Authentication

When `API_KEYS` is non-empty, every endpoint except `/`, `/health`, `/version` and
`/metrics` requires a key. The exemption list is hardcoded in the auth hook
(`src/server.ts:129-134`) and is **not** derived from a route registry.

Two header forms are accepted (`src/security/auth.ts:29-40`):

```http
X-API-Key: YOUR_KEY
```

```http
Authorization: Bearer YOUR_KEY
```

`x-api-key` wins if both are present. If `API_KEYS` is empty, authentication is
disabled entirely and `GET /version` reports `effective_config.auth_enabled: false`.

Failures return `401` with code `UNAUTHORIZED` and the message
`A valid API key is required.` The supplied key is never echoed, and comparisons are
constant-time over SHA-256 digests so neither the key nor its length leaks through
timing (`src/security/auth.ts:21-27`).

> Note that `GET /v1/status` and `GET /v1/analyze/schema` require a key even though
> they carry no operational risk.

## Rate limiting

`@fastify/rate-limit` is registered with `max = RATE_LIMIT_MAX` (default 60) over
`RATE_LIMIT_WINDOW` (default `1 minute`) (`src/server.ts:79-105`).

**Keying.** The bucket key is `key:<hash>` when an `x-api-key` or `authorization`
header is present, otherwise the request IP. The hash is a 32-bit FNV-1a, not the
credential itself. Keying on the credential means limits follow the caller rather
than the shared proxy IP.

> Behind a proxy you must set `TRUST_PROXY=true`. With the default `false`,
> `request.ip` is the proxy's address and every caller shares one bucket.

**Exempt paths.** `/health`, `/version` and `/metrics` are allowlisted so a health
check keeps working while a caller is limited. The comparison is an exact string
match on `request.url`, so `/health/` is *not* exempt even though it routes to the
same handler.

**Headers.** When `CORS_ORIGINS` is configured, the plugin's
`x-ratelimit-remaining` / `x-ratelimit-reset` / `retry-after` are exposed to
browsers.

**429 body.** Built by `errorResponseBuilder`, which has a different shape from the
normal error envelope — no `request_id`, no `meta`:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Retry after the indicated window.",
    "retry_after_seconds": 60
  }
}
```

## `POST /v1/analyze`

The only endpoint that does work. Defined in `src/routes/analyze.ts:44-79`, executed
by `VisionService.analyze` in `src/analyze/orchestrator.ts:136-505`.

### Request body

```json
{
  "image_url": "https://cdn.example.com/pack.jpg",
  "options": {
    "plan": "standard",
    "ocr": true,
    "max_variants": 6,
    "timeout_ms": 30000,
    "normalize_text": true
  }
}
```

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `image_url` | string | yes | 8–2048 characters. Must parse as an absolute `http`/`https` URL, carry no credentials, and pass the SSRF policy. |
| `options` | object | no | Strict object: unknown keys inside it are rejected. |

The body schema is `.strict()` at both levels, so any key not listed above — and any
key inside `options` not listed below — produces `VALIDATION_ERROR` (400).

**There is no base64 or multipart input.** The HTTP layer accepts `image_url` only.
A `image_base64` or `image` field is rejected as an unknown key. This diverges from
the original design brief; see the README's "Known divergences".

### Options

| Option | Type | Default | Range | Effect |
|--------|------|---------|-------|--------|
| `plan` | `fast` \| `standard` \| `deep` | `standard` | — | Barcode preprocessing budget. `fast` = 4 variants / 8000 ms, `standard` = up to 6 variants / 9000 ms, `deep` = up to 21 variants / 9000 ms. The millisecond figures are the plan's internal caps (`src/analyze/orchestrator.ts:70`) doubled, then clamped by `BARCODE_MAX_MS`. |
| `ocr` | boolean | `true` | — | Run the OCR stage. Ignored when `OCR_ENABLED=false`, in which case the response carries the warning `ocr_disabled_by_configuration`. |
| `max_variants` | integer | `BARCODE_MAX_VARIANTS` (6) | 1–40 | Cap on **barcode** preprocessing variants. Clamped down to `BARCODE_MAX_VARIANTS`. Has no effect on OCR — that uses `OCR_MAX_VARIANTS`. |
| `timeout_ms` | integer | — | 1000–300000 | Per-request wall-clock budget. Clamped down to `max(BARCODE_MAX_MS, OCR_TIMEOUT_MS)` — 45000 ms with defaults — and when that happens the response carries an `x-timeout-clamped-ms` header with the effective value (`src/server.ts:214`, `src/routes/analyze.ts:66-70,79`). Only the barcode budget derives from it. |
| `normalize_text` | boolean | `true` | — | Set `false` to skip the OCR correction pass. `normalized_text` then equals `raw_text`, `corrections` is empty and `normalization_confidence` is `1`. |
| `detect_barcode` | boolean | `true` | — | Set `false` for **text extraction only**: the barcode stage is skipped, OCR receives the whole request budget, and the response carries the warning `barcode_skipped_by_request` with `barcode.detected=false`, `barcode.primary=null` and `diagnostics.barcode_engines_attempted=[]`. Nothing is searched for, so nothing is reported. |

### Response body

Top level (`src/analyze/schema.ts:165-193`):

| Field | Type | Notes |
|-------|------|-------|
| `success` | boolean | Always `true` on a 200. Failures are HTTP errors, not `success: false` payloads. |
| `request_id` | string | Echoes the `x-request-id` value. |
| `schema_version` | string | `"1"`. |
| `analysis_id` | string | Optional; not populated by this build. |
| `image` | object | Decode facts. See below. |
| `barcode` | object | Fused barcode candidates. |
| `ocr` | object | OCR output and per-pass diagnostics. |
| `product` | object | Ten labelled fields, each with evidence. |
| `ingredients` | object | Parsed ingredient items. |
| `nutrition` | object | Parsed nutrient values. |
| `allergens` | object | Allergens by provenance. |
| `signals` | object | Cheap booleans for a backend fast-path. |
| `diagnostics` | object | Engine-level timings and per-engine reports. |
| `warnings` | string[] | Non-fatal problems. Empty array when clean. |

`image`:

| Field | Type | Notes |
|-------|------|-------|
| `width`, `height` | integer | Dimensions after EXIF orientation and downscaling. |
| `format` | string | Sniffed format: `jpeg`, `png`, `webp`, `gif`, `avif`, `tiff`, `heif`. BMP is recognised by the sniff but the bundled libvips cannot decode it, so a BMP upload is rejected up front with `INVALID_IMAGE` and a message telling you to convert it. JPEG2000 and SVG are not supported by this build. |
| `source_width`, `source_height` | integer | Dimensions as stored in the file. |
| `orientation_applied` | boolean | True when EXIF orientation was not 1. |
| `downscaled` | boolean | True when the source exceeded the working resolution, `min(MAX_IMAGE_DIMENSION, WORKING_MAX_DIMENSION)` — 2200 px by default (`src/ingest/decode.ts:99-100`). |
| `megapixels` | number | Working pixels / 1e6, 3 decimal places. |
| `source` | string | `protocol//host/path` of the resolved URL. Query string and credentials are stripped. |

`barcode`:

| Field | Type | Notes |
|-------|------|-------|
| `detected` | boolean | True when at least one candidate survived fusion. |
| `primary` | object \| null | `{ value, format, confidence, confidence_source }` for the recommended lookup key, or `null`. |
| `results` | array | Fused candidates, ranked. |
| `engines_attempted` | string[] | Engines that were actually run on at least one variant. |
| `engines_unavailable` | array | `{ engine, reason }` for every engine reporting a non-`available` status, with the engine's own reason string. |
| `preprocessing_variants_used` | string[] | Display names of the variants that ran. |
| `stop_reason` | string | `confidence_target_reached`, `multi_engine_agreement`, `variant_budget_exhausted`, `time_budget_exhausted`, or `not_run`. |
| `ms` | number | Wall-clock ms spent in the barcode stage. |

Each entry in `barcode.results` (`src/analyze/schema.ts:38-61`):

| Field | Type | Notes |
|-------|------|-------|
| `value` | string | Decoded payload, exactly as produced. |
| `format` | string | Canonical format name (see below). |
| `confidence` | number \| null | `0..1`, or `null` when unknown. |
| `confidence_source` | string | `engine`, `derived` or `unknown`. |
| `confidence_breakdown` | object | `{ agreement, consistency, structural, format_prior, engine }`. |
| `engines` | string[] | Engines that produced this exact payload, sorted. |
| `agreement` | integer | Count of distinct engines. |
| `observations` | integer | Count of `(engine, variant)` attempts. |
| `variants` | string[] | Variants that produced it, sorted. |
| `engine_confidence` | array | `{ engine, confidence }` per engine. `confidence` is `null` for every engine in this build. |
| `is_retail_gtin` | boolean | Format is EAN-8/EAN-13/UPC-A/UPC-E. |
| `is_indian_gs1` | boolean | Payload carries the `890` prefix. A hint, never a filter. |
| `is_url_payload` | boolean | Payload looks like a URL. |
| `bounding_box` | object | Present only when an engine supplied one. Coordinates are in the working (post-downscale) pixel space. |
| `fastest_ms` | number | Fastest single decode of this payload, ms. |
| `formats_reported` | string[] | Every format any engine reported for this payload, before reconciliation. |

Canonical format names (`src/barcode/types.ts:10-24`): `EAN-8`, `EAN-13`, `UPC-A`,
`UPC-E`, `Code 39`, `Code 93`, `Code 128`, `ITF`, `Codabar`, `QR Code`, `Data Matrix`,
`PDF417`, `Aztec`, `UNKNOWN`.

`ocr`:

| Field | Type | Notes |
|-------|------|-------|
| `detected` | boolean | True when Tesseract returned any non-whitespace text. **Not** a statement that the text is meaningful — a photo of a barcode alone yields `detected: true`. |
| `confidence` | number \| null | Mean word confidence `0..100` as reported by Tesseract. |
| `confidence_source` | string | `engine` when a result exists, otherwise `unknown`. |
| `engine` | string | Always `"tesseract"`. |
| `raw_text` | string | Untouched OCR output, newlines included. |
| `normalized_text` | string | Corrected text. |
| `corrections` | array | `{ kind, raw, corrected, confidence, start, end, reason }` per change. |
| `normalization_confidence` | number | Mean confidence of the applied corrections; `1` when nothing changed. |
| `regions` | array | `{ kind, text, bbox? }` per located section. `text` is the raw pre-normalisation section text. |
| `variants_attempted` | array | `{ variant, preprocess, psm, confidence, chars, ms, selected }` per pass. |
| `best_variant` | string \| null | The variant of the winning pass. |
| `ms` | number | Wall-clock ms in the OCR stage. |
| `failure_reason` | string \| null | `null` on success, `ocr_disabled`, `no_variant_processed` or `no_text_recognised`. |

> `selected` marks the best pass *so far*, so more than one entry can carry
> `selected: true`. Only the last one is the pass that produced `raw_text`; compare
> against `best_variant` to identify it.

> Before the OCR plan runs, the working raster is copied and capped so its longest
> edge is at most `OCR_MAX_DIMENSION` (default 1400 px,
> `src/analyze/orchestrator.ts:249`). The barcode stage still gets the full
> `WORKING_MAX_DIMENSION` raster. This means an OCR variant that upscales — the first
> in the default order is `gray_upscale2x` — now inflates a ≤1400 px raster rather
> than a 2200 px one, so its memory cost is bounded. Cap and copy cost is inside
> `timings_ms.ocr_ms`.

`product` — ten fields, each an `ExtractedField<T>`: `{ value, confidence,
confidence_source, evidence }`. `evidence` is the exact OCR substring the value was
read from (`src/text/product.ts:19-25`). Product name and brand are heuristic and
carry deliberately low confidence; labelled fields carry high confidence.

`ingredients`:

| Field | Type | Notes |
|-------|------|-------|
| `detected` | boolean | True when at least one item parsed. |
| `confidence` | number \| null | Derived, `0..1`. |
| `confidence_source` | string | `derived` or `unknown`. |
| `confidence_breakdown` | object | `{ heading, item_count, code_coverage, ocr }`. |
| `raw_section` | string | The section exactly as OCR produced it. |
| `items` | array | Ordered `IngredientItem`s. |
| `heading` | string \| null | The heading that opened the section. |

Each item (`src/text/ingredients.ts:24-41`):

| Field | Type | Notes |
|-------|------|-------|
| `raw` | string | Exactly what OCR produced. |
| `normalized` | string | Mechanical cleanup only: lowercased, trimmed, edge punctuation stripped. Never a synonym substitution. |
| `code` | string \| null | Additive code when present, e.g. `INS 621`. |
| `ins_reference_name` | string \| null | Reference name for `code`, or `null` when the code is not in the knowledge table. |
| `additive_class` | string \| null | Functional class derived from the INS number range. |
| `allergens` | string[] | FSSAI allergen names matched in this item or its sub-ingredients. |
| `cross_contamination` | string \| null | `may contain`-style note attached to this item. |
| `sub_ingredients` | array | Nested items from parentheses. |

`nutrition`:

| Field | Type | Notes |
|-------|------|-------|
| `detected` | boolean | True when at least one nutrient parsed. |
| `raw_section` | string | The section as OCR produced it. |
| `basis` | string \| null | e.g. `per 100 ml`. |
| `serving_size` | string \| null | e.g. `250 ml`. |
| `values` | array | One entry per readable nutrient, deduplicated by canonical key. |
| `undeciphered_lines` | string[] | **Lines this parser could not read, verbatim.** Never silently dropped. |
| `confidence` | number \| null | Derived. |
| `confidence_source` | string | `derived` or `unknown`. |
| `confidence_breakdown` | object | `{ basis, value_count, energy_present, ocr }`. |

Each value (`src/text/nutrition.ts:17-33`):

| Field | Type | Notes |
|-------|------|-------|
| `nutrient` | string | Canonical key, e.g. `total_fat`. |
| `label` | string | Display label as OCR produced it. |
| `raw` | string | The whole line, verbatim. |
| `value` | number \| null | `null` when the label printed `trace`/`nil`/etc. |
| `unit` | string \| null | `g`, `mg`, `µg`, `mcg`, `kcal`, `kJ`, `%`, `IU`, or `null` when no unit was printed or the printed unit was not recognised. |
| `normalized_value` | number \| null | Converted to `normalized_unit`. **`null` when `unit` is `null`** — the service does not assume a unit the label did not print. |
| `normalized_unit` | string \| null | The canonical unit for this nutrient. |
| `daily_value_percent` | number \| null | `% RDA` when printed. |
| `trace` | boolean | True when the label showed a qualitative value instead of a number. |

`undeciphered_lines` collects a line only when its *label* cannot be mapped to a known
nutrient, or when it carries neither a number nor a trace marker
(`src/text/nutrition.ts:305-332`). A line whose number parses but whose unit is
garbage lands in `values` with `unit: null` — see the worked example below.

`allergens`:

| Field | Type | Notes |
|-------|------|-------|
| `from_ingredients` | string[] | Allergens implied by matching inside the ingredient list. |
| `declared` | string[] | Allergens named in an explicit `Allergens:` / `Contains:` section. |
| `cross_contamination` | string[] | Verbatim `may contain` / `processed in a facility` statements. |
| `declared_in_section` | boolean | True when a dedicated allergen heading was located. |

`signals`:

| Field | Type | Notes |
|-------|------|-------|
| `ingredient_list_found` | boolean | |
| `barcode_found` | boolean | |
| `nutrition_panel_found` | boolean | |
| `image_quality` | string | `good` (score ≥ 0.75), `fair` (≥ 0.45), `poor` (below). |
| `image_quality_score` | number | `0..1` heuristic. |
| `ins_codes` | string[] | Sorted, deduplicated additive codes found in the OCR text. |
| `indian_label_signals` | string[] | Any of `fssai_license`, `veg_marker`, `mrp`, `net_quantity`, `country_of_origin`, `claims`. |

`diagnostics`:

| Field | Type | Notes |
|-------|------|-------|
| `processing_time_ms` | number | HTTP-measured ms for the whole request, measured in the route handler. Overwrites the orchestrator's own total. |
| `barcode_engines_attempted` | string[] | Same as `barcode.engines_attempted`. |
| `preprocessing_variants_used` | string[] | Same as `barcode.preprocessing_variants_used`. |
| `timings_ms` | object | `download_ms`, `decode_ms`, `barcode_ms`, `ocr_ms`, `text_ms`, `total_ms`. On a cache hit, `cache_lookup_ms` is added and the stage figures are those of the original computation. |
| `plan` | string | The effective plan. |
| `cache_hit` | boolean | |
| `quality` | object | `{ brightness, sharpness, overexposure, reasons }`. |
| `engines` | array | `{ engine, status, variants_tried, detections, total_ms, error }`. |
| `ocr_attempts` | array | Same shape as `ocr.variants_attempted`. |

### Worked example — minimal

A synthetic 286×126 EAN-13 PNG containing only `8901262260121`, captured from a real
run of this build. Reproduced in full:

```json
{
  "success": true,
  "request_id": "0f5a2c1e-8b3d-4a71-9c6e-1d2f3a4b5c6d",
  "schema_version": "1",
  "image": {
    "width": 286,
    "height": 126,
    "format": "png",
    "source_width": 286,
    "source_height": 126,
    "orientation_applied": false,
    "downscaled": false,
    "megapixels": 0.036,
    "source": "https://cdn.example.com/f/barcode-ean13.png"
  },
  "barcode": {
    "detected": true,
    "primary": {
      "value": "8901262260121",
      "format": "EAN-13",
      "confidence": 0.733,
      "confidence_source": "derived"
    },
    "results": [
      {
        "value": "8901262260121",
        "format": "EAN-13",
        "confidence": 0.733,
        "confidence_source": "derived",
        "confidence_breakdown": {
          "agreement": 0.8,
          "consistency": 0.333,
          "structural": 1,
          "format_prior": 1,
          "engine": 0
        },
        "engines": ["ZBar", "ZXing-C++"],
        "agreement": 2,
        "observations": 2,
        "variants": ["original"],
        "engine_confidence": [
          { "engine": "ZBar", "confidence": null },
          { "engine": "ZXing-C++", "confidence": null }
        ],
        "is_retail_gtin": true,
        "is_indian_gs1": true,
        "is_url_payload": false,
        "bounding_box": { "x": 0, "y": 0, "width": 284, "height": 102 },
        "fastest_ms": 6,
        "formats_reported": ["EAN-13"]
      }
    ],
    "engines_attempted": ["ZXing-C++", "ZBar"],
    "engines_unavailable": [
      {
        "engine": "Quagga2",
        "reason": "Runs under Node but its 1D decode stage requires browser worker/canvas facilities; localisation succeeds while codeResult stays empty. Enable VISION_ENABLE_QUAGGA2=true only together with a canvas shim."
      }
    ],
    "preprocessing_variants_used": ["original"],
    "stop_reason": "multi_engine_agreement",
    "ms": 16
  },
  "ocr": {
    "detected": true,
    "confidence": 90,
    "confidence_source": "engine",
    "engine": "tesseract",
    "raw_text": "890126\n\n2\n\n60\n\n0)\n\n2\n\n1",
    "normalized_text": "890126\n\n2\n\n60\n\n0)\n\n2\n\n1",
    "corrections": [],
    "normalization_confidence": 1,
    "regions": [],
    "variants_attempted": [
      { "variant": "gray_upscale2x", "preprocess": "gray_upscale2x", "psm": 3, "confidence": 69, "chars": 15, "ms": 103, "selected": true },
      { "variant": "gray_upscale2x", "preprocess": "gray_upscale2x", "psm": 6, "confidence": 74, "chars": 6, "ms": 53, "selected": true },
      { "variant": "gray", "preprocess": "grayscale", "psm": 3, "confidence": 90, "chars": 23, "ms": 90, "selected": true }
    ],
    "best_variant": "gray",
    "ms": 275,
    "failure_reason": null
  },
  "product": {
    "name": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "brand": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "variant_or_flavour": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "net_quantity": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "mrp": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "fssai_license": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "veg_marker": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "manufacturer": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "best_before": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "country_of_origin": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null }
  },
  "ingredients": {
    "detected": false,
    "confidence": null,
    "confidence_source": "unknown",
    "confidence_breakdown": { "heading": 0, "item_count": 0, "code_coverage": 0, "ocr": 0 },
    "raw_section": "",
    "items": [],
    "heading": null
  },
  "nutrition": {
    "detected": false,
    "raw_section": "",
    "basis": null,
    "serving_size": null,
    "values": [],
    "undeciphered_lines": [],
    "confidence": null,
    "confidence_source": "unknown",
    "confidence_breakdown": { "basis": 0.5, "value_count": 0, "energy_present": 0.4, "ocr": 0.5 }
  },
  "allergens": {
    "from_ingredients": [],
    "declared": [],
    "cross_contamination": [],
    "declared_in_section": false
  },
  "signals": {
    "ingredient_list_found": false,
    "barcode_found": true,
    "nutrition_panel_found": false,
    "image_quality": "good",
    "image_quality_score": 0.8,
    "ins_codes": [],
    "indian_label_signals": []
  },
  "diagnostics": {
    "processing_time_ms": 325,
    "barcode_engines_attempted": ["ZXing-C++", "ZBar"],
    "preprocessing_variants_used": ["original"],
    "timings_ms": {
      "download_ms": 7,
      "decode_ms": 7,
      "barcode_ms": 16,
      "ocr_ms": 275,
      "text_ms": 1,
      "total_ms": 325
    },
    "plan": "standard",
    "cache_hit": false,
    "quality": { "brightness": 141.67, "sharpness": 102.57, "overexposure": 0.5422, "reasons": ["glare"] },
    "engines": [
      { "engine": "ZXing-C++", "status": "available", "variants_tried": 1, "detections": 1, "total_ms": 9, "error": null },
      { "engine": "ZBar", "status": "available", "variants_tried": 1, "detections": 1, "total_ms": 6, "error": null },
      { "engine": "ZXing-TS", "status": "available", "variants_tried": 0, "detections": 0, "total_ms": 0, "error": null }
    ],
    "ocr_attempts": [
      { "variant": "gray_upscale2x", "preprocess": "gray_upscale2x", "psm": 3, "confidence": 69, "chars": 15, "ms": 103, "selected": true },
      { "variant": "gray_upscale2x", "preprocess": "gray_upscale2x", "psm": 6, "confidence": 74, "chars": 6, "ms": 53, "selected": true },
      { "variant": "gray", "preprocess": "grayscale", "psm": 3, "confidence": 90, "chars": 23, "ms": 90, "selected": true }
    ]
  },
  "warnings": ["ingredient_list_not_found"]
}
```

Notes on this response, all observable in the capture:

- The barcode was read by `ZXing-C++` and `ZBar` on the first variant, giving
  `agreement: 2` on a retail GTIN, which tripped the `multi_engine_agreement` stop.
  `ZXing-TS` was in the plan but never ran, hence `variants_tried: 0`.
- `confidence` is `0.733` and is fully reconstructible from the breakdown:
  `0.8×0.35 + 0.333×0.25 + 1×0.25 + 1×0.12 + 0×0.03 = 0.733`. Two engines, two
  observations, valid GTIN check digit, `EAN-13` prior.
- `ocr.detected` is `true` but `raw_text` is barcode digit noise. `detected` means
  "Tesseract returned non-empty text", nothing more.
- `ocr.variants_attempted` has three `selected: true` entries. `best_variant` is
  `gray`, the last one.
- Every `product` field is `null` with `confidence_source: "unknown"`. Nothing was
  invented, and `ingredients.detected` is `false` with the warning
  `ingredient_list_not_found`.

### Worked example — Indian retail label

`tests/fixtures/label-indian.png`, a synthetic 1800×2500 Amul-style label with an
EAN-13, an ingredients block, a nutrition panel and an FSSAI/MRP block. Captured
from a real run; the large text blocks are elided for length and shown in full
elsewhere in the docs.

```json
{
  "success": true,
  "request_id": "1c9d4e77-2a55-4f18-8e30-6b7c1d9f4a22",
  "schema_version": "1",
  "image": {
    "width": 1584,
    "height": 2200,
    "format": "png",
    "source_width": 1800,
    "source_height": 2500,
    "orientation_applied": false,
    "downscaled": true,
    "megapixels": 3.485,
    "source": "https://cdn.example.com/f/label-indian.png"
  },
  "barcode": {
    "detected": true,
    "primary": {
      "value": "8901262260121",
      "format": "EAN-13",
      "confidence": 0.733,
      "confidence_source": "derived"
    },
    "results": [
      {
        "value": "8901262260121",
        "format": "EAN-13",
        "confidence": 0.733,
        "confidence_source": "derived",
        "confidence_breakdown": {
          "agreement": 0.8,
          "consistency": 0.333,
          "structural": 1,
          "format_prior": 1,
          "engine": 0
        },
        "engines": ["ZBar", "ZXing-C++"],
        "agreement": 2,
        "observations": 2,
        "variants": ["original"],
        "engine_confidence": [
          { "engine": "ZBar", "confidence": null },
          { "engine": "ZXing-C++", "confidence": null }
        ],
        "is_retail_gtin": true,
        "is_indian_gs1": true,
        "is_url_payload": false,
        "bounding_box": { "x": 666, "y": 2051, "width": 250, "height": 73 },
        "fastest_ms": 522,
        "formats_reported": ["EAN-13"]
      }
    ],
    "engines_attempted": ["ZXing-C++", "ZBar"],
    "engines_unavailable": [
      {
        "engine": "Quagga2",
        "reason": "Runs under Node but its 1D decode stage requires browser worker/canvas facilities; localisation succeeds while codeResult stays empty. Enable VISION_ENABLE_QUAGGA2=true only together with a canvas shim."
      }
    ],
    "preprocessing_variants_used": ["original"],
    "stop_reason": "multi_engine_agreement",
    "ms": 1433
  },
  "ocr": {
    "detected": true,
    "confidence": 92,
    "confidence_source": "engine",
    "engine": "tesseract",
    "raw_text": "Amul Taaza\nToned Fresh Milk\n\nVEG\n\nIngredients:\n\n...",
    "normalized_text": "Amul Taaza\nToned Fresh Milk\n\nVEG\n\nIngredients:\n\n...",
    "corrections": [],
    "normalization_confidence": 1,
    "regions": [
      { "kind": "ingredients", "text": "Milk, Sugar, INS 621 (Monosodium Glutamate), ...", "bbox": { "x": 220, "y": 870, "width": 708, "height": 104 } },
      { "kind": "nutrition", "text": "Nutrition Information ()\nProtein ...", "bbox": { "x": 220, "y": 1680, "width": 2030, "height": 102 } },
      { "kind": "contains", "text": "May Soy, Nuts." },
      { "kind": "manufacturer", "text": ": Amul Dairy, Anand, Gujarat\n...", "bbox": { "x": 216, "y": 3330, "width": 2242, "height": 508 } },
      { "kind": "mrp", "text": "Rs. 34.00 (Incl. of all taxes)" },
      { "kind": "net_quantity", "text": ": 500 ml" },
      { "kind": "fssai", "text": "FSSAI . 10012051000123\n..." },
      { "kind": "best_before", "text": ": 6 months from manufacturing\n..." }
    ],
    "variants_attempted": [
      { "variant": "gray_upscale2x", "preprocess": "gray_upscale2x", "psm": 3, "confidence": 92, "chars": 857, "ms": 6340, "selected": true }
    ],
    "best_variant": "gray_upscale2x",
    "ms": 7072,
    "failure_reason": null
  },
  "product": {
    "name": { "value": "Amul Taaza", "confidence": 0.45, "confidence_source": "derived", "evidence": "Amul Taaza" },
    "brand": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "variant_or_flavour": { "value": null, "confidence": null, "confidence_source": "unknown", "evidence": null },
    "net_quantity": { "value": "500 ml", "confidence": 0.85, "confidence_source": "derived", "evidence": "Net Qty: 500 ml" },
    "mrp": { "value": { "amount": 34, "currency": "INR" }, "confidence": 0.9, "confidence_source": "derived", "evidence": "Rs. 34.00" },
    "fssai_license": { "value": "10012051000123", "confidence": 0.92, "confidence_source": "derived", "evidence": "FSSAI . 10012051000123" },
    "veg_marker": { "value": "vegetarian", "confidence": 0.8, "confidence_source": "derived", "evidence": "veg" },
    "manufacturer": { "value": "Amul Dairy, Anand, Gujarat", "confidence": 0.6, "confidence_source": "derived", "evidence": "Amul Dairy, Anand, Gujarat" },
    "best_before": { "value": "6 months from manufacturing", "confidence": 0.6, "confidence_source": "derived", "evidence": "6 months from manufacturing" },
    "country_of_origin": { "value": "India", "confidence": 0.8, "confidence_source": "derived", "evidence": "Made in India" }
  },
  "ingredients": {
    "detected": true,
    "confidence": 0.88,
    "confidence_source": "derived",
    "confidence_breakdown": { "heading": 1, "item_count": 1, "code_coverage": 0.333, "ocr": 0.919 },
    "raw_section": "Ingredients:\n\nMilk, Sugar, INS 621 (Monosodium Glutamate),\nRefined Palm Oil, Milk Solids, INS 322,\n\nINS 330, INS 471, Citric Acid, Vitamins A, D, B12.\nMay contain: Soy, Nuts.",
    "items": [
      { "raw": "Ingredients:", "normalized": "ingredients:", "code": null, "ins_reference_name": null, "additive_class": null, "allergens": [], "cross_contamination": null, "sub_ingredients": [] },
      { "raw": "Milk", "normalized": "milk", "code": null, "ins_reference_name": null, "additive_class": null, "allergens": ["milk"], "cross_contamination": null, "sub_ingredients": [] },
      { "raw": "INS 621 (Monosodium Glutamate)", "normalized": "ins 621 (monosodium glutamate)", "code": "INS 621", "ins_reference_name": "monosodium glutamate", "additive_class": "flavour enhancer", "allergens": [], "cross_contamination": null, "sub_ingredients": [ "…" ] }
    ],
    "heading": "Ingredients:"
  },
  "nutrition": {
    "detected": true,
    "raw_section": "Nutrition Information (per 100 ml)\n\nProtein                                         2.09\nTotal Fat                                      1.5¢\nTotal Carbohydrate                            14.0 g\nof which Sugars                                 9.59\nSodium                                       95 mg\nCalcium                                        110 mg\nVitamin A                                      50 ug",
    "basis": "per 100 ml",
    "serving_size": null,
    "values": [
      { "nutrient": "protein", "label": "Protein", "raw": "Protein                                         2.09", "value": 2.09, "unit": null, "normalized_value": null, "normalized_unit": "g", "daily_value_percent": null, "trace": false },
      { "nutrient": "total_fat", "label": "Total Fat", "raw": "Total Fat                                      1.5¢", "value": 1.5, "unit": null, "normalized_value": null, "normalized_unit": "g", "daily_value_percent": null, "trace": false },
      { "nutrient": "total_carbohydrate", "label": "Total Carbohydrate", "raw": "Total Carbohydrate                            14.0 g", "value": 14, "unit": "g", "normalized_value": 14, "normalized_unit": "g", "daily_value_percent": null, "trace": false },
      { "nutrient": "sodium", "label": "Sodium", "raw": "Sodium                                       95 mg", "value": 95, "unit": "mg", "normalized_value": 95, "normalized_unit": "mg", "daily_value_percent": null, "trace": false }
    ],
    "undeciphered_lines": [],
    "confidence": 0.818,
    "confidence_source": "derived",
    "confidence_breakdown": { "basis": 1, "value_count": 0.875, "energy_present": 0.4, "ocr": 0.919 }
  },
  "allergens": {
    "from_ingredients": ["milk", "nuts", "soy"],
    "declared": ["soy", "nuts"],
    "cross_contamination": [".\nMay contain: Soy, Nuts."],
    "declared_in_section": false
  },
  "signals": {
    "ingredient_list_found": true,
    "barcode_found": true,
    "nutrition_panel_found": true,
    "image_quality": "fair",
    "image_quality_score": 0.48,
    "ins_codes": ["INS 322", "INS 330", "INS 471", "INS 621"],
    "indian_label_signals": ["fssai_license", "veg_marker", "mrp", "net_quantity", "country_of_origin"]
  },
  "diagnostics": {
    "processing_time_ms": 8937,
    "barcode_engines_attempted": ["ZXing-C++", "ZBar"],
    "preprocessing_variants_used": ["original"],
    "timings_ms": {
      "download_ms": 38,
      "decode_ms": 237,
      "barcode_ms": 1433,
      "ocr_ms": 7072,
      "text_ms": 35,
      "total_ms": 8937
    },
    "plan": "standard",
    "cache_hit": false,
    "quality": { "brightness": 242.4, "sharpness": 8.94, "overexposure": 0.9295, "reasons": ["very_bright", "soft_focus", "glare"] },
    "engines": [
      { "engine": "ZXing-C++", "status": "available", "variants_tried": 1, "detections": 1, "total_ms": 597, "error": null },
      { "engine": "ZBar", "status": "available", "variants_tried": 1, "detections": 1, "total_ms": 523, "error": null },
      { "engine": "ZXing-TS", "status": "available", "variants_tried": 0, "detections": 0, "total_ms": 0, "error": null }
    ],
    "ocr_attempts": [
      { "variant": "gray_upscale2x", "preprocess": "gray_upscale2x", "psm": 3, "confidence": 92, "chars": 857, "ms": 6340, "selected": true }
    ]
  },
  "warnings": ["image_downscaled_for_processing"]
}
```

Notes on this response:

- `items[0].raw` is the literal string `"Ingredients:"`. The section body
  `raw_section` begins with the heading line, so the splitter emitted it as an item.
  Filter on `heading`-adjacent noise or on `normalized` if that matters to you. This
  is the observed behaviour of `parseIngredientSection` on this fixture, not a
  documented guarantee.
- `Total Fat` was OCR'd as `1.5¢`. The number parsed, the unit did not, so the value
  is reported as `1.5` with `unit: null` and `normalized_value: null`. The service
  declines to assume the missing `g`. The line does **not** appear in
  `undeciphered_lines`, because its label was recognised and it carried a number.
- `allergens.cross_contamination` retains a leading `".\n"` from the raw statement.
  Statements are verbatim OCR text, not cleaned strings.
- `regions` text comes from the *raw* lines while `nutrition.raw_section` comes from
  the normalised ones, which is why `regions[nutrition].text` shows `()` where
  `raw_section` shows `(per 100 ml)`.
- `energy_present` is `0.4` because the panel lists no energy line, so the nutrition
  confidence of `0.818` is capped by that term.
- OCR accounted for 7072 ms of the 8937 ms total. The single `gray_upscale2x` PSM 3
  pass was enough to find the ingredients heading and more than 120 characters, so
  the pipeline exited after one pass.
- `ocr.confidence` of 92 and `ocr.confidence_source: "engine"` are Tesseract's own
  numbers. Contrast with the barcode block, where `confidence_source` is `derived`
  because no engine exposes a score.

### The confidence model

Reproduced from `src/barcode/fusion.ts` so a caller can recompute any number.

**Weights** (`src/barcode/fusion.ts:113-119`), summing to 1:

| Term | Weight |
|------|--------|
| `agreement` | 0.35 |
| `consistency` | 0.25 |
| `structural` | 0.25 |
| `format_prior` | 0.12 |
| `engine` | 0.03 |

**Terms:**

| Term | Definition |
|------|------------|
| `agreement` | Distinct engines that produced this exact payload. 1 engine → `0.45`, 2 → `0.8`, 3+ → `1.0`. Never 0 for a real detection. |
| `consistency` | Independent `(engine, variant)` observations. ≤ 1 → `0`; ≥ 8 → `1`; otherwise `log2(n) / 3`. Log-shaped because the jump from one observation to two is the meaningful one. |
| `structural` | For GTIN formats: `1` if the GS1 mod-10 check digit validates, else `0.05`. For other formats: `0.8` if valid, else `0.2`. |
| `format_prior` | Static relevance to retail packaged food (see table below). |
| `engine` | Engine-reported score. Always `0` in this build — no wired engine exposes one. |

**Format priors** (`src/barcode/fusion.ts:69-84`):

| Format | Prior | | Format | Prior |
|--------|-------|-|--------|-------|
| `EAN-13` | 1.0 | | `Codabar` | 0.25 |
| `EAN-8` | 0.9 | | `QR Code` | 0.5 |
| `UPC-A` | 0.85 | | `Data Matrix` | 0.35 |
| `UPC-E` | 0.7 | | `PDF417` | 0.35 |
| `Code 128` | 0.8 | | `Aztec` | 0.3 |
| `Code 39` | 0.55 | | `UNKNOWN` | 0.1 |
| `Code 93` | 0.45 | | | |
| `ITF` | 0.35 | | | |

`confidence = 0.35·agreement + 0.25·consistency + 0.25·structural + 0.12·format_prior + 0.03·engine`,
clamped to `[0, 1]` and rounded to 3 decimals.

**Ranking** (`src/barcode/fusion.ts:135-140`):

```
rank = (is_retail_gtin ? 10 : 0) + confidence + min(observations, 12) / 100 - (is_url_payload ? 0.4 : 0)
```

**Filtering** (`src/barcode/fusion.ts:206-217`): candidates are ranked, then if the
leader has a non-null confidence everything at or above `leader × 0.6` is kept and
truncated to `maxResults` (5). `BARCODE_MIN_CONFIDENCE` is only consulted when the
leader has no confidence at all. So in the normal case a weak-but-not-weakest
candidate is returned, and the configured minimum is not a hard filter.

**Primary selection** (`src/barcode/fusion.ts:224-233`): the first retail GTIN that is
not a URL payload; otherwise the first `Code 128`; otherwise the first non-2D format;
otherwise the top-ranked candidate.

**Early exit** (`src/barcode/pipeline.ts:152-164`): the sweep stops when the
interim leader reaches `confidence >= 0.85` (`stop_reason:
confidence_target_reached`) or when at least 2 engines agree on a retail GTIN
(`stop_reason: multi_engine_agreement`).

Ingredient and nutrition confidences use their own derived formulas — see
`src/text/ingredients.ts:295-327` (weights `heading 0.35`, `item_count 0.25`,
`code_coverage 0.15`, `ocr 0.25`) and `src/text/nutrition.ts:361-370` (weights
`basis 0.2`, `value_count 0.3`, `energy_present 0.2`, `ocr 0.3`). Product fields use
fixed per-field constants chosen by how explicit the printed label was
(`src/text/product.ts:71-77`).

### Warnings

`warnings` is an array of stable machine-readable strings. All observed values, from
`src/analyze/orchestrator.ts`:

| Warning | Meaning |
|---------|---------|
| `ocr_disabled_by_configuration` | `options.ocr` was true but `OCR_ENABLED=false`. |
| `image_downscaled_for_processing` | Source exceeded the working resolution (`WORKING_MAX_DIMENSION`, default 2200 px). |
| `exif_orientation_applied` | EXIF orientation was not 1 and was applied. |
| `low_image_quality` | `signals.image_quality` is `poor`. |
| `barcode_stage_failed` | The barcode stage threw or overran; `barcode.detected` is `false`. |
| `barcode_not_detected` | The barcode stage ran and found nothing. |
| `ocr_skipped_request_budget_exhausted` | Less than 1000 ms of the effective budget was left after the barcode and download stages, so OCR was not attempted. `ocr.detected` is `false`. |
| `ocr_raster_cap_failed` | The raster could not be capped to `OCR_MAX_DIMENSION`; OCR ran on the full working raster anyway. Logged at `warn`, not surfaced as an error. |
| `ocr_stage_failed` | The OCR stage threw or overran; `ocr.detected` is `false`. |
| `ingredient_list_not_found` | No ingredient section was located or it yielded no items. |
| `nutrition_section_found_but_unreadable` | A nutrition heading was located but no nutrient parsed. |

A `warnings` entry is not an error. The request succeeded with `success: true` and
HTTP 200.

### Cache semantics

The cache is in-process, content-addressed and never touches disk
(`src/analyze/cache.ts`).

- **Key** = SHA-256 of the downloaded image bytes, then `'|'`, then a JSON
  fingerprint of the options that change the result: `plan`, `ocr`, `max_variants`,
  `normalize_text`, and `schema_version` (`src/analyze/orchestrator.ts:73-81`).
  `timeout_ms` is deliberately not in the key.
- **The download always happens first.** A cache hit does not avoid the HTTP fetch of
  the source image, only the decode, barcode, OCR and text work.
- **Bounds**: LRU capped at `CACHE_MAX_ENTRIES` (128), TTL `CACHE_TTL_SECONDS` (900).
  Eviction and expiry are both silent — a miss is always safe.
- **`diagnostics.cache_hit` is the signal.** On a hit, `request_id` is replaced with
  the current one, `cache_lookup_ms` is added to `timings_ms`, and the stage timings
  are the ones recorded on the *original* computation. Do not read `decode_ms` or
  `barcode_ms` from a cache-hit response as a measurement of this request.
- Set `CACHE_ENABLED=false` to disable entirely.

## Errors

### Envelope

All failures except 404 and 429 use this shape (`src/server.ts:149-183`):

```json
{
  "success": false,
  "request_id": "1c9d4e77-2a55-4f18-8e30-6b7c1d9f4a22",
  "error": {
    "code": "BLOCKED_URL",
    "message": "image_url host is not permitted."
  },
  "meta": {
    "failure_stage": "download"
  }
}
```

| Field | Notes |
|-------|-------|
| `error.code` | Stable, machine-readable. See the table below. |
| `error.message` | Safe for a public caller. No stack, no internal URLs, no host details. |
| `error.retry_after_seconds` | Present when meaningful. Also sent as a `retry-after` header. |
| `error.fields` | Present for validation errors: caller-safe pointers such as `"image_url: Required"`. |
| `meta.failure_stage` | Which pipeline stage failed: `received`, `download`, `decode`, `barcode`, `ocr`, `text`, `respond`, or `unknown`. |

Messages never include the offending host, the resolved IP, or the upstream URL.
The `details` object exists internally and is logged, not returned
(`src/core/errors.ts:49-62`).

### Error codes

From `src/core/errors.ts:9-47`.

| Code | HTTP | Raised when |
|------|------|-------------|
| `VALIDATION_ERROR` | 400 | Body failed schema validation, body was empty, not JSON, wrong content type, or over `BODY_LIMIT_BYTES`. |
| `INVALID_URL` | 400 | `image_url` is unparseable, over 2048 chars, empty, has no hostname, contains credentials, or uses a disallowed port. |
| `BLOCKED_URL` | 400 | Host is on the blocklist, resolves to a blocked range, or is not in `ALLOWED_IMAGE_HOSTS`. |
| `UNSUPPORTED_SCHEME` | 400 | Scheme is not `http`/`https`, or it is `http` while `ALLOW_HTTP=false` and the host is not in `HTTP_ALLOWED_HOSTS`. |
| `DOWNLOAD_FAILED` | 502 | DNS failure, non-2xx response, too many redirects, unreadable redirect target, or a truncated stream. |
| `DOWNLOAD_TIMEOUT` | 504 | The download exceeded `DOWNLOAD_TIMEOUT_MS`. |
| `DOWNLOAD_TOO_LARGE` | 413 | `Content-Length` or the streamed byte count exceeded `DOWNLOAD_MAX_BYTES`. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The URL returned a non-image content type, or the request's content type was not JSON. |
| `INVALID_IMAGE` | 400 | The bytes failed the magic-byte sniff, or sharp could not read them. |
| `IMAGE_TOO_LARGE` | 413 | A dimension exceeded `MAX_IMAGE_DIMENSION` or the pixel count exceeded `MAX_IMAGE_PIXELS`. |
| `UNAUTHORIZED` | 401 | Missing or unknown API key when `API_KEYS` is set. |
| `RATE_LIMITED` | 429 | Rate limit exceeded. See the 429 body above. |
| `NOT_FOUND` | 404 | Unknown endpoint. |
| `ANALYSIS_FAILED` | 500 | A stage exceeded a hard deadline. Always accompanied by a warning in a 200 response where the stage was optional. |
| `INTERNAL_ERROR` | 500 | Anything unclassified. |
| `SERVICE_UNAVAILABLE` | 503 | Declared by the taxonomy; no code path in this build raises it. |

Note that 404 and 429 do not match their canonical status for every `code`: a 404 from
an unknown route and a 404 from disabled metrics both use `NOT_FOUND`.

### Envelope variations

Three responses do not use the full envelope:

| Response | Shape |
|----------|-------|
| 404 unknown route | `{ success: false, request_id, error: { code: "NOT_FOUND", message } }` — no `meta`. |
| 429 rate limited | `{ success: false, error: { code: "RATE_LIMITED", message, retry_after_seconds } }` — no `request_id`, no `meta`. |
| 404 metrics disabled | `{ error: { code: "NOT_FOUND", message: "Metrics are disabled." } }` — no `success`, no `request_id`. |

Write clients defensively: treat `request_id` and `meta` as optional.

**An unknown route returns 401, not 404, when authentication is on.** The auth hook is
registered as a `preHandler` (`src/server.ts:129-134`), which runs before Fastify's
not-found handler, so an unauthenticated request to a path that does not exist is
rejected as unauthorised. Observed:

```console
$ curl -s /nope
{"success":false,"request_id":"98897642-ec72-4dd2-8474-7dfbb68f94e9","error":{"code":"UNAUTHORIZED","message":"A valid API key is required."},"meta":{"failure_stage":"received"}}
```

With a valid key the same path returns the 404 envelope. Do not treat a 401 as proof
that a route exists.

## `GET /`

Public. A route index (`src/server.ts:188-202`).

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

## `GET /health`

Public. Liveness and readiness in one. Does no image work and initialises no engine,
so it stays fast on a cold WASM start (`src/routes/operational.ts:30-51`).

`200` when at least one barcode engine reports `available`; `503` otherwise.

```json
{
  "status": "ok",
  "service": "foodguard-vision-api",
  "version": "1.0.0",
  "schema_version": "1",
  "api_version": "v1",
  "uptime_seconds": 27,
  "auth_enabled": true,
  "engines": {
    "total": 4,
    "available": 3,
    "names": ["ZXing-C++", "ZBar", "ZXing-TS"]
  }
}
```

With no engines available, `status` becomes `"degraded"` and the HTTP status `503`.
The payload carries no secrets and no host detail.

Use this for the platform health check. Note that a `503` here means "no barcode
engine", not "the process is wedged".

## `GET /version`

Public. Service identity, the full engine registry with honest statuses, the
effective (non-secret) configuration, cache statistics and the honesty attestation
(`src/routes/operational.ts:53-96`).

```json
{
  "service": "foodguard-vision-api",
  "version": "1.0.0",
  "build_sha": null,
  "schema_version": "1",
  "api_version": "v1",
  "node": "v24.21.0",
  "runtime": { "environment": "production", "port": 8000, "uptime_seconds": 27 },
  "engines": [
    {
      "name": "ZXing-C++",
      "status": "available",
      "reason": null,
      "formats": ["EAN-8", "EAN-13", "UPC-A", "UPC-E", "Code 39", "Code 93", "Code 128", "ITF", "Codabar", "QR Code", "Data Matrix", "PDF417", "Aztec"],
      "initialised": true,
      "last_error": null
    },
    {
      "name": "Quagga2",
      "status": "platform_unsupported",
      "reason": "Runs under Node but its 1D decode stage requires browser worker/canvas facilities; localisation succeeds while codeResult stays empty. Enable VISION_ENABLE_QUAGGA2=true only together with a canvas shim.",
      "formats": ["EAN-8", "EAN-13", "UPC-A", "UPC-E", "Code 39", "Code 93", "Code 128", "ITF", "Codabar"],
      "initialised": false,
      "last_error": null
    }
  ],
  "effective_config": {
    "auth_enabled": true,
    "api_key_count": 2,
    "allow_http": true,
    "allowed_image_hosts": 0,
    "cors_origins": [],
    "rate_limit_max": 60,
    "rate_limit_window": "1 minute",
    "download_max_bytes": 8388608,
    "download_timeout_ms": 12000,
    "max_image_dimension": 6000,
    "max_image_pixels": 40000000,
    "barcode_max_variants": 6,
    "barcode_max_ms": 9000,
    "barcode_min_confidence": 0.5,
    "ocr_enabled": true,
    "ocr_max_variants": 3,
    "ocr_lang": "eng",
    "ocr_worker_limit": 1,
    "cache_enabled": false,
    "cache_max_entries": 128,
    "cache_ttl_seconds": 900
  },
  "cache": { "hits": 0, "misses": 0, "entries": 0, "evictions": 0 },
  "attestation": {
    "fabricates_results": false,
    "statement": "Detection failures are reported as detected:false / null. Barcode confidences are derived (no engine in this build exposes a per-result score)."
  }
}
```

(Values shown are from a local run with `ALLOW_HTTP=true` and `CACHE_ENABLED=false`;
`allow_http` and `cache_enabled` reflect that. The two engine entries shown are the
first and last of the four — `ZBar` and `ZXing-TS` sit between them and also report
`available`.)

`build_sha` comes from the `buildSha` dependency if supplied, else
`RENDER_GIT_COMMIT`, else `null`.

Engine `status` values (`src/barcode/types.ts:58-67`): `available`, `initializing`,
`running`, `failed`, `license_required`, `browser_unsupported`,
`platform_unsupported`, `deprecated`, `not_implemented`.

`effective_config` reports values and counts only. API keys are never included —
only `api_key_count`.

## `GET /metrics`

Public, unless `EXPOSE_METRICS=false`, in which case `404` with the reduced body
described under [envelope variations](#envelope-variations).

Captured from a real run after the two analyses above (same build, same fixtures,
`CACHE_ENABLED=false`):

```json
{
  "uptime_seconds": 28,
  "counters": {
    "requests_total": 3,
    "requests_failed_total": 0,
    "rate_limited_total": 0,
    "unauthorized_total": 0,
    "download_failed_total": 0,
    "download_blocked_total": 0,
    "invalid_image_total": 0,
    "image_too_large_total": 0,
    "cache_hits_total": 0,
    "cache_misses_total": 2,
    "analysis_barcode_detected_total": 2,
    "analysis_barcode_missed_total": 0,
    "analysis_ocr_detected_total": 2,
    "analysis_ocr_missed_total": 0,
    "analysis_ingredients_found_total": 1,
    "analysis_failures_total": 0
  },
  "histograms": {
    "analysis_total_ms": { "count": 2, "sum": 26593, "min": 770, "max": 25823, "avg": 13296.5, "p50": 25823, "p95": 25823 },
    "http_analyze_ms": { "count": 2, "sum": 26664.633659, "min": 776.2396630000003, "max": 25888.393996, "avg": 13332.3168295, "p50": 25888.393996, "p95": 25888.393996 },
    "barcode_pipeline_ms": { "count": 2, "sum": 4448, "min": 65, "max": 4383, "avg": 2224, "p50": 4383, "p95": 4383 },
    "barcode_decode_zxing_cpp_ms": { "count": 2, "sum": 1968, "min": 32, "max": 1936, "avg": 984, "p50": 1936, "p95": 1936 },
    "barcode_decode_zbar_ms": { "count": 2, "sum": 1459, "min": 28, "max": 1431, "avg": 729.5, "p50": 1431, "p95": 1431 },
    "ocr_pipeline_ms": { "count": 2, "sum": 20620, "min": 635, "max": 19985, "avg": 10310, "p50": 19985, "p95": 19985 },
    "ocr_recognize_ms": { "count": 4, "sum": 18444, "min": 115, "max": 17871, "avg": 4611, "p50": 247, "p95": 17871 }
  },
  "engine": {
    "ZXing-C++": { "attempts": 2, "detections": 2, "total_ms": 1968, "detections_per_attempt": 1, "avg_ms": 984 },
    "ZBar": { "attempts": 2, "detections": 2, "total_ms": 1461, "detections_per_attempt": 1, "avg_ms": 730.5 }
  },
  "preprocess_variants": { "original": 2 },
  "rates": {
    "barcode_detection_rate": 1,
    "ocr_success_rate": 1,
    "ingredient_extraction_rate": 0.5,
    "cache_hit_rate": 0,
    "error_rate": 0
  },
  "cache": { "hits": 0, "misses": 0, "entries": 0, "evictions": 0 }
}
```

Read this snapshot carefully:

- `histograms` contains **only the series that have been observed at least once**.
  `barcode_decode_zxing_ts_ms` is absent here because ZXing-TS never ran. Code that
  reads a fixed key must tolerate absence.
- `cache_misses_total` is `2` while the `cache` object reports `misses: 0`. The
  counter is incremented unconditionally on a miss (`src/analyze/orchestrator.ts:173`)
  even when `CACHE_ENABLED=false`, in which case the lookup is skipped and the cache's
  own counters stay at zero. Trust the `cache` object, not `cache_hit_rate`, when the
  cache is disabled.
- `p50`/`p95` over two samples are just the larger sample. They only become
  meaningful with the 512-sample reservoir partly filled.
- `http_analyze_ms` is measured by Fastify and is consistently a few ms above
  `analysis_total_ms`, which the orchestrator measures internally.

Metrics are process-local and reset on restart or deploy. There is no persistence and
no Prometheus text format — this is a bespoke JSON snapshot
(`src/core/metrics.ts`). See the [metrics reference](#metrics-reference).

## `GET /v1/status`

**Requires an API key** when `API_KEYS` is set. A static document
(`src/server.ts:204-209`); it performs no checks, so it is not a health signal.

```json
{
  "service": "foodguard-vision-api",
  "version": "1.0.0",
  "status": "operational",
  "endpoints": ["/v1/analyze", "/v1/analyze/schema", "/health", "/version", "/metrics"]
}
```

## `GET /v1/analyze/schema`

**Requires an API key** when `API_KEYS` is set. The machine-readable request schema
(`src/routes/analyze.ts:83-103`):

```json
{
  "schema_version": "1",
  "method": "POST",
  "path": "/v1/analyze",
  "content_type": "application/json",
  "body": {
    "image_url": {
      "type": "string",
      "required": true,
      "description": "Publicly reachable https URL of a product image."
    },
    "options": {
      "type": "object",
      "required": false,
      "properties": {
        "plan": { "type": "string", "enum": ["fast", "standard", "deep"], "default": "standard" },
        "ocr": { "type": "boolean", "default": true },
        "max_variants": { "type": "integer", "min": 1, "max": 40 },
        "timeout_ms": { "type": "integer", "min": 1000, "max": 300000 },
        "normalize_text": { "type": "boolean", "default": true },
        "detect_barcode": { "type": "boolean", "default": true }
      }
    }
  }
}
```

It describes the request only. There is no machine-readable response schema at this
endpoint; `SCHEMA_VERSION` in `src/analyze/schema.ts` is the source of truth for that.

The advertised `timeout_ms` maximum of 300000 is the zod ceiling, not what the caller
actually gets: the route clamps the value to `max(BARCODE_MAX_MS, OCR_TIMEOUT_MS)`
before dispatch (`src/routes/analyze.ts:66-70`, `src/server.ts:214`), which is 45000 ms
with defaults. The clamp is reported — in the `x-timeout-clamped-ms` response header,
not in `warnings`. Treat this endpoint as a description of the request shape, not of the
effective limits.

## Metrics reference

**Counters** (`src/core/metrics.ts:72-89`):

| Counter | Incremented when |
|---------|------------------|
| `requests_total` | Every request, in an `onRequest` hook. |
| `requests_failed_total` | Every non-2xx response, including 404s. |
| `rate_limited_total` | A 429 was produced. |
| `unauthorized_total` | A 401 was produced. |
| `download_failed_total` | DNS, transport, status, or stream failure. |
| `download_blocked_total` | The SSRF policy rejected a host. |
| `invalid_image_total` | Magic-byte sniff or decode failure. |
| `image_too_large_total` | Dimension or pixel cap exceeded. |
| `cache_hits_total` / `cache_misses_total` | Analysis cache outcomes. |
| `analysis_barcode_detected_total` / `analysis_barcode_missed_total` | Barcode stage outcome. |
| `analysis_ocr_detected_total` / `analysis_ocr_missed_total` | OCR stage outcome. |
| `analysis_ingredients_found_total` | An ingredient list parsed. |
| `analysis_failures_total` | The barcode stage threw, or the route threw. |

**Histograms**, exposed with a `_ms` suffix. Reservoir-sampled at 512 samples each,
so `p50`/`p95` describe the retained window, not all history
(`src/core/metrics.ts:33-49`).

| Histogram | Observed |
|-----------|----------|
| `analysis_total_ms` | Every analysis that reached the respond stage. |
| `http_analyze_ms` | Every `/v1/analyze` response, measured by Fastify. |
| `barcode_pipeline_ms` | One per barcode stage run. |
| `barcode_decode_zxing_cpp_ms` | Per ZXing-C++ decode call. |
| `barcode_decode_zbar_ms` | Per ZBar decode call. |
| `barcode_decode_zxing_ts_ms` | Per ZXing-TS decode call. |
| `ocr_pipeline_ms` | One per OCR stage run. |
| `ocr_recognize_ms` | Per Tesseract pass. |

`preprocess_variants` counts how many times each barcode preprocessing variant ran.

**Derived rates** (`src/core/metrics.ts:160-173`):

| Rate | Formula |
|------|---------|
| `barcode_detection_rate` | detected / (detected + missed) |
| `ocr_success_rate` | detected / (detected + missed) |
| `ingredient_extraction_rate` | ingredients_found / (ocr_detected + ocr_missed) |
| `cache_hit_rate` | hits / (hits + misses) |
| `error_rate` | requests_failed / requests_total |

A rate with a zero denominator is reported as `0`, not `null`. Read `error_rate` with
care: `requests_failed_total` counts every non-2xx response, so a single unauthorised
probe moves it.

**Engine metrics**: `attempts`, `detections`, `total_ms`, `detections_per_attempt`
and `avg_ms` per engine. `detections_per_attempt` counts decode calls, not results, so
one call returning two symbols counts as one attempt with two detections.