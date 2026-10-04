/**
 * Product-level field extraction from OCR text.
 *
 * Scope rule (from the service brief): this service extracts what is visible on
 * the pack. It does not invent product metadata, does not look anything up, and
 * does not complete partially-read names. Every field therefore carries:
 *   - the exact OCR substring it came from (`evidence`), and
 *   - a `confidence` plus `confidence_source`, which is `derived` for heuristic
 *     readings and `unknown` when nothing plausible was found (`null`).
 *
 * High-confidence fields are those with an explicit printed label
 * (`Net Qty: 500 ml`, `MRP Rs. 34.00`, `FSSAI Lic. No. 10012051000123`).
 * Product name and brand are inherently heuristic on a photo and are reported
 * with deliberately low confidence plus evidence.
 */
import { detectVegMarker, type VegMarker } from './sections.js';
import { normalizeIngredient } from './ingredients.js';

export interface ExtractedField<T> {
  value: T | null;
  confidence: number | null;
  confidence_source: 'derived' | 'unknown';
  /** Exact OCR text the value was read from. */
  evidence: string | null;
}

export interface ProductInfo {
  name: ExtractedField<string>;
  brand: ExtractedField<string>;
  variant_or_flavour: ExtractedField<string>;
  net_quantity: ExtractedField<string>;
  mrp: ExtractedField<{ amount: number; currency: string }>;
  fssai_license: ExtractedField<string>;
  veg_marker: ExtractedField<VegMarker['type']>;
  manufacturer: ExtractedField<string>;
  best_before: ExtractedField<string>;
  country_of_origin: ExtractedField<string>;
  /** The whole raw OCR text of each supporting section, for traceability. */
  evidence_sections: Record<string, string>;
}

const LEGAL_NOISE = [
  /\b(?:fssai|lic\.?\s*no|licence|license|batch|b\/?no|mfg|manufactured|packed|marketed|use\s+by|best\s+before|store|keep|refrigerat|copyright|all\s+rights|www\.|http|email|phone|toll|customer\s+care)\b/i,
  /\b(?:co-?operative|limited|private|pvt\.?|ltd\.?|industries|enterprises|company|agro|industries)\b/i,
  /^\s*[\d\s.,%+/()-]+$/,
  /\b(?:contains|ingredients|nutrition|allergen|coa|product|packed|net|mrp)\b/i,
  /\b\d{6,}\b/,
  /\b(?:anand|india|bengaluru|mumbai|delhi|gujarat|kerala|maharashtra|tamil\s+nadu)\b/i,
];

/**
 * An explicit brand statement. `manufactured by` is deliberately absent: that
 * phrase names the manufacturer, and reporting it as the brand would be wrong.
 */
const BRAND_LABEL_RE = /\b(?:brand|branded\s+by|packed\s+by|marketed\s+by|produced\s+by)\b\s*[:\-–]?\s*([^\n:|\-–]{2,60})/i;
const NET_QTY_RE = /\bnet\s*(?:qty\.?|quantity|weight|wt\.?|content|volume)\b[^0-9]{0,20}(\d+(?:[.,]\d+)?\s*(?:kg|kgs|g\b|gm|gms|ml\b|m\.?l|l\b|ltr|litre|liter|oz|mg|mcg|µg)|[0-9]+\s*(?:x|×)\s*[0-9]+\s*\w+)/i;
const NET_QTY_FALLBACK = /\b(\d+(?:[.,]\d+)?\s*(?:kg|g|gm|gms|ml|ltr|litre|liter|oz))\b/i;
const MRP_RE = /\b(?:m\.?r\.?p\.?|mrp|maximum\s+retail\s+price|price)\b\s*(?:[:\-–]?\s*(?:rs\.?|₹|inr|mrp)\s*[:\-–]?)?([0-9]+(?:[.,][0-9]{1,2})?)/i;
/**
 * Fallback for the section-local read: when `sections.mrp` already located the
 * price line, the "MRP" keyword has been consumed as the heading, so only the
 * currency marker and the amount remain.
 */
const MRP_AMOUNT_RE = /(?:rs\.?|₹|inr)\s*[:\-–]?\s*([0-9]+(?:[.,][0-9]{1,2})?)/i;
const FSSAI_RE = /\b(?:fssai|lic(?:en[cs]e)?\.?\s*no\.?|lic(?:en[cs]e)?\.?\s*number|central\s+lic(?:en[cs]e)\s*no)\b[^\n0-9]{0,20}(\d{14})/i;
const FSSAI_FALLBACK = /\b(\d{14})\b/;
const BEST_BEFORE_RE = /\b(?:best\s+before|use\s+by|best\s+first|expiry|shelf\s*life)\b\s*[:\-–]?\s*([^\n|.]{2,60})/i;
const ORIGIN_RE = /\b(?:made\s+in|produced\s+in|manufactured\s+in|origin|packed\s+in)\b\s*[:\-–]?\s*([a-z ]{3,40})/i;
const FLAVOUR_RE = /\b(?:flavou?r|variant)\b\s*[:\-–]?\s*([^\n|.]{2,40})/i;

