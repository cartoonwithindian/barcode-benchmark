/**
 * OCR text normalisation for Indian packaged-food labels.
 *
 * Rules that this module never breaks:
 *  - the original OCR text is always kept (returned as `raw_text`),
 *  - nothing is silently overwritten: every change is recorded as a correction
 *    with the character range it applies to,
 *  - a correction is only applied when the result is *supported* — either by a
 *    vocabulary of common label terms, or by an unambiguous structural rule such
 *    as the INS code grammar,
 *  - a per-change confidence is recorded; downstream code can require a
 *    threshold before trusting the normalised form.
 *
 * The OCR confusions handled here are the ones seen on Indian retail packaging:
 * digit/letter swaps in all-caps words (`SUG4R`, `M0NOSODIUM`, `PALM0IL`) and
 * INS code mangling (`INS62I`, `lNS 621`, `INS-62I`).
 */

export interface TextCorrection {
  kind: 'ocr_confusion' | 'ins_code' | 'whitespace' | 'punctuation' | 'unicode';
  raw: string;
  corrected: string;
  /** Confidence of the *correction*, 0..1. */
  confidence: number;
  /** Character offsets in the source text. */
  start: number;
  end: number;
  reason: string;
}

export interface NormalizedText {
  rawText: string;
  normalizedText: string;
  corrections: TextCorrection[];
  /** Mean confidence of the applied corrections. 1 when nothing changed. */
  confidence: number;
}

/** Digit -> letter confusions seen when all-caps glyphs are OCR'd. */
const DIGIT_TO_LETTER: Record<string, string> = {
  '0': 'O',
  '1': 'I',
  '4': 'A',
  '5': 'S',
  '8': 'B',
};

/**
 * Vocabulary gate. A mixed digit/letter token is only "repaired" when the
 * repaired token is a known label term, so real values such as `B12`, `A&D`
 * or `500ml` survive untouched.
 */
const LABEL_VOCABULARY = new Set<string>([
  'SUGAR', 'SALT', 'WHEAT', 'FLOUR', 'MAIDA', 'REFINED', 'PALM', 'OIL', 'OILS', 'GHEE',
  'MILK', 'SOLIDS', 'POWDER', 'CREAM', 'BUTTER', 'CHEESE', 'YOGURT', 'CURD', 'PANEER',
  'MONOSODIUM', 'GLUTAMATE', 'CITRIC', 'ACID', 'BENZOATE', 'SORBATE', 'PROPIONATE',
  'PE C TIN', 'GLYCERIN', 'MALT', 'DEXTRIN', 'STARCH', 'VITAMIN', 'MINERALS',
  'FLAVOUR', 'FLAVOURING', 'EMULSIFIER', 'STABILIZER', 'STABILISER', 'PRESERVATIVE',
  'COLOUR', 'COLOR', 'SWEETENER', 'THICKENER', 'ANTIOXIDANT', 'ACIDULANT', 'BINDER',
  'MONO', 'DIGLYCERIDES', 'LECITHIN', 'SOYA', 'SOY', 'MAIZE', 'CORN', 'RICE',
  'CHICORY', 'INULIN', 'OLIGOSACCHARIDE', 'TOCOPHEROL', 'ASCORBIC', 'PHOSPHORIC',
  'GUAR', 'GUM', 'CARRAGEENAN', 'XANTHAN', 'COCOA', 'VANILLA', 'CHOCOLATE',
  'TOMATO', 'ONION', 'GARLIC', 'SPICE', 'SPICES', 'RED', 'PEPPER', 'PAPRIKA',
  'TURMERIC', 'CORIANDER', 'CUMIN', 'BLACK', 'PEPPER', 'GINGER', 'MUSTARD',
  'WATER', 'SODA', 'CARBONATED', 'CITRIC', 'ACIDULANTS', 'PRESERVATIVES',
  'NO', 'ADDED', 'COLOUR', 'FLAVOURS', 'CONTAINS', 'ALLERGENS', 'INGREDIENTS',
]);

