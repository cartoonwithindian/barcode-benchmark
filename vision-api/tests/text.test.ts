/**
 * Text-layer unit tests.
 *
 * These cover the parts FoodGuard depends on for correctness of its scoring:
 * OCR correction, section detection, ingredient parsing, nutrition parsing and
 * product field extraction. All inputs here are strings, so the assertions are
 * exact rather than approximate.
 */
import { describe, expect, it } from 'vitest';
import { findInsCodes, normalizeOcrText } from '../src/text/normalize.js';
import { detectAllergensInText, parseIngredientSection, scoreIngredientConfidence, splitTopLevel } from '../src/text/ingredients.js';
import { parseNutritionSection } from '../src/text/nutrition.js';
import { extractProductInfo } from '../src/text/product.js';
import { detectVegMarker, findAllSections, findSection } from '../src/text/sections.js';
import type { IngredientItem } from '../src/text/ingredients.js';

function makeItem(normalized: string, code: string | null = null): IngredientItem {
  return {
    raw: normalized,
    normalized,
    code,
    ins_reference_name: null,
    additive_class: null,
    allergens: [],
    cross_contamination: null,
    sub_ingredients: [],
  };
}

describe('normalizeOcrText', () => {
  it('repairs digit-for-letter confusions only inside known label vocabulary', () => {
    const raw = 'SUG4R, P4LM 0IL, M0NOSODIUM GLUT4MATE';
    const out = normalizeOcrText(raw);
    expect(out.normalizedText).toBe('SUGAR, PALM OIL, MONOSODIUM GLUTAMATE');
    expect(out.corrections.length).toBeGreaterThan(0);
    expect(out.corrections.every((c) => c.confidence > 0)).toBe(true);
    // The untouched original must always be preserved.
    expect(out.rawText).toBe(raw);
  });

  it('repairs the O/Q confusion seen on foil packaging', () => {
    const out = normalizeOcrText('Refined Palm Qil');
    expect(out.normalizedText).toBe('Refined Palm Oil');
    expect(out.corrections[0]?.reason).toBe('letter_confusion_in_known_label_term');
  });

  it('leaves values that merely look confusable alone', () => {
    // B12 and A&D are real label content, not OCR noise.
    const out = normalizeOcrText('Vitamins A, D, B12, 500ml');
    expect(out.normalizedText).toBe('Vitamins A, D, B12, 500ml');
    expect(out.corrections).toHaveLength(0);
    expect(out.confidence).toBe(1);
  });

  it('repairs mangled INS codes and reports each repair', () => {
    const out = normalizeOcrText('INS62I, INS-330, lNS 471, INS 62l');
    expect(out.normalizedText).toContain('INS 621');
    expect(out.normalizedText).toContain('INS 330');
    expect(out.normalizedText).toContain('INS 471');
    expect(out.corrections.filter((c) => c.kind === 'ins_code').length).toBeGreaterThanOrEqual(3);
  });

  it('collapses runs of blank lines and trailing spaces', () => {
    const out = normalizeOcrText('Line one   \n\n\n\nLine two');
    expect(out.normalizedText).toBe('Line one\n\nLine two');
  });
});

describe('findInsCodes', () => {
  it('finds the common Indian additive codes with reference names', () => {
    const hits = findInsCodes('Sugar, INS 621, INS 330, INS 211, INS 322, INS 412, INS 471');
    expect(hits.map((h) => h.code)).toEqual(['INS 621', 'INS 330', 'INS 211', 'INS 322', 'INS 412', 'INS 471']);
    expect(hits[0]?.reference_name).toBe('monosodium glutamate');
    // INS 330 is citric acid (ascorbic acid is the 300-series).
    expect(hits.find((h) => h.code === 'INS 330')?.reference_name).toBe('citric acid');
  });

  it('does not invent a name for a code outside the table', () => {
    // 998/997 are not in the shipped table.
    const hits = findInsCodes('INS 998');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.code).toBe('INS 998');
    expect(hits[0]?.reference_name).toBeNull();
  });

  it('returns nothing when there is no code', () => {
    expect(findInsCodes('Refined sugar, salt')).toHaveLength(0);
  });
});

describe('splitTopLevel', () => {
  it('splits on commas but not inside parentheses', () => {
    expect(splitTopLevel('sugar (INS 621, INS 330), palm oil')).toEqual([
      'sugar (INS 621, INS 330)',
      'palm oil',
    ]);
  });
});

