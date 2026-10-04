/**
 * Barcode value validation and format normalisation.
 *
 * Two jobs:
 *  1. Map engine-specific format strings onto the canonical names used by the
 *     benchmark repo and this API.
 *  2. Validate decoded payloads *structurally* (digit set, length, GTIN check
 *     digit) so the fusion layer can distinguish "structurally valid GTIN" from
 *     "engine said so" — without ever inventing a value.
 */
import type { BarcodeFormatName } from './types.js';

/** ZXing-C++ (`zxing-wasm`) format ids. */
export const ZXING_CPP_FORMAT_MAP: Record<string, BarcodeFormatName> = {
  EAN8: 'EAN-8',
  EAN13: 'EAN-13',
  UPCA: 'UPC-A',
  UPCE: 'UPC-E',
  Code39: 'Code 39',
  Code93: 'Code 93',
  Code128: 'Code 128',
  ITF: 'ITF',
  Codabar: 'Codabar',
  QRCode: 'QR Code',
  DataMatrix: 'Data Matrix',
  PDF417: 'PDF417',
  Aztec: 'Aztec',
  MicroQRCode: 'QR Code',
  rMQRCode: 'QR Code',
  MaxiCode: 'UNKNOWN',
};

/** ZBar (`zbar.wasm`) symbol type names. */
export const ZBAR_FORMAT_MAP: Record<string, BarcodeFormatName> = {
  ZBAR_EAN8: 'EAN-8',
  ZBAR_EAN13: 'EAN-13',
  ZBAR_UPCA: 'UPC-A',
  ZBAR_UPCE: 'UPC-E',
  ZBAR_CODE39: 'Code 39',
  ZBAR_CODE93: 'Code 93',
  ZBAR_CODE128: 'Code 128',
  ZBAR_I25: 'ITF',
  ZBAR_CODABAR: 'Codabar',
  ZBAR_QRCODE: 'QR Code',
  ZBAR_DATAMATRIX: 'Data Matrix',
  ZBAR_PDF417: 'PDF417',
  'EAN-8': 'EAN-8',
  'EAN-13': 'EAN-13',
  'UPC-A': 'UPC-A',
  'UPC-E': 'UPC-E',
  'CODE-39': 'Code 39',
  'CODE-128': 'Code 128',
  I25: 'ITF',
  'QR-Code': 'QR Code',
};

export function normaliseFormat(raw: string | undefined | null): BarcodeFormatName {
  if (!raw) return 'UNKNOWN';
  return ZXING_CPP_FORMAT_MAP[raw] ?? ZBAR_FORMAT_MAP[raw] ?? 'UNKNOWN';
}

/**
 * GTIN check digit (GS1 mod-10).
 *
 * The weights alternate 3,1,3,1… **from the rightmost digit of the body**,
 * which always carries 3. Written as `(body.length - 1 - i) % 2`; getting this
 * inverted silently fails every genuine GTIN while accepting some misreads,
 * which is the worst possible failure direction for a product lookup.
 */
export function isValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const weight = (body.length - 1 - i) % 2 === 0 ? 3 : 1;
    sum += Number(body[i]) * weight;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === check;
}

export type PayloadValidation =
  | { kind: 'gtin'; valid: boolean; gtin: string; family: 'EAN-8' | 'EAN-13' | 'UPC-A' | 'UPC-E' }
  | { kind: 'numeric_code'; valid: boolean; length: number }
  | { kind: 'alphanumeric'; valid: boolean; length: number }
  | { kind: 'binary_or_unknown'; valid: boolean; length: number };

export function validatePayload(value: string, format: BarcodeFormatName): PayloadValidation {
  const length = value.length;
  if (format === 'EAN-13') {
    return { kind: 'gtin', valid: /^\d{13}$/.test(value) && isValidGtinCheckDigit(value), gtin: value, family: 'EAN-13' };
  }
  if (format === 'EAN-8') {
    return { kind: 'gtin', valid: /^\d{8}$/.test(value) && isValidGtinCheckDigit(value), gtin: value, family: 'EAN-8' };
  }
  if (format === 'UPC-A') {
    return { kind: 'gtin', valid: /^\d{12}$/.test(value) && isValidGtinCheckDigit(value), gtin: value, family: 'UPC-A' };
  }
  if (format === 'UPC-E') {
    // UPC-E has no check digit of its own; it expands to a UPC-A with one.
    return { kind: 'gtin', valid: /^0\d{6}$/.test(value), gtin: value, family: 'UPC-E' };
  }
  if (format === 'Code 128' || format === 'Code 39' || format === 'Code 93' || format === 'ITF') {
    return { kind: 'numeric_code', valid: length >= 4 && /^[\x20-\x7e]+$/.test(value), length };
  }
  if (format === 'Codabar') {
    return { kind: 'alphanumeric', valid: length >= 4 && /^[A-Da-d]?[0-9\-$:/.+]+[A-Da-d]?$/.test(value), length };
  }
  return { kind: 'binary_or_unknown', valid: length > 0, length };
}

/**
 * Two engines reporting the same payload for different formats: prefer the
 * format that is structurally consistent with the payload.
 */
export function reconcileFormats(
  entries: Array<{ value: string; format: BarcodeFormatName }>,
): BarcodeFormatName {
  const scores = new Map<BarcodeFormatName, number>();
  for (const entry of entries) {
    if (entry.format === 'UNKNOWN') continue;
    const validation = validatePayload(entry.value, entry.format);
    const weight =
      validation.kind === 'gtin' ? (validation.valid ? 3 : 1) : validation.valid ? 2 : 0.5;
    scores.set(entry.format, (scores.get(entry.format) ?? 0) + weight);
  }
  let best: BarcodeFormatName = 'UNKNOWN';
  let bestScore = -1;
  for (const [format, score] of scores) {
    // Tie-break towards the retail formats that matter for packaged food.
    const priority = score + (format === 'EAN-13' ? 0.1 : format === 'EAN-8' ? 0.05 : 0);
    if (priority > bestScore) {
      bestScore = priority;
      best = format;
    }
  }
  return best;
}

/** True when the value looks like a GTIN that carries the Indian GS1 prefix 890. */
export function isIndianGs1(value: string): boolean {
  return /^890\d{10}$/.test(value);
}

/** Formats a value for a URL/lookup friendly form (QR URLs, Data Matrix payloads). */
export function isProbablyUrl(value: string, format: BarcodeFormatName): boolean {
  return format === 'QR Code' && /^https?:\/\//i.test(value);
}