const UNKNOWN = <T>(): ExtractedField<T> => ({ value: null, confidence: null, confidence_source: 'unknown', evidence: null });
const derived = <T>(value: T, confidence: number, evidence: string): ExtractedField<T> => ({
  value,
  confidence: Number(confidence.toFixed(3)),
  confidence_source: 'derived',
  evidence,
});

export interface ExtractProductOptions {
  /** Full OCR text (lines joined by \n). */
  text: string;
  /** Sections already located by `text/sections.ts`. */
  sections: Partial<Record<'manufacturer' | 'mrp' | 'net_quantity' | 'fssai' | 'best_before', { rawSection: string }>>;
}

function looksLikeLegalNoise(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 90) return true;
  return LEGAL_NOISE.some((p) => p.test(trimmed));
}

/**
 * Guesses a product name and brand from the lines above the ingredient heading.
 * Only OCR'd text can be used; when nothing plausible exists the fields stay
 * `null` with `confidence_source: "unknown"`.
 */
function guessNameAndBrand(lines: string[]): { name: ExtractedField<string>; brand: ExtractedField<string> } {
  const candidates = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length <= 60 && !looksLikeLegalNoise(l));

  const brandLabel = BRAND_LABEL_RE.exec(lines.join('\n'));
  const brand = brandLabel && brandLabel[1] ? derived(brandLabel[1].trim(), 0.75, brandLabel[0].trim()) : UNKNOWN<string>();

  let name = UNKNOWN<string>();
  for (const candidate of candidates) {
    const normalised = normalizeIngredient(candidate);
    if (/^(?:ingredients?|nutrition|contains|allergen|veg|non-veg|store|mrp|net|fssai)/.test(normalised)) continue;
    if (/\b(?:pvt|ltd|limited|inc|corp|company|industries|co-?operative)\b/.test(normalised)) continue;
    // Product names on Indian packs are usually title case with a few words.
    const words = normalised.split(' ');
    if (words.length < 1 || words.length > 12) continue;
    const hasLetters = /\p{L}/u.test(normalised);
    if (!hasLetters) continue;
    // Lower confidence the further down the list we have to look.
    const positionPenalty = candidates.indexOf(candidate) <= 2 ? 0 : 0.1;
    name = derived(candidate, Math.max(0.2, 0.45 - positionPenalty), candidate);
    break;
  }

  // When an explicit brand label exists and the name guess equals the brand, the
  // guess carries no extra information: drop it rather than report a duplicate.
  if (name.value && brand.value && normalizeIngredient(name.value) === normalizeIngredient(brand.value)) {
    name = UNKNOWN<string>();
  }
  return { name, brand };
}