describe('parseIngredientSection', () => {
  it('parses a real-shaped ingredient list with sub-ingredients and INS codes', () => {
    const section = [
      'Milk, Sugar, INS 621 (Monosodium Glutamate),',
      'Refined Palm Oil, Milk Solids, INS 322, INS 330,',
      'INS 471, Citric Acid, Vitamins A, D, B12.',
    ].join('\n');

    const result = parseIngredientSection(section, { heading: 'Ingredients:' });

    expect(result.detected).toBe(true);
    expect(result.items.length).toBeGreaterThanOrEqual(8);

    const msg = result.items.find((i) => i.normalized.includes('monosodium glutamate'));
    expect(msg?.code).toBe('INS 621');
    expect(msg?.ins_reference_name).toBe('monosodium glutamate');
    expect(msg?.additive_class).toBe('flavour enhancer');
    expect(msg?.raw).toContain('Monosodium Glutamate');

    // INS 322 (lecithin) sits in the 300-series, so the generic Codex range
    // class is reported as `antioxidant` even though lecithin is used as an
    // emulsifier. The class is a range hint, not a per-code adjudication.
    const lecithin = result.items.find((i) => i.code === 'INS 322');
    expect(lecithin?.ins_reference_name).toBe('lecithins');
    expect(lecithin?.additive_class).toBe('antioxidant');

    // Every item keeps the exact OCR string.
    for (const item of result.items) {
      expect(item.raw.length).toBeGreaterThan(0);
      expect(item.normalized).toBe(item.normalized.toLowerCase());
    }
  });

  it('parses nested sub-ingredients from balanced parentheses', () => {
    const result = parseIngredientSection('Refined oil (palm oil (INS 524), soybean oil), salt');
    const refined = result.items[0]!;
    expect(refined.normalized).toBe('refined oil (palm oil (ins 524), soybean oil)');
    expect(refined.sub_ingredients).toHaveLength(2);
    expect(refined.sub_ingredients[0]?.sub_ingredients[0]?.code).toBe('INS 524');
    expect(result.items[1]?.normalized).toBe('salt');
  });

  it('reports allergens found in the list', () => {
    const result = parseIngredientSection('Wheat flour, skimmed milk powder, soya lecithin, peanut oil');
    expect(result.allergens).toEqual(expect.arrayContaining(['milk', 'gluten', 'soy', 'peanuts']));
  });

  it('separates may-contain statements from ingredients', () => {
    const result = parseIngredientSection('Sugar, palm oil. May contain: milk, nuts.');
    expect(result.cross_contamination_statements.length).toBeGreaterThan(0);
    expect(result.allergens).toContain('nuts');
  });

  it('returns detected:false with no items for an empty section', () => {
    const result = parseIngredientSection('   \n  ');
    expect(result.detected).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.allergens).toEqual([]);
  });

  it('never invents an ingredient when the section is unreadable', () => {
    const result = parseIngredientSection('||| ... |||');
    expect(result.detected).toBe(false);
    expect(result.items).toEqual([]);
  });
});

describe('scoreIngredientConfidence', () => {
  it('reports unknown confidence when no list was found', () => {
    const score = scoreIngredientConfidence({
      found: false,
      items: [],
      headingPresent: false,
      meanWordConfidence: null,
    });
    expect(score.confidence).toBeNull();
    expect(score.confidence_source).toBe('unknown');
  });

  it('scores higher with a heading, more items and good OCR', () => {
    const weak = scoreIngredientConfidence({
      found: true,
      items: [makeItem('sugar')],
      headingPresent: false,
      meanWordConfidence: 30,
    });
    const strong = scoreIngredientConfidence({
      found: true,
      items: Array.from({ length: 12 }, (_, i) => makeItem(`item ${i}`, i % 2 === 0 ? 'INS 621' : null)),
      headingPresent: true,
      meanWordConfidence: 90,
    });
    expect(strong.confidence!).toBeGreaterThan(weak.confidence!);
    expect(strong.confidence_source).toBe('derived');
    expect(strong.breakdown.heading).toBe(1);
  });
});

describe('detectAllergensInText', () => {
  it('recognises the FSSAI allergen names in a declaration line', () => {
    expect(detectAllergensInText('Allergens: Contains wheat, milk and soya.')).toEqual(
      expect.arrayContaining(['milk', 'gluten', 'soy']),
    );
  });

  it('returns nothing for an unrelated sentence', () => {
    expect(detectAllergensInText('Store in a cool place.')).toEqual([]);
  });
});

