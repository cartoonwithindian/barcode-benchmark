/**
 * Nutrition panel parsing.
 *
 * Reads the raw OCR text of the nutrition section and returns one entry per
 * nutrient line that could be read. Units are converted to a canonical unit per
 * nutrient where the conversion is unambiguous (mg<->g, kcal<->kJ) and left as
 * OCR'd otherwise.
 *
 * Nothing is defaulted: a line that cannot be parsed is reported in
 * `undeciphered_lines` instead of being dropped silently or guessed at, and a
 * section with no parseable nutrient returns `detected: false`.
 */
import { normalizeIngredient } from './ingredients.js';

export type NutrientUnit = 'g' | 'mg' | 'µg' | 'mcg' | 'kcal' | 'kJ' | '%' | 'IU' | null;

export interface NutritionValue {
  /** Canonical nutrient key, e.g. `total_fat`. */
  nutrient: string;
  /** Display label as OCR produced it. */
  label: string;
  /** The whole line exactly as OCR produced it. */
  raw: string;
  value: number | null;
  unit: NutrientUnit;
  /** Value converted to the nutrient's canonical unit, when applicable. */
  normalized_value: number | null;
  normalized_unit: NutrientUnit;
  /** % RDA when the label printed one. */
  daily_value_percent: number | null;
  /** True when the label only showed "trace"/"nil" instead of a number. */
  trace: boolean;
}

export interface NutritionParseResult {
  detected: boolean;
  rawSection: string;
  heading: string | null;
  /** e.g. `per 100 ml` when the panel states its basis. */
  basis: string | null;
  servingSize: string | null;
  values: NutritionValue[];
  undecipheredLines: string[];
  confidence: number | null;
  confidence_source: 'derived' | 'unknown';
  confidence_breakdown: Record<string, number>;
}

/** Nutrient label -> canonical key. Covers the FSSAI mandated nutrient list. */
const NUTRIENT_LABELS: Record<string, string> = {
  energy: 'energy',
  'energy from fat': 'energy_from_fat',
  calories: 'energy',
  'total fat': 'total_fat',
  fat: 'total_fat',
  'saturated fat': 'saturated_fat',
  'trans fat': 'trans_fat',
  'trans-fat': 'trans_fat',
  'trans fatty acid': 'trans_fat',
  'mono-unsaturated fatty acids': 'mono_unsaturated_fatty_acids',
  'poly-unsaturated fatty acids': 'poly_unsaturated_fatty_acids',
  cholesterol: 'cholesterol',
  protein: 'protein',
  'total carbohydrate': 'total_carbohydrate',
  carbohydrate: 'total_carbohydrate',
  'carbohydrate - total': 'total_carbohydrate',
  sugars: 'sugars',
  'total sugars': 'sugars',
  'added sugars': 'added_sugars',
  sucrose: 'sucrose',
  'fructose': 'fructose',
  'glucose': 'glucose',
  galactose: 'galactose',
  lactose: 'lactose',
  maltose: 'maltose',
  fibre: 'dietary_fibre',
  fiber: 'dietary_fibre',
  'dietary fibre': 'dietary_fibre',
  'dietary fiber': 'dietary_fibre',
  'soluble fibre': 'soluble_fibre',
  'insoluble fibre': 'insoluble_fibre',
  sodium: 'sodium',
  'total sodium': 'sodium',
  'salt': 'salt',
  'total salt': 'salt',
  calcium: 'calcium',
  iron: 'iron',
  phosphorus: 'phosphorus',
  magnesium: 'magnesium',
  zinc: 'zinc',
  iodine: 'iodine',
  selenium: 'selenium',
  potassium: 'potassium',
  'vitamin a': 'vitamin_a',
  'vitamin c': 'vitamin_c',
  'vitamin d': 'vitamin_d',
  'vitamin e': 'vitamin_e',
  'vitamin k': 'vitamin_k',
  'vitamin b1': 'vitamin_b1',
  'vitamin b2': 'vitamin_b2',
  'vitamin b3': 'vitamin_b3',
  'vitamin b6': 'vitamin_b6',
  'vitamin b9': 'vitamin_b9',
  'folic acid: ': 'folic_acid',
  'folic acid': 'folic_acid',
  'vitamin b12': 'vitamin_b12',
  niacin: 'niacin',
  riboflavin: 'riboflavin',
  thiamine: 'thiamine',
  biotin: 'biotin',
  choline: 'choline',
  taurine: 'taurine',
};

