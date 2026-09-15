import { commonAttributes } from './common.js';
import type { AttributeSchema } from './types.js';

/**
 * Matches the catalogue's `Outdoor Rugs` product type (turnouts for
 * horses). Rider outerwear — Equidry jackets, coats, gilets — is
 * catalogued under `Equestrian Clothing` and needs its own schema
 * before those products can be extracted against. Sprint 2 candidate.
 */
export const outerwearSchema: AttributeSchema = {
  productType: 'Outdoor Rugs',
  attributes: [
    ...commonAttributes,
    {
      key: 'waterproof_mm',
      displayName: 'Waterproof rating (mm)',
      type: 'number',
      unit: 'mm',
      promptGuidance:
        'Waterproof rating in millimetres (hydrostatic head). Extract only if the description states a numeric mm value; do not infer from "waterproof" alone.',
    },
    {
      key: 'breathability_g_per_m2_24hr',
      displayName: 'Breathability (g/m²/24hr)',
      type: 'number',
      unit: 'g/m²/24hr',
      promptGuidance:
        'Breathability in grams per square metre per 24 hours. Only extract a stated number; do not infer from "breathable".',
    },
    {
      key: 'insulation_g',
      displayName: 'Insulation (g fill)',
      type: 'number',
      unit: 'g',
      promptGuidance:
        'Fill weight in grams (e.g. 200 g, 340 g). Only extract if the description names the fill weight — "heavyweight" alone is not evidence of a specific number.',
    },
    {
      key: 'fit',
      displayName: 'Fit',
      type: 'enum',
      enumValues: ['turnout', 'stable', 'travel', 'cooler', 'fly'],
      promptGuidance:
        'The intended use pattern of the rug or jacket. Extract from the title or description; a "turnout" rug is not necessarily "waterproof".',
    },
  ],
};