describe('parseNutritionSection', () => {
  it('parses an FSSAI-style panel with a per-100ml basis', () => {
    const section = [
      'Nutrition Information (per 100 ml)',
      'Protein 2.0 g',
      'Total Fat 1.5 g',
      'Total Carbohydrate 14.0 g',
      'of which Sugars 9.5 g',
      'Sodium 95 mg',
      'Calcium 110 mg',
      'Vitamin A 50 ug',
    ].join('\n');

    const result = parseNutritionSection(section, { heading: 'Nutrition Information', meanWordConfidence: 88 });

    expect(result.detected).toBe(true);
    expect(result.basis).toBe('per 100 ml');

    const byKey = Object.fromEntries(result.values.map((v) => [v.nutrient, v]));
    expect(byKey.protein?.value).toBe(2);
    expect(byKey.protein?.normalized_value).toBe(2);
    expect(byKey.protein?.unit).toBe('g');
    expect(byKey.total_fat?.normalized_value).toBe(1.5);
    expect(byKey.total_carbohydrate?.normalized_value).toBe(14);
    expect(byKey.sugars?.normalized_value).toBe(9.5);
    // mg kept, ug folded into the canonical µg unit.
    expect(byKey.sodium?.normalized_value).toBe(95);
    expect(byKey.sodium?.normalized_unit).toBe('mg');
    expect(byKey.vitamin_a?.normalized_value).toBe(50);
    expect(byKey.vitamin_a?.normalized_unit).toBe('µg');
  });

  it('converts energy from kJ to kcal', () => {
    const result = parseNutritionSection('Energy 418 kJ');
    expect(result.values[0]?.nutrient).toBe('energy');
    expect(result.values[0]?.normalized_value).toBe(99.9);
    expect(result.values[0]?.normalized_unit).toBe('kcal');
  });

  it('marks trace quantities instead of inventing a number', () => {
    const result = parseNutritionSection('Trans fat trace');
    expect(result.values[0]?.nutrient).toBe('trans_fat');
    expect(result.values[0]?.trace).toBe(true);
    expect(result.values[0]?.value).toBeNull();
  });

  it('reports undeciphered lines rather than dropping them', () => {
    const result = parseNutritionSection('Energy 60 kcal\nZzz qqq 1.2');
    expect(result.detected).toBe(true);
    expect(result.undecipheredLines).toContain('Zzz qqq 1.2');
  });

  it('returns detected:false when nothing can be read', () => {
    const result = parseNutritionSection('');
    expect(result.detected).toBe(false);
    expect(result.confidence).toBeNull();
    expect(result.confidence_source).toBe('unknown');
    expect(result.values).toEqual([]);
  });
});

describe('sections + product fields', () => {
  const labelText = [
    'Amul Taaza',
    'Toned Fresh Milk',
    'VEG',
    'Ingredients:',
    'Milk, Sugar, INS 621,',
    'Refined Palm Oil.',
    'Nutrition Information (per 100 ml)',
    'Protein 2.0 g',
    'Net Qty: 500 ml',
    'MRP Rs. 34.00 (Incl. of all taxes)',
    'FSSAI Lic. No. 10012051000123',
    'Best Before: 6 months from manufacturing',
    'Manufactured by: Amul Dairy, Anand, Gujarat',
    'Made in India',
  ].join('\n');

  it('finds the sections by heading', () => {
    const lines = labelText.split('\n');
    expect(findSection(lines, 'ingredients')?.heading).toBe('Ingredients:');
    expect(findSection(lines, 'nutrition')?.heading).toBe('Nutrition Information (per 100 ml)');
    expect(findSection(lines, 'net_quantity')).not.toBeNull();
    expect(findAllSections(lines).length).toBeGreaterThanOrEqual(4);
  });

  it('extracts the Indian regulatory fields with evidence', () => {
    const lines = labelText.split('\n');
    const info = extractProductInfo({
      text: labelText,
      sections: {
        net_quantity: { rawSection: findSection(lines, 'net_quantity')?.rawSection ?? '' },
        mrp: { rawSection: findSection(lines, 'mrp')?.rawSection ?? '' },
        fssai: { rawSection: findSection(lines, 'fssai')?.rawSection ?? '' },
        manufacturer: { rawSection: findSection(lines, 'manufacturer')?.rawSection ?? '' },
        best_before: { rawSection: findSection(lines, 'best_before')?.rawSection ?? '' },
      },
    });

    expect(info.net_quantity.value).toBe('500 ml');
    expect(info.net_quantity.evidence).toContain('Net Qty');
    expect(info.mrp.value).toEqual({ amount: 34, currency: 'INR' });
    expect(info.fssai_license.value).toBe('10012051000123');
    expect(info.veg_marker.value).toBe('vegetarian');
    expect(info.country_of_origin.value).toBe('India');
    expect(info.manufacturer.value).toBe('Amul Dairy, Anand, Gujarat');
    expect(info.best_before.value).toBe('6 months from manufacturing');
    expect(info.brand.value).toBeNull();
  });

  it('leaves every field unknown when the image has no text', () => {
    const info = extractProductInfo({ text: '', sections: {} });
    for (const field of [
      info.name,
      info.brand,
      info.net_quantity,
      info.mrp,
      info.fssai_license,
      info.veg_marker,
      info.manufacturer,
      info.best_before,
      info.country_of_origin,
    ]) {
      expect(field.value).toBeNull();
      expect(field.confidence).toBeNull();
      expect(field.confidence_source).toBe('unknown');
      expect(field.evidence).toBeNull();
    }
  });

  it('detects a veg marker and a non-veg marker from their symbols', () => {
    expect(detectVegMarker('a green square with a dot, VEG').type).toBe('vegetarian');
    expect(detectVegMarker('brown triangle, NON-VEG').type).toBe('non_vegetarian');
    expect(detectVegMarker('nothing relevant here').type).toBe('unknown');
  });
});