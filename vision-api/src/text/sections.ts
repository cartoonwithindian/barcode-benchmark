/**
 * Section detection on OCR text.
 *
 * Indian packaged-food labels are dense: the ingredient list, the nutrition
 * panel, allergen statements, storage instructions and MRP/FSSAI declarations
 * all compete for a few square centimetres. This module locates each section by
 * heading regexes and simple layout rules (a heading terminates at a blank line,
 * a following heading, or a hard length cap).
 *
 * It only ever *locates* text that OCR actually produced. If a section is not
 * present, the result is `found: false` — never an empty-but-present section.
 */

export interface TextRegion {
  kind: SectionKind;
  /** Text of the heading that opened the section, when one was found. */
  heading: string | null;
  /** The section body, exactly as OCR produced it (before normalisation). */
  rawSection: string;
  startLine: number;
  endLine: number;
  bbox?: { x: number; y: number; width: number; height: number };
}

export type SectionKind =
  | 'ingredients'
  | 'ingredients_continued'
  | 'nutrition'
  | 'allergens'
  | 'contains'
  | 'storage'
  | 'usage'
  | 'manufacturer'
  | 'fssai'
  | 'mrp'
  | 'claims'
  | 'net_quantity'
  | 'best_before';

export interface SectionPatterns {
  kind: SectionKind;
  patterns: RegExp[];
  /** Headings that terminate this section. */
  stopPatterns: RegExp[];
  maxLines: number;
}

/**
 * Heading vocabularies. OCR noise is tolerated by allowing up to a few stray
 * characters inside words via `.{0,2}` gaps.
 */