/**
 * Letter-to-letter confusions actually observed on Indian packs. Deliberately
 * tiny: each entry is gated on the repaired word being in
 * `LABEL_VOCABULARY`, so a genuinely different word is never rewritten.
 * `QIL`->`OIL` is the recurring one ("Refined Palm Qil" reads as "Palm Oil").
 */
const LETTER_CONFUSIONS: Record<string, string> = {
  QIL: 'OIL',
  Qil: 'Oil',
  Qll: 'OIL',
  QII: 'OIL',
  GHiE: 'GHEE',
  GHIE: 'GHEE',
  Ghie: 'Ghee',
  Sodiurn: 'Sodium',
  S0dium: 'Sodium',
};

/** Applies the digit->letter repair to a single token. */
function repairToken(token: string): string | null {
  if (!/[0-9]/.test(token)) return null;
  if (!/[A-Z]/i.test(token)) return null;
  const repaired = [...token]
    .map((ch) => (DIGIT_TO_LETTER[ch] ? DIGIT_TO_LETTER[ch]! : ch))
    .join('');
  return repaired === token ? null : repaired;
}

/**
 * INS code repair.
 *
 * OCR routinely swaps 1/I/l, 0/O, 5/S and 8/B inside additive codes and also
 * drops or invents the space: `INS 62I`, `INS62I`, `lNS 471`, `0NS-322`,
 * `INS 62l`. INS codes have a strict 3-digit grammar and a distinctive prefix,
 * so recognising the prefix and rewriting exactly three characters is safe.
 *
 * Applied as a whole-text pass because the prefix and the digits are often
 * separated by whitespace and would otherwise be two different tokens.
 */
const INS_CODE_RE = /\b([Il1Oo0]?)[Nn][Ss5][ \t.\-]?([0-9OoIlSBs]{3})\b/g;

const INS_DIGIT_MAP: Record<string, string> = {
  O: '0', o: '0', I: '1', l: '1', i: '1', S: '5', s: '5', B: '8',
};

export function repairInsCodesInText(text: string): { text: string; corrections: TextCorrection[] } {
  const corrections: TextCorrection[] = [];
  const repaired = text.replace(INS_CODE_RE, (match, prefix: string, body: string, offset: number) => {
    const digits = [...body].map((c) => (c >= '0' && c <= '9' ? c : (INS_DIGIT_MAP[c] ?? '?'))).join('');
    // An unmappable character means this was not an additive code after all.
    if (digits.includes('?')) return match;
    const canonical = `INS ${digits}`;
    if (canonical === match) return match;
    corrections.push({
      kind: 'ins_code',
      raw: match,
      corrected: canonical,
      confidence: 0.95,
      start: offset,
      end: offset + match.length,
      reason: 'ins_code_normalisation',
    });
    return canonical;
  });
  return { text: repaired, corrections };
}

