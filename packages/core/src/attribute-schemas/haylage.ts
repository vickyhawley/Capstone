import { commonAttributes } from './common.js';
import type { AttributeSchema } from './types.js';

export const haylageSchema: AttributeSchema = {
  productType: 'Haylage',
  attributes: [
    ...commonAttributes,
    {
      key: 'cut_type',
      displayName: 'Cut type',
      type: 'enum',
      enumValues: ['timothy', 'ryegrass', 'meadow', 'alfalfa', 'high_fibre', 'low_sugar', 'other'],
      promptGuidance:
        'The grass/cut type. "High fibre" and "low sugar" are formulation categories used interchangeably with cut types in this catalogue.',
    },
    {
      key: 'bale_weight_kg',
      displayName: 'Bale weight (kg)',
      type: 'number',
      unit: 'kg',
      promptGuidance:
        'Bale weight in kilograms. Take from the title or description; do not infer from bale-size categories.',
    },
    {
      key: 'moisture_profile',
      displayName: 'Moisture profile',
      type: 'enum',
      enumValues: ['dry', 'standard', 'wet'],
      promptGuidance:
        'The moisture profile if stated. "Dry" here means low-moisture haylage marketed as such; do not label untagged haylage as "standard" by default.',
    },
  ],
};