/** Canonical unit per nutrient (for `normalized_value`). */
const CANONICAL_UNIT: Record<string, NutrientUnit> = {
  energy: 'kcal',
  energy_from_fat: 'kcal',
  total_fat: 'g',
  saturated_fat: 'g',
  trans_fat: 'g',
  mono_unsaturated_fatty_acids: 'g',
  poly_unsaturated_fatty_acids: 'g',
  cholesterol: 'mg',
  protein: 'g',
  total_carbohydrate: 'g',
  sugars: 'g',
  added_sugars: 'g',
  sucrose: 'g',
  fructose: 'g',
  glucose: 'g',
  galactose: 'g',
  lactose: 'g',
  maltose: 'g',
  dietary_fibre: 'g',
  soluble_fibre: 'g',
  insoluble_fibre: 'g',
  sodium: 'mg',
  salt: 'mg',
  calcium: 'mg',
  iron: 'mg',
  phosphorus: 'mg',
  magnesium: 'mg',
  zinc: 'mg',
  iodine: 'µg',
  selenium: 'µg',
  potassium: 'mg',
  vitamin_a: 'µg',
  vitamin_c: 'mg',
  vitamin_d: 'µg',
  vitamin_e: 'mg',
  vitamin_k: 'µg',
  vitamin_b1: 'mg',
  vitamin_b2: 'mg',
  vitamin_b3: 'mg',
  vitamin_b6: 'mg',
  vitamin_b9: 'µg',
  folic_acid: 'µg',
  vitamin_b12: 'µg',
  niacin: 'mg',
  riboflavin: 'mg',
  thiamine: 'mg',
  biotin: 'µg',
  choline: 'mg',
  taurine: 'mg',
};

const UNIT_ALIASES: Record<string, NutrientUnit> = {
  g: 'g',
  gm: 'g',
  grams: 'g',
  gram: 'g',
  mg: 'mg',
  'mgs': 'mg',
  milligram: 'mg',
  µg: 'µg',
  ug: 'µg',
  mcg: 'mcg',
  kcal: 'kcal',
  'kcal.': 'kcal',
  cal: 'kcal',
  calories: 'kcal',
  kj: 'kJ',
  '%': '%',
  iu: 'IU',
};

/** Lines that are structural, not nutrient data. */
const SKIP_PATTERNS = [
  /^\s*$/,
  /\bnutrition(?:al)?\b/i,
  /\bper\s+\d+\s*(?:g|ml|gm|serving|100\s*g|100\s*ml)\b/i,
  /\*(?:approx|approximately)\b/i,
  /^[\s|*\-–—]+$/,
  /\brda\b/i,
  /\bextract\s+of\s+values?\b/i,
  /\bpercent(?:age)?\s+daily\b/i,
  /\bnutrition\s+information\s+per\b/i,
  /\bservings?\s+per\b/i,
];

const NUMBER_RE = /(\d+(?:[.,]\d+)?)\s*(kcal|kcal\.?|kj|g|gm|grams?|mg|mgs|milligrams?|µg|ug|mcg|%|iu)?/i;
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s*%/;
const TRACE_RE = /\b(trace|tr\.|nil|negligible|not\s+detected)\b/i;

function toNumber(text: string): number | null {
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Converts a parsed value into the nutrient's canonical unit when possible. */
function toCanonical(value: number, unit: NutrientUnit, canonical: NutrientUnit): number | null {
  if (value === null) return null;
  if (canonical === null || canonical === '%' || canonical === 'IU') return value;
  if (unit === null) return null;
  const toGrams = (v: number, u: NutrientUnit): number | null => {
    if (u === 'g') return v;
    if (u === 'mg') return v / 1000;
    if (u === 'µg' || u === 'mcg') return v / 1_000_000;
    return null;
  };
  if (canonical === 'g' || canonical === 'mg' || canonical === 'µg') {
    const grams = toGrams(value, unit);
    if (grams === null) return null;
    return canonical === 'g' ? Number(grams.toFixed(6)) : Number((grams * (canonical === 'mg' ? 1000 : 1_000_000)).toFixed(6));
  }
  if (canonical === 'kcal') {
    if (unit === 'kcal') return value;
    if (unit === 'kJ') return Number((value / 4.184).toFixed(2));
    return null;
  }
  if (canonical === 'kJ' && unit === 'kcal') return Number((value * 4.184).toFixed(2));
  return value;
}

function canonicalNutrient(label: string): string | null {
  const key = normalizeIngredient(stripLabelQualifiers(label))
    .replace(/:$/, '')
    .trim();
  if (NUTRIENT_LABELS[key]) return NUTRIENT_LABELS[key]!;
  // "Total Fat (incl. of ...)" / "Protein 3.0g" style leftovers.
  const stripped = key.replace(/\(.*?\)/g, '').trim();
  if (NUTRIENT_LABELS[stripped]) return NUTRIENT_LABELS[stripped]!;
  if (NUTRIENT_LABELS[stripped.replace(/\s+/g, ' ')]) return NUTRIENT_LABELS[stripped.replace(/\s+/g, ' ')]!;
  // Prefix match for labels like "protein (added)".
  for (const [name, key2] of Object.entries(NUTRIENT_LABELS)) {
    if (key2.trim() === '' || name.length < 4) continue;
    if (stripped.startsWith(name)) return key2;
  }
  return null;
}

/**
 * Strips the nutrient name from a line, leaving the value part.
 *
 * The label ends at the first construct that cannot be part of a nutrient name:
 * a number, an opening parenthesis, or a trace qualifier. Stopping at `trace`
 * matters — otherwise `Trans fat trace` would parse the whole line as the
 * nutrient name and lose the quantity entirely.
 */
const LABEL_TERMINATOR = '(?=\\s*\\(|\\s*\\d|\\s*(?:trace|tr\\.|nil|negligible|not\\s+detected)\\b|$)';

function splitLabelAndValue(line: string): { label: string; rest: string } {
  const match = new RegExp(`^([^0-9]*?)${LABEL_TERMINATOR}`).exec(line);
  const label = (match?.[1] ?? line).replace(/[\s:.\-–—*]+$/, '').trim();
  const index = line.indexOf(label);
  const rest = index >= 0 ? line.slice(index + label.length) : line.slice(label.length);
  return { label, rest };
}

/**
 * Drop the lead-in words FSSAI panels print before the nutrient itself:
 * `of which Sugars`, `including ...`, `approx. Energy`, `*Total Fat`.
 */
const LABEL_QUALIFIERS = /^(?:of\s+which|including|incl\.?|contains?|approx\.?|approximately|\*|total\s+amount\s+of)\s+/i;

function stripLabelQualifiers(label: string): string {
  let out = label.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LABEL_QUALIFIERS, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

export interface ParseNutritionOptions {
  heading?: string | null;
  startLine?: number;
  endLine?: number;
  meanWordConfidence?: number | null;
}

export function parseNutritionSection(rawSection: string, options: ParseNutritionOptions = {}): NutritionParseResult {
  const text = rawSection.replace(/\r\n?/g, '\n').trim();
  const lines = text.split('\n');
  const values: NutritionValue[] = [];
  const undeciphered: string[] = [];

  const basisMatch = /per\s+(\d+(?:[.,]\d+)?\s*(?:g|gm|ml|ml\b|serving|100\s*g|100\s*ml))/i.exec(text);
  const basis = basisMatch ? basisMatch[0] : null;
  const servingMatch = /\b(?:serving\s+size|serves?\s+about|approx\.?\s*per)\b[:\s]*([0-9]+\s*(?:g|gm|ml|piece|cup|slice|tbsp|tsp)?)/i.exec(text);
  const servingSize = servingMatch ? servingMatch[1]!.trim() : null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (SKIP_PATTERNS.some((p) => p.test(line))) continue;

    const { label, rest } = splitLabelAndValue(line);
    const nutrient = label.length > 0 ? canonicalNutrient(label) : null;
    if (!nutrient) {
      undeciphered.push(line);
      continue;
    }

    const percentMatch = PERCENT_RE.exec(rest);
    const traceMatch = TRACE_RE.exec(rest);
    const numberMatch = NUMBER_RE.exec(rest);

    let value: number | null = null;
    let unit: NutrientUnit = null;
    if (numberMatch) {
      value = toNumber(numberMatch[1]!);
      const rawUnit = numberMatch[2];
      unit = rawUnit ? (UNIT_ALIASES[rawUnit.toLowerCase()] ?? null) : null;
    }

    if (value === null && !traceMatch) {
      undeciphered.push(line);
      continue;
    }

    const canonicalUnit = CANONICAL_UNIT[nutrient] ?? unit;
    values.push({
      nutrient,
      label,
      raw: line,
      value,
      unit,
      normalized_value: value === null ? null : toCanonical(value, unit, canonicalUnit),
      normalized_unit: canonicalUnit,
      daily_value_percent: percentMatch ? toNumber(percentMatch[1]!) : null,
      trace: value === null && Boolean(traceMatch),
    });
  }

  const deduped: NutritionValue[] = [];
  const seen = new Map<string, NutritionValue>();
  for (const v of values) {
    const existing = seen.get(v.nutrient);
    // Keep the most informative reading for a nutrient that appeared twice.
    if (!existing) {
      seen.set(v.nutrient, v);
      deduped.push(v);
      continue;
    }
    if (existing.trace && !v.trace) seen.set(v.nutrient, v);
  }

  const detected = deduped.length > 0;
  const ocr = options.meanWordConfidence === null || options.meanWordConfidence === undefined
    ? 0.5
    : Math.max(0, Math.min(1, options.meanWordConfidence / 100));
  const basisScore = basis !== null ? 1 : 0.5;
  const energyFound = deduped.some((v) => v.nutrient === 'energy') ? 1 : 0.4;
  const countScore = Math.min(1, deduped.length / 8);
  const confidence = detected
    ? Number((basisScore * 0.2 + countScore * 0.3 + energyFound * 0.2 + ocr * 0.3).toFixed(3))
    : null;

  return {
    detected,
    rawSection: text,
    heading: options.heading ?? null,
    basis,
    servingSize,
    values: deduped,
    undecipheredLines: undeciphered,
    confidence,
    confidence_source: detected ? 'derived' : 'unknown',
    confidence_breakdown: {
      basis: Number(basisScore.toFixed(3)),
      value_count: Number(countScore.toFixed(3)),
      energy_present: Number(energyFound.toFixed(3)),
      ocr: Number(ocr.toFixed(3)),
    },
  };
}