/** Normalises a full OCR text block, recording every change. */
export function normalizeOcrText(rawText: string): NormalizedText {
  const corrections: TextCorrection[] = [];
  let text = rawText;

  // 1. Unicode normalisation + common OCR typography fixes.
  const unicodeBefore = text;
  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl');
  if (text !== unicodeBefore) {
    const idx = indexOfDiff(unicodeBefore, text);
    corrections.push({
      kind: 'unicode',
      raw: unicodeBefore.slice(idx, idx + 1),
      corrected: text.slice(idx, idx + 1),
      confidence: 0.99,
      start: idx,
      end: idx + 1,
      reason: 'unicode_normalisation',
    });
  }

  // 2. INS codes first: they have the strictest grammar, and fixing them here
  //    stops the vocabulary pass below from "repairing" digits inside a code.
  const ins = repairInsCodesInText(text);
  if (ins.text !== text) {
    corrections.push(...ins.corrections);
    text = ins.text;
  }

  // 3. Token-wise vocabulary repairs.
  const tokens: Array<{ value: string; start: number; end: number }> = [];
  const tokenRe = /[A-Za-z0-9][A-Za-z0-9.\-&+/']*/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    tokens.push({ value: match[0], start: match.index, end: match.index + match[0].length });
  }

  /** Applied edits, applied right-to-left so offsets stay valid. */
  const edits: Array<{ start: number; end: number; replacement: string; correction: Omit<TextCorrection, 'start' | 'end'> }> = [];

  for (const token of tokens) {
    // Letter-to-letter repairs are keyed on an exact observed spelling, so they
    // may apply to mixed-case words ("Palm Qil") too.
    const letterFix = LETTER_CONFUSIONS[token.value];
    if (letterFix) {
      // Vocabulary keys are stored uppercase, and a mixed-case replacement such
      // as `Oil` must be folded before lookup (`[^A-Z]` alone would drop the
      // lowercase `l` and leave just `O`).
      const key = letterFix.toUpperCase().replace(/[^A-Z]/g, '');
      if (!LABEL_VOCABULARY.has(key)) continue;
      edits.push({
        start: token.start,
        end: token.end,
        replacement: letterFix,
        correction: {
          kind: 'ocr_confusion',
          raw: token.value,
          corrected: letterFix,
          confidence: 0.8,
          reason: 'letter_confusion_in_known_label_term',
        },
      });
      continue;
    }

    // Digit->letter repairs only apply to uppercase-ish tokens: mixed-case
    // prose is left alone.
    const isUpperish = token.value === token.value.toUpperCase() && /[A-Za-z]/.test(token.value);
    if (!isUpperish) continue;

    const repaired = repairToken(token.value);
    if (!repaired) continue;

    const normalisedKey = repaired.toUpperCase().replace(/[^A-Z]/g, '');
    const inVocabulary = LABEL_VOCABULARY.has(normalisedKey);
    // Only correct when the repaired token is a known label word.
    if (!inVocabulary) continue;

    edits.push({
      start: token.start,
      end: token.end,
      replacement: repaired,
      correction: {
        kind: 'ocr_confusion',
        raw: token.value,
        corrected: repaired,
        // Vocabulary-backed repairs are reliable but not certain.
        confidence: 0.85,
        reason: 'digit_letter_confusion_in_known_label_term',
      },
    });
  }

  edits.sort((a, b) => b.start - a.start);
  for (const edit of edits) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    corrections.push({ ...edit.correction, start: edit.start, end: edit.end });
  }

  // 3. Line-level whitespace tidy-up (trailing spaces, 3+ blank lines).
  const whitespaceBefore = text;
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  if (text !== whitespaceBefore) {
    corrections.push({
      kind: 'whitespace',
      raw: '(multiple blank lines / trailing spaces)',
      corrected: '(collapsed)',
      confidence: 0.99,
      start: 0,
      end: whitespaceBefore.length,
      reason: 'whitespace_normalisation',
    });
  }

  const confidence =
    corrections.length === 0
      ? 1
      : Number((corrections.reduce((sum, c) => sum + c.confidence, 0) / corrections.length).toFixed(3));

  return {
    rawText,
    normalizedText: text,
    corrections: corrections.sort((a, b) => a.start - b.start),
    confidence,
  };
}

function indexOfDiff(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let i = 0; i < max; i++) if (a[i] !== b[i]) return i;
  return 0;
}

/** Extracts every INS/E-number code found in a text block. */
export interface InsCodeHit {
  /** Canonical form, e.g. `INS 621`. */
  code: string;
  raw: string;
  /** Reference name for the code, when the FoodGuard knowledge base has one. */
  reference_name: string | null;
  start: number;
}