export function extractProductInfo(options: ExtractProductOptions): ProductInfo {
  const text = options.text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const evidence: Record<string, string> = {};
  for (const [key, section] of Object.entries(options.sections)) {
    if (section?.rawSection) evidence[key] = section.rawSection;
  }

  // ── Net quantity ──────────────────────────────────────────────────────────
  let netQuantity = UNKNOWN<string>();
  const netMatch = NET_QTY_RE.exec(text);
  if (netMatch?.[1]) {
    netQuantity = derived(netMatch[1].replace(/\s+/g, ' ').trim(), 0.85, netMatch[0].trim());
  } else {
    const netSection = options.sections.net_quantity?.rawSection;
    const fallbackSource = netSection ?? text;
    const fallback = NET_QTY_FALLBACK.exec(fallbackSource);
    if (fallback?.[1]) netQuantity = derived(fallback[1].replace(/\s+/g, ' ').trim(), 0.6, fallback[0].trim());
  }

  // ── MRP ──────────────────────────────────────────────────────────────────
  let mrp = UNKNOWN<{ amount: number; currency: string }>();
  const mrpSection = options.sections.mrp?.rawSection;
  const mrpMatch = MRP_RE.exec(mrpSection ?? text) ?? (mrpSection ? MRP_AMOUNT_RE.exec(mrpSection) : null);
  if (mrpMatch?.[1]) {
    const amount = Number(mrpMatch[1].replace(/,/g, ''));
    if (Number.isFinite(amount)) {
      mrp = derived({ amount, currency: 'INR' }, mrpSection ? 0.9 : 0.75, mrpMatch[0].trim());
    }
  }

  // ── FSSAI licence ────────────────────────────────────────────────────────
  let fssai = UNKNOWN<string>();
  const fssaiSection = options.sections.fssai?.rawSection;
  const fssaiMatch = FSSAI_RE.exec(fssaiSection ?? text);
  if (fssaiMatch?.[1]) {
    fssai = derived(fssaiMatch[1], fssaiSection ? 0.92 : 0.7, fssaiMatch[0].trim());
  } else {
    const loose = FSSAI_FALLBACK.exec(fssaiSection ?? '');
    if (loose?.[1]) fssai = derived(loose[1], 0.5, loose[1]);
  }

  // ── Best before / use by ─────────────────────────────────────────────────
  let bestBefore = UNKNOWN<string>();
  const bestBeforeSection = options.sections.best_before?.rawSection;
  const bbMatch = BEST_BEFORE_RE.exec(bestBeforeSection ?? text);
  if (bbMatch?.[1]) {
    bestBefore = derived(bbMatch[1].trim(), bestBeforeSection ? 0.85 : 0.6, bbMatch[0].trim());
  } else if (bestBeforeSection) {
    // The `Best Before:` heading was consumed as the section heading, so the
    // body is the date/interval itself.
    const body = (bestBeforeSection.trim().split('\n')[0] ?? '').replace(/^[:\-–\s]+/, '').trim();
    if (body.length >= 3 && body.length <= 60) bestBefore = derived(body, 0.6, body);
  }

  // ── Origin ───────────────────────────────────────────────────────────────
  let origin = UNKNOWN<string>();
  const originMatch = ORIGIN_RE.exec(text);
  if (originMatch?.[1]) {
    const value = originMatch[1].trim().replace(/\s+/g, ' ');
    // "Made in India" on Indian packs is reliable when the country reads as one.
    const looksCountry = /\b(?:india|bangladesh|pakistan|nepal|sri\s+lanka|united\s+kingdom|uae|united\s+arab\s+emirates|global|london)\b/i.test(value);
    origin = looksCountry ? derived(value, 0.8, originMatch[0].trim()) : derived(value, 0.4, originMatch[0].trim());
  }

  // ── Flavour / variant ────────────────────────────────────────────────────
  let flavour = UNKNOWN<string>();
  const flavourMatch = FLAVOUR_RE.exec(text);
  if (flavourMatch?.[1]) {
    const value = flavourMatch[1].trim();
    if (value.length > 0 && value.length < 60 && !/^[:\-–\s]*$/.test(value)) flavour = derived(value, 0.55, flavourMatch[0].trim());
  }

  // ── Manufacturer ─────────────────────────────────────────────────────────
  let manufacturer = UNKNOWN<string>();
  const manufacturerSection = options.sections.manufacturer?.rawSection;
  const manufacturerMatch = /\b(?:manufactur(?:ed|er)|marketed|packed|processed)\s+by\b\s*[:\-–]?\s*([^\n|]{3,80})/i.exec(
    manufacturerSection ?? text,
  );
  if (manufacturerMatch?.[1]) {
    manufacturer = derived(manufacturerMatch[1].trim(), 0.8, manufacturerMatch[0].trim());
  } else if (manufacturerSection) {
    // `findSection` already matched the `Manufactured by:` line and stripped it
    // as the heading, so the remaining body *is* the manufacturer name.
    const body = (manufacturerSection.trim().split('\n')[0] ?? '').replace(/^[:\-–\s]+/, '').trim();
    const looksLikeCompany = body.length >= 4 && body.length <= 80 && /[\p{L}]/u.test(body);
    if (looksLikeCompany) manufacturer = derived(body, 0.6, body);
  }

  // ── Veg marker ───────────────────────────────────────────────────────────
  const marker = detectVegMarker(text);
  const vegMarker = marker.type === 'unknown'
    ? UNKNOWN<VegMarker['type']>()
    : derived(marker.type, marker.confidence, marker.evidence);

  const { name, brand } = guessNameAndBrand(lines);

  return {
    name,
    brand,
    variant_or_flavour: flavour,
    net_quantity: netQuantity,
    mrp,
    fssai_license: fssai,
    veg_marker: vegMarker,
    manufacturer,
    best_before: bestBefore,
    country_of_origin: origin,
    evidence_sections: evidence,
  };
}
