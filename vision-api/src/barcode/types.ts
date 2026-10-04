/**
 * Barcode domain types.
 *
 * Ported from `barcode-benchmark/src/app/core/barcode/barcode.model.ts` with the
 * additions this service needs (engine provenance, bounding boxes, validation
 * results). The canonical format names are unchanged so results produced by the
 * benchmark UI and by this API line up.
 */

export type BarcodeFormatName =
  | 'EAN-8'
  | 'EAN-13'
  | 'UPC-A'
  | 'UPC-E'
  | 'Code 39'
  | 'Code 93'
  | 'Code 128'
  | 'ITF'
  | 'Codabar'
  | 'QR Code'
  | 'Data Matrix'
  | 'PDF417'
  | 'Aztec'
  | 'UNKNOWN';

export interface BarcodePoint {
  x: number;
  y: number;
}

export interface BarcodeBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarcodeResult {
  /** Decoded payload exactly as produced by the engine. */
  value: string;
  format: BarcodeFormatName;
  /** Corner points when the engine provides them. Never invented. */
  points?: BarcodePoint[];
  boundingBox?: BarcodeBoundingBox;
  /** Time in ms spent inside the decoder for this result. */
  decodeTimeMs: number;
  /** Engine that produced the result. */
  engine: string;
  /** Preprocessing variant the engine was fed. */
  variant: string;
  /**
   * Confidence reported *by the engine*. `null` means the engine does not
   * expose a score — it is never back-filled with a guess.
   */
  engineConfidence: number | null;
}

export type EngineLifecycleStatus =
  | 'available'
  | 'initializing'
  | 'running'
  | 'failed'
  | 'license_required'
  | 'browser_unsupported'
  | 'platform_unsupported'
  | 'deprecated'
  | 'not_implemented';

export const ENGINE_STATUS_LABELS: Record<EngineLifecycleStatus, string> = {
  available: 'Available',
  initializing: 'Initializing',
  running: 'Running',
  failed: 'Failed',
  license_required: 'Requires SDK/license configuration',
  browser_unsupported: 'Not browser compatible',
  platform_unsupported: 'Needs native/mobile environment',
  deprecated: 'Unsupported/deprecated',
  not_implemented: 'Not implemented',
};

/** 2D-only formats, excluded from barcode-only comparisons in the benchmark. */
export const TWO_D_FORMATS: ReadonlySet<BarcodeFormatName> = new Set<BarcodeFormatName>([
  'QR Code',
  'Data Matrix',
  'Aztec',
  'PDF417',
]);

/**
 * Retail formats that carry a GTIN. Indian packaged food is overwhelmingly
 * EAN-13, with EAN-8 / UPC-A appearing on smaller packs.
 */
export const RETAIL_FORMATS: ReadonlySet<BarcodeFormatName> = new Set<BarcodeFormatName>([
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
]);

export const ENGINE_STATUS_DESCRIPTIONS: Record<EngineLifecycleStatus, string> = {
  available: 'Engine initialised and ready.',
  initializing: 'Engine is loading its WASM/native module.',
  running: 'Engine is actively decoding.',
  failed: 'Engine threw during initialisation or decoding.',
  license_required: 'Requires a commercial SDK/license configuration.',
  browser_unsupported: 'Depends on browser-only APIs; not runnable server-side.',
  platform_unsupported: 'Depends on a platform runtime unavailable on this host.',
  deprecated: 'Superseded library; kept only for comparison.',
  not_implemented: 'Known but not implemented in this service.',
};