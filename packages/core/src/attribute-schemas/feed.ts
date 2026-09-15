import type { AttributeSchema } from './types.js';

export const feedSchema: AttributeSchema = {
  productType: 'Feed',
  attributes: [
    {
      key: 'feeding_rate_g_per_100kg_per_day',
      displayName: 'Feeding rate (g per 100 kg horse per day)',
      type: 'number',
      unit: 'g per 100 kg horse per day',
      promptGuidance:
        'The recommended daily feeding amount, normalised to grams per 100 kg of horse bodyweight per day. Only extract if the description states a rate; do not infer from category knowledge.',
    },
    {
      key: 'species',
      displayName: 'Species',
      type: 'enum',
      enumValues: ['horse', 'dog', 'cat', 'poultry', 'sheep', 'goat', 'alpaca'],
      promptGuidance:
        'The species the feed is formulated for. Extract only if the description or title names the species; the product being on an equine catalogue does not imply "horse".',
    },
    {
      key: 'life_stage',
      displayName: 'Life stage',
      type: 'enum',
      enumValues: ['senior', 'adult', 'growing', 'foal', 'veteran', 'all'],
      promptGuidance:
        'The life stage the feed is intended for. "Senior" and "veteran" are distinct here — extract exactly what the description says.',
    },
    {
      key: 'pack_size_kg',
      displayName: 'Pack size (kg)',
      type: 'number',
      unit: 'kg',
      promptGuidance:
        'The pack weight in kilograms. Take from the title or the variant options if present.',
    },
    {
      key: 'form',
      displayName: 'Form',
      type: 'enum',
      enumValues: ['mix', 'pellet', 'cube', 'mash', 'balancer', 'chaff', 'meal'],
      promptGuidance:
        'The physical form of the feed. Extract from the title or description; the product image or brand alone is not evidence.',
    },
  ],
};