const INS_REFERENCE: Record<string, string> = {
  '100': 'sorbitol',
  '101': 'sorbitol',
  '110': 'sorbitol',
  '200': 'sorbic acid',
  '202': 'potassium sorbate',
  '210': 'sodium benzoate',
  '211': 'sodium benzoate',
  '212': 'potassium benzoate',
  '215': 'methyl ethyl ketoxime',
  '220': 'sulphur dioxide',
  '221': 'sodium metabisulphite',
  '222': 'sodium bisulphite',
  '223': 'calcium disodium edta',
  '224': 'calcium disodium edta',
  '226': 'potassium sorbate',
  '300': 'ascorbic acid',
  '301': 'ascorbic acid',
  '302': 'ascorbic acid',
  '303': 'ascorbic acid',
  '320': 'tocopherols',
  '321': 'tocopherols',
  '322': 'lecithins',
  '325': 'lactitol',
  '330': 'citric acid',
  '331': 'sodium citrates',
  '332': 'sodium citrates',
  '333': 'sodium citrates',
  '334': 'sodium citrates',
  '335': 'sodium citrates',
  '336': 'potassium sorbate',
  '337': 'sodium cetyl phosphate',
  '338': 'calcium disodium edta',
  '339': 'sodium stearoyl lactylate',
  '400': 'calcium alginate',
  '401': 'sodium alginate',
  '402': 'calcium alginate',
  '404': 'carrageenan',
  '405': 'locust bean gum',
  '406': 'locust bean gum',
  '407': 'carrageenan',
  '410': 'carob bean gum',
  '411': 'guar gum',
  '412': 'guar gum',
  '413': 'gum arabic',
  '414': 'gum arabic',
  '415': 'xanthan gum',
  '416': 'locust bean gum',
  '417': 'tara gum',
  '440': 'pectins',
  '441': 'gelatin',
  '442': 'cellulose',
  '443': 'lactose',
  '444': 'sorbitol',
  '445': 'glycerol',
  '450': 'lecithins',
  '451': 'sorbitol',
  '452': 'sorbitol',
  '466': 'sodium carboxymethylcellulose',
  '471': 'mono and diglycerides',
  '472': 'sorbitol',
  '473': 'sugar esters',
  '475': 'sorbitol',
  '476': 'polyglycerol polyricinoleate',
  '477': 'sorbitol',
  '481': 'sorbitol',
  '500': 'sodium carbonates',
  '501': 'sodium citrates',
  '503': 'sodium nitrite',
  '504': 'sodium nitrite',
  '508': 'sodium phosphates',
  '510': 'sodium nitrite',
  '511': 'sodium nitrite',
  '520': 'sodium aluminium phosphate',
  '522': 'sodium aluminium phosphate',
  '621': 'monosodium glutamate',
  '622': 'monosodium glutamate',
  '623': 'monosodium glutamate',
  '624': 'monosodium glutamate',
  '625': 'monosodium glutamate',
  '626': 'monosodium glutamate',
  '640': 'glycine',
  '641': 'glycine',
  '900': 'beeswax',
  '901': 'beeswax',
  '902': 'beeswax',
  '903': 'carnauba wax',
  '904': 'shellac',
  '905': 'shellac',
  '906': 'shellac',
  '950': 'acesulfame potassium',
  '951': 'aspartame',
  '952': 'cyclamate',
  '953': 'isomalt',
  '955': 'sucralose',
  '956': 'saccharin',
  '957': 'thaumatin',
  '960': 'steviol glycosides',
  '961': 'neotame',
  '962': 'salt',
  '999': 'quillaia extract',
};

export function findInsCodes(text: string): InsCodeHit[] {
  const hits: InsCodeHit[] = [];
  const re = /\b(?:INS[\s.\-]?|E[\s.\-]?)(\d{3}|[0-9OIl]{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = [...m[1]!]
      .map((c) => (c >= '0' && c <= '9' ? c : ({ O: '0', o: '0', I: '1', l: '1' } as Record<string, string>)[c] ?? '?'))
      .join('');
    if (digits.includes('?')) continue;
    if (Number(digits) === 0) continue;
    const start = m.index;
    hits.push({
      code: `INS ${digits}`,
      raw: m[0],
      reference_name: INS_REFERENCE[digits] ?? null,
      start,
    });
  }
  return hits;
}

/** All known INS reference names, exported for the ingredient knowledge lookup. */
export const INS_REFERENCE_NAMES: Readonly<Record<string, string>> = INS_REFERENCE;