const SECTIONS: SectionPatterns[] = [
  {
    kind: 'ingredients',
    patterns: [
      /\bingredients?\b\s*[:\-–]?/i,
      /\bingredient\s+list\b/i,
      /\bcomposition\b\s*[:\-–]?/i,
      /\bmade\s+from\b/i,
      /\bingredients?\s+used\b/i,
      /\bcontains\s+following\b/i,
      /\bprepared\s+from\b/i,
    ],
    stopPatterns: [
      /\bnutrition\b/i,
      /\ballergen/i,
      /\bcontains\b\s*[:\-]?\s*(allergen|milk|gluten|soy|soya|nut)/i,
      /\bstorage\b/i,
      /\bstore\s+in\b/i,
      /\busage\b/i,
      /\binstructions?\b/i,
      /\bfor\s+best\b/i,
      /\bmrp\b/i,
      /\bnet\s+(qty|quantity|weight|content)\b/i,
      /\bbest\s+before\b/i,
      /\buse\s+by\b/i,
      /\bmanufactur/i,
      /\bfssai\b/i,
      /\bclaim/i,
      /\bmarketed\s+by\b/i,
      /\bco-?operative\b/i,
    ],
    maxLines: 14,
  },
  {
    kind: 'ingredients_continued',
    patterns: [/\bingredients?\s*[:\-–]?\s*(cont(?:inued|d)?|part\s*ii)\b/i, /\b\(?cont(?:inued|d)?\)?\s*[:\-–]/i],
    stopPatterns: [],
    maxLines: 10,
  },
  {
    kind: 'nutrition',
    patterns: [
      /\bnutrition(?:al)?\s+(?:facts?|information|values?|panel|table)\b/i,
      /\bnutritional\s+content\b/i,
      /\bnutrition\b\s*[:\-–]/i,
      /\bper\s+100\s*(?:g|ml|gm)\b/i,
    ],
    stopPatterns: [
      /\bingredients?\b/i,
      /\ballergen/i,
      /\bstorage\b/i,
      /\bstore\s+in\b/i,
      /\bmrp\b/i,
      /\bfssai\b/i,
      /\bnet\s+(?:qty|quantity|weight|content)\b/i,
      /\bbest\s+before\b/i,
      /\bmanufactur/i,
      /\bmarketed\s+by\b/i,
      /\bclaim/i,
      /\bfor\s+best\b/i,
    ],
    maxLines: 22,
  },
  {
    kind: 'allergens',
    patterns: [
      /\ballergens?\b/i,
      /\ballergen\s+(?:information|warning|declaration)\b/i,
      /\ballergen\s+information\b/i,
      /\bdeclaration\s+of\s+allergens?\b/i,
    ],
    stopPatterns: [/\bingredients?\b/i, /\bnutrition/i, /\bstorage\b/i, /\bmrp\b/i, /\bfssai\b/i],
    maxLines: 6,
  },
  {
    kind: 'contains',
    patterns: [
      /\bcontains?\b\s*[:\-–]?\s*(?:allergens?\b)?/i,
      /\bmay\s+contain\b/i,
      /\bsh\s*contain(?:s|ing)?\b/i,
      /\bprocess(?:ed)?\s+(?:in|on)\b/i,
      /\btraces?\s+of\b/i,
    ],
    stopPatterns: [/\bnutrition/i, /\bstorage\b/i, /\bmrp\b/i, /\bfssai\b/i],
    maxLines: 6,
  },
  {
    kind: 'storage',
    patterns: [/\bstorage\b/i, /\bstore\s+in\b/i, /\bstored\s+in\b/i, /\bkeep\s+(?:in|under|coolly)\b/i],
    stopPatterns: [/\bmrp\b/i, /\bfssai\b/i, /\bingredients?\b/i, /\bnutrition/i],
    maxLines: 6,
  },
  {
    kind: 'usage',
    patterns: [
      /\b(?:usage|use|consumption)\s+(?:instructions?|guidelines?)\b/i,
      /\bhow\s+to\s+use\b/i,
      /\binstructions?\s+(?:for\s+use|on\s+use)\b/i,
      /\bserving\s+size\b/i,
    ],
    stopPatterns: [/\bmrp\b/i, /\bfssai\b/i, /\bingredients?\b/i, /\bnutrition/i],
    maxLines: 6,
  },
  {
    kind: 'manufacturer',
    patterns: [
      /\bmanufactur(?:ed|er)\s+by\b/i,
      /\bmarketed\s+by\b/i,
      /\bpacked\s+by\b/i,
      /\bprocessed\s+by\b/i,
      /\b(?:f|p|m)\s*(?:no|da)\s*[:\-–]/i,
    ],
    stopPatterns: [/\bmrp\b/i, /\bfssai\b/i],
    maxLines: 8,
  },
  {
    kind: 'fssai',
    patterns: [
      /\bfssai\b/i,
      /\blic(?:en[cs]e)?\.?\s*(?:no|number)\b/i,
      /\bfo(?:od)?\s*lic(?:en[cs]e)?\b/i,
      /\bcentral\s+licen[cs]e\s+no\b/i,
    ],
    stopPatterns: [],
    maxLines: 3,
  },
  {
    kind: 'mrp',
    patterns: [/\bm\.?r\.?p\.?\b/i, /\bmaximum\s+retail\s+price\b/i, /\bmrp\b/i],
    stopPatterns: [/\bfssai\b/i],
    maxLines: 4,
  },
  {
    kind: 'net_quantity',
    patterns: [
      /\bnet\s+(?:qty|quantity|weight|content|wt)\b/i,
      /\bnet\s+content\b/i,
      /\bpacked\s+net\b/i,
      /\bcontents?\s*[:\-–]\s*\d/i,
    ],
    stopPatterns: [/\bmrp\b/i, /\bfssai\b/i],
    maxLines: 3,
  },
  {
    kind: 'best_before',
    patterns: [/\bbest\s+before\b/i, /\buse\s+by\b/i, /\bbest\s+first\b/i, /\bexpiry\b/i, /\bshelf\s+life\b/i],
    stopPatterns: [/\bmrp\b/i, /\bfssai\b/i],
    maxLines: 3,
  },
  {
    kind: 'claims',
    patterns: [
      /\b(?:no|zero|100%|100\s*%)[\s-]?(?:added\s+)?(?:colou?r|preservative|sugar|fat|trans\s*fat|cholesterol)\b/i,
      /\bno\s+added\b/i,
      /\b(?:rich\s+in|source\s+of|high\s+protein|low\s+fat|multigrain|whole\s+wheat|organic|vegan|vegetarian)\b/i,
      /\bclaim(?:s|ed)?\b/i,
    ],
    stopPatterns: [/\bingredients?\b/i, /\bnutrition/i],
    maxLines: 4,
  },
];

export function sectionFor(kind: SectionKind): SectionPatterns | undefined {
  return SECTIONS.find((s) => s.kind === kind);
}

function matchAny(patterns: RegExp[], line: string): boolean {
  return patterns.some((p) => {
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    const re = new RegExp(p.source, flags);
    re.lastIndex = 0;
    return re.test(line);
  });
}

/**
 * Finds the first occurrence of a section.
 *
 * The heading line is consumed (its text is returned separately) unless the
 * heading *is* the content, which is the case for short declarations such as
 * `FSSAI Lic. No. 10012051000123`.
 */
