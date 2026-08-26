/** Canonical barcode format names used across the whole benchmark app. */
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

export interface BarcodeResult {
  /** Decoded text payload. */
  value: string;
  format: BarcodeFormatName;
  /** Bounding box / corner points if the engine provides them. Never invented. */
  points?: BarcodePoint[];
  /** Time in ms spent inside the decoder for this result. */
  decodeTimeMs: number;
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
