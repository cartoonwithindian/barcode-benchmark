/**
 * Ingredient list parsing and normalisation.
 *
 * Input is the raw OCR text of the ingredient section (plus the normalised
 * variant so INS codes repaired by `text/normalize.ts` are picked up). Output is
 * a flat, ordered list of ingredient items.
 *
 * Honest-extraction rules:
 *  - every item keeps the exact OCR string it came from in `raw`,
 *  - `normalized` is a mechanical lowercasing/trim/punctuation cleanup only —
 *    it never substitutes a synonym or guesses an ingredient,
 *  - `code` / `ins_reference_name` are looked up in the INS reference table; a
 *    code that is not in the table gets `code` set and `ins_reference_name: null`
 *    rather than an invented name,
 *  - an ingredient list that OCR did not produce returns `detected: false` with
 *    `items: []`.
 *
 * Sub-ingredients: `sugar (INS 621), palm oil` and
 * `refined oil (palm oil (INS 524), soybean oil)` both parse; the parent
 * ingredient keeps its own `sub_ingredients` array.
 */
import { findInsCodes, type InsCodeHit } from './normalize.js';

export interface IngredientItem {
  /** Exactly what OCR produced for this item. */
  raw: string;
  /** Mechanical normalisation: lowercased, trimmed, trailing punctuation removed. */
  normalized: string;
  /** Canonical additive code when the item carries one, e.g. `INS 621`. */
  code: string | null;
  /** Reference name for `code` when the knowledge table has one. */
  ins_reference_name: string | null;
  /** Functional class of the additive, e.g. `flavour enhancer`. */
  additive_class: string | null;
  /** Allergens declared by this ingredient (FSSAI's 14 allergens). */
  allergens: string[];
  /** `may contain` / `contains` style allergen cross-contamination note. */
  cross_contamination: string | null;
  /** Nested ingredients from parentheses, e.g. compound ingredients. */
  sub_ingredients: IngredientItem[];
}

export interface IngredientParseResult {
  detected: boolean;
  /** Raw section text, exactly as OCR produced it. */
  rawSection: string;
  items: IngredientItem[];
  /** Allergens found anywhere in the ingredient section. */
  allergens: string[];
  /** `may contain: ...` style statements found in the section. */
  cross_contamination_statements: string[];
  insCodes: InsCodeHit[];
  /** Per-item OCR provenance: the heading that opened the section. */
  heading: string | null;
  /** Lines consumed by the section, for `ocr.regions` reporting. */
  startLine: number;
  endLine: number;
}

/**
 * FSSAI's declared allergen list (the 14 allergens under FSSAI labelling
 * regulations). Matching is substring based against the normalised item, so
 * `skimmed milk powder` also reports `milk`.
 */
const ALLERGEN_TERMS: Array<{ allergen: string; patterns: RegExp[] }> = [
  { allergen: 'milk', patterns: [/\bmilk\b/, /\bdairy\b/, /\bwhey\b/, /\bcasein(?:ate)?\b/, /\blactose\b/, /\bmilk\s+solid/, /\bcaseinate\b/, /\bskimmed\s+milk\b/] },
  { allergen: 'gluten', patterns: [/\bgluten\b/, /\bwheat\b/, /\bmaida\b/, /\bbarley\b/, /\brye\b/, /\bmalt\b/, /\bsevi\b/, /\bbulgur\b/] },
  { allergen: 'soy', patterns: [/\bsoy(?:a)?\b/, /\bsoya\b/, /\bsoybean\b/] },
  { allergen: 'nuts', patterns: [/\b(?:almond|cashew|walnut|pecan|pistachio|hazelnut|brazil\s+nut|macadamia|chestnut)\b/, /\bmixed\s+nuts?\b/, /\bnuts?\b/] },
  { allergen: 'peanuts', patterns: [/\bpeanut\b/, /\bgroundnut\b/, /\bground\s+nut\b/, /\barachis\b/] },
  { allergen: 'egg', patterns: [/\begg\b/, /\balbum(?:en|in)\b/, /\bmayo\b/, /\bmayonnaise\b/, /\bovalbumin\b/, /\begg\s+powder\b/] },
  { allergen: 'fish', patterns: [/\bfish\b/, /\bfish\s+oil\b/, /\banchov(?:y|ies)\b/, /\btuna\b/, /\bsalmon\b/, /\bseal\s+oil\b/, /\bcod\b/, /\bsardine\b/] },
  { allergen: 'crustaceans', patterns: [/\b(?:crustacean|shrimp|prawn|crab|lobster|crayfish)\b/] },
  { allergen: 'sesame', patterns: [/\bsesame\b/, /\btilh\b/, /\bsesamum\b/] },
  { allergen: 'mustard', patterns: [/\bmustard\b/, /\brai\b/, /\bsarson\b/] },
  { allergen: 'celery', patterns: [/\bcelery\b/] },
  { allergen: 'lupin', patterns: [/\blupin\b/] },
  { allergen: 'molluscs', patterns: [/\bmollusc/, /\bsnail\b/, /\bshellfish\b/, /\bclam\b/, /\bmussel\b/, /\bcuttlefish\b/] },
];

