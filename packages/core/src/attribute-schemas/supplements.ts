import { commonAttributes } from './common.js';
import type { AttributeSchema } from './types.js';

export const supplementsSchema: AttributeSchema = {
  productType: 'Supplements',
  attributes: [
    ...commonAttributes,
    {
      key: 'target_concern',
      displayName: 'Target concern',
      type: 'enum',
      enumValues: [
        'joints',
        'hooves',
        'coat',
        'gut',
        'respiratory',
        'calmer',
        'electrolytes',
        'immune',
        'muscle',
        'weight',
        'other',
      ],
      promptGuidance:
        'The primary health concern the supplement targets, as marketed. If the description names more than one, take the one most prominent in the title.',
    },
    {
      key: 'active_ingredients',
      displayName: 'Active ingredients',
      type: 'string',
      promptGuidance:
        'The active ingredients as a comma-separated list, exactly as named in the description. Not a normalised list — the source-span must match.',
    },
    {
      key: 'daily_dose_g',
      displayName: 'Daily dose (g)',
      type: 'number',
      unit: 'g',
      promptGuidance:
        'The daily dose in grams. Convert scoops to grams only if the description states scoop weight; otherwise leave null.',
    },
    {
      key: 'pack_duration_days',
      displayName: 'Pack duration (days)',
      type: 'number',
      unit: 'days',
      promptGuidance:
        'How long the pack lasts at the stated dose. Only extract if the description states duration explicitly.',
    },
    {
      key: 'form',
      displayName: 'Form',
      type: 'enum',
      enumValues: ['powder', 'liquid', 'paste', 'cube', 'chew'],
      promptGuidance: 'The physical form of the supplement. Extract from the title or description.',
    },
  ],
};