export function findSection(lines: string[], kind: SectionKind): TextRegion | null {
  const spec = sectionFor(kind);
  if (!spec) return null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (!matchAny(spec.patterns, line)) continue;

    const heading = line.trim();
    const bodyLines: string[] = [];
    // The heading line often already carries the first content tokens
    // ("INGREDIENTS: WHEAT FLOUR, SALT"), so keep the tail after the match.
    const tail = stripHeading(line, spec.patterns);
    if (tail.trim().length > 0) bodyLines.push(tail.trim());

    let end = i;
    for (let j = i + 1; j < lines.length && j - i <= spec.maxLines; j++) {
      const candidate = lines[j] ?? '';
      if (candidate.trim() === '') {
        // A blank line only ends the section when the next non-empty line is
        // not a continuation; look ahead before deciding.
        const nextNonEmpty = lines.slice(j + 1).find((l) => l.trim() !== '');
        if (nextNonEmpty === undefined) break;
        const lookahead = lines.indexOf(nextNonEmpty, j + 1);
        if (lookahead - j > 1) break;
        continue;
      }
      if (spec.stopPatterns.length > 0 && matchAny(spec.stopPatterns, candidate)) break;
      if (matchAny(spec.patterns, candidate) && bodyLines.length > 0) break;
      bodyLines.push(candidate.trim());
      end = j;
    }

    const rawSection = bodyLines.join('\n').trim();
    // A heading with no body is only a real section for single-line declarations.
    if (rawSection.length === 0 && kind !== 'fssai' && kind !== 'mrp' && kind !== 'net_quantity' && kind !== 'best_before') {
      continue;
    }
    if (rawSection.length === 0 && heading.length === 0) continue;

    return {
      kind,
      heading: kind === 'fssai' || kind === 'mrp' || kind === 'net_quantity' || kind === 'best_before' ? null : heading,
      rawSection: rawSection.length > 0 ? rawSection : heading,
      startLine: i,
      endLine: end,
    };
  }
  return null;
}

function stripHeading(line: string, patterns: RegExp[]): string {
  let best: { index: number; length: number } | null = null;
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.replace('g', ''));
    const m = re.exec(line);
    if (m && (best === null || m.index + m[0].length > best.index + best.length)) {
      best = { index: m.index, length: m[0].length };
    }
  }
  if (!best) return line;
  return `${line.slice(0, best.index)}${line.slice(best.index + best.length)}`;
}

/** Finds every section kind present in the text. */
export function findAllSections(lines: string[]): TextRegion[] {
  const out: TextRegion[] = [];
  for (const spec of SECTIONS) {
    const region = findSection(lines, spec.kind);
    if (region) out.push(region);
  }
  return out;
}

const INGREDIENT_HEADING_RE =
  /\b(?:ingredients?|composition|made\s+from|prepared\s+from)\b/i;
const NUTRITION_HEADING_RE = /\bnutrition(?:al)?\b/i;

export function hasIngredientHeading(text: string): boolean {
  return INGREDIENT_HEADING_RE.test(text);
}

export function hasNutritionHeading(text: string): boolean {
  return NUTRITION_HEADING_RE.test(text);
}

/** Veg / non-veg / "contains egg" markers, as OCR'd text. */
export interface VegMarker {
  type: 'vegetarian' | 'non_vegetarian' | 'egg_containing' | 'unknown';
  evidence: string;
  confidence: number;
}

export function detectVegMarker(text: string): VegMarker {
  const normalised = text.replace(/[\s|]+/g, ' ').toLowerCase();
  const nonVegPatterns = [
    /\bnon[\s\-]?veg(?:etarian)?\b/,
    /\bnon[\s\-]?vegetarian\b/,
    /\bcontains\s+meat\b/,
    /\bcontains\s+(?:chicken|beef|pork|fish|mutton)\b/,
  ];
  for (const p of nonVegPatterns) {
    const m = p.exec(normalised);
    if (m) return { type: 'non_vegetarian', evidence: m[0], confidence: 0.9 };
  }
  const eggPatterns = [/\bcontains\s+egg\b/, /\begg\s+products?\b/, /\bmayo\b/, /\bmayonnaise\b/, /\balbumen\b/, /\balbumin\b/];
  for (const p of eggPatterns) {
    const m = p.exec(normalised);
    if (m) return { type: 'egg_containing', evidence: m[0], confidence: 0.7 };
  }
  // A bare green square with no OCR text is common; only claim vegetarian when
  // the words themselves are present.
  const vegPatterns = [/\bveg(?:etarian)?\b/, /\bvegetarian\b/, /\bshudh\s+veg\b/, /\b100%\s*veg\b/, /\bmark\s+of\s+veg\b/];
  for (const p of vegPatterns) {
    const m = p.exec(normalised);
    if (m) return { type: 'vegetarian', evidence: m[0], confidence: 0.8 };
  }
  return { type: 'unknown', evidence: '', confidence: 0 };
}