/** Functional classes for common INS ranges. Reference data, not inference. */
function additiveClass(code: string): string | null {
  const n = Number(code.replace(/\D/g, ''));
  if (!Number.isFinite(n)) return null;
  if (n >= 100 && n < 200) return 'humectant';
  if (n >= 200 && n < 300) return 'preservative';
  if (n >= 300 && n < 400) return 'antioxidant';
  if (n >= 400 && n < 500) return 'thickener / stabiliser / gelling agent';
  if (n >= 500 && n < 600) return 'acidity regulator / raising agent';
  if (n >= 600 && n < 700) return 'flavour enhancer';
  if (n >= 900 && n < 1000) return 'flavouring / sweetener';
  return null;
}

/**
 * Starts a cross-contamination statement anywhere in the ingredient section.
 * Anchored at a word boundary and required to be preceded by a separator or the
 * start of the text, so `contains` inside an ingredient name is not a hit.
 */
const CROSS_CONTAMINATION_SECTION_RE =
  /(?:\n|[.;:]\s*|\s)(?:may\s+contain|sh\s*contain|traces?\s+of|processed\s+in\s+(?:a|the)\s+facility|manufactured\s+in\s+(?:a|the)\s+facility|allergen\s+declaration)\b\s*[:\-–]?/i;

/** Normalises a single ingredient string: lowercase, strip edge punctuation, collapse spaces. */
export function normalizeIngredient(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[;\s]+$/, '')
    .replace(/^[\s:.\-–—*,]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits one ingredient into nested parts using balanced parentheses.
 * `refined oil (palm oil (INS 524), soybean oil)` -> parent + 2 sub-ingredients,
 * the first sub-ingredient itself carrying one.
 */
function splitParentheses(raw: string): { head: string; parts: string[] } {
  const open = raw.indexOf('(');
  if (open === -1) return { head: raw.trim(), parts: [] };
  const close = findMatchingParen(raw, open);
  if (close === -1) {
    // Unbalanced (common with OCR): treat everything after "(" as one part.
    return { head: raw.slice(0, open).trim(), parts: [raw.slice(open + 1).trim()] };
  }
  const head = raw.slice(0, open).trim();
  const inner = raw.slice(open + 1, close);
  const parts = splitTopLevel(inner);
  return { head: head.length > 0 ? head : raw.trim(), parts };
}

function findMatchingParen(text: string, startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on commas/semicolons that are not inside parentheses. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '\n') {
      // A line break in the middle of an ingredient list usually continues the
      // previous item only when the previous item has no closing context; keep
      // it as a separator and let post-processing drop empties.
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

function detectAllergens(normalized: string): string[] {
  const hits: string[] = [];
  for (const { allergen, patterns } of ALLERGEN_TERMS) {
    if (patterns.some((p) => p.test(normalized))) hits.push(allergen);
  }
  return hits;
}

/**
 * Allergens mentioned in free text (used for the explicit `Allergens:` /
 * `Contains:` declaration, which is separate from what the ingredient list
 * implies). Returns the FSSAI allergen names only — no inference.
 */
export function detectAllergensInText(text: string): string[] {
  return detectAllergens(normalizeIngredient(text));
}

/** The FSSAI allergen vocabulary this module matches against. */
export const KNOWN_ALLERGENS: readonly string[] = ALLERGEN_TERMS.map((t) => t.allergen);

function parseItem(raw: string): IngredientItem {
  const { head, parts } = splitParentheses(raw);
  // `normalized` covers the whole item, sub-ingredients included: for
  // `INS 621 (Monosodium Glutamate)` the parenthetical is part of the same
  // ingredient, and losing it would hide the additive's name.
  const normalizedFull = normalizeIngredient(raw);
  const codes = findInsCodes(raw);
  const code = codes[0]?.code ?? null;
  const reference = codes[0]?.reference_name ?? null;
  const subIngredients = parts.map((p) => parseItem(p));

  return {
    raw,
    normalized: normalizedFull,
    code,
    ins_reference_name: reference,
    additive_class: code ? additiveClass(code) : null,
    allergens: [...new Set([...detectAllergens(normalizeIngredient(head)), ...subIngredients.flatMap((s) => s.allergens)])].sort(),
    cross_contamination: null,
    sub_ingredients: subIngredients,
  };
}

export interface ParseIngredientOptions {
  heading?: string | null;
  startLine?: number;
  endLine?: number;
}

/** Parses a raw ingredient section into structured items. */
export function parseIngredientSection(
  rawSection: string,
  options: ParseIngredientOptions = {},
): IngredientParseResult {
  const text = rawSection.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) {
    return {
      detected: false,
      rawSection: '',
      items: [],
      allergens: [],
      cross_contamination_statements: [],
      insCodes: [],
      heading: options.heading ?? null,
      startLine: options.startLine ?? -1,
      endLine: options.endLine ?? -1,
    };
  }

  const items: IngredientItem[] = [];
  const crossContamination: string[] = [];
  const allAllergens = new Set<string>();
  const allCodes = new Map<string, InsCodeHit>();

  // A `may contain: ...` / `processed in a facility ...` clause runs to the end
  // of the statement, not to the next comma, so it is cut out of the section
  // *before* the list is split into ingredients. Cutting it out afterwards
  // would leave `milk` and `nuts` looking like ingredients in their own right.
  let ingredientText = text;
  const crossStart = CROSS_CONTAMINATION_SECTION_RE.exec(text);
  if (crossStart && crossStart.index > 0) {
    crossContamination.push(text.slice(crossStart.index).trim());
    ingredientText = text.slice(0, crossStart.index);
    for (const a of detectAllergens(normalizeIngredient(text.slice(crossStart.index)))) allAllergens.add(a);
  }

  // `and`-separated trailing clauses are common: "..., and citric acid".
  const normalisedText = ingredientText.replace(/,\s*and\s+/gi, ', ').replace(/\s+and\s+(?=[a-z])/gi, ', ');
  const chunks = splitTopLevel(normalisedText);

  for (const chunk of chunks) {
    const cleaned = chunk.trim();
    if (cleaned.length === 0) continue;
    // Standalone punctuation / stray glyph noise is dropped, not reported.
    if (/^[^\p{L}\p{N}]+$/u.test(cleaned)) continue;

    const item = parseItem(cleaned);
    items.push(item);
    for (const a of item.allergens) allAllergens.add(a);

    for (const code of findInsCodes(cleaned)) allCodes.set(code.code, code);
  }

  return {
    detected: items.length > 0,
    rawSection: text,
    items,
    allergens: [...allAllergens].sort(),
    cross_contamination_statements: crossContamination,
    insCodes: [...allCodes.values()].sort((a, b) => a.start - b.start),
    heading: options.heading ?? null,
    startLine: options.startLine ?? -1,
    endLine: options.endLine ?? -1,
  };
}

/**
 * Confidence for the ingredient list, derived from observable evidence:
 * heading presence, item count plausibility, INS code coverage and mean OCR
 * word confidence. Reported as `derived`, never as an engine score.
 */
export function scoreIngredientConfidence(input: {
  found: boolean;
  items: IngredientItem[];
  headingPresent: boolean;
  meanWordConfidence: number | null;
}): { confidence: number | null; confidence_source: 'derived' | 'unknown'; breakdown: Record<string, number> } {
  if (!input.found || input.items.length === 0) {
    return {
      confidence: null,
      confidence_source: 'unknown',
      breakdown: { heading: 0, item_count: 0, code_coverage: 0, ocr: 0 },
    };
  }
  const heading = input.headingPresent ? 1 : 0.35;
  // 3..40 items is the plausible range for a packaged food label.
  const count = input.items.length;
  const itemCount = count < 2 ? 0.3 : count <= 40 ? 1 : 0.7;
  const withCodes = input.items.filter((i) => i.code !== null).length;
  const codeCoverage = Math.min(1, withCodes / Math.max(3, Math.min(count, 12)));
  const ocr = input.meanWordConfidence === null ? 0.5 : Math.max(0, Math.min(1, input.meanWordConfidence / 100));

  const score = Number((heading * 0.35 + itemCount * 0.25 + codeCoverage * 0.15 + ocr * 0.25).toFixed(3));
  return {
    confidence: score,
    confidence_source: 'derived',
    breakdown: {
      heading: Number(heading.toFixed(3)),
      item_count: Number(itemCount.toFixed(3)),
      code_coverage: Number(codeCoverage.toFixed(3)),
      ocr: Number(ocr.toFixed(3)),
    },
  };
}
