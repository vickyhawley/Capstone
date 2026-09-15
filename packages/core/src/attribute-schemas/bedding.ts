import { commonAttributes } from './common.js';
import type { AttributeSchema } from './types.js';

export const beddingSchema: AttributeSchema = {
  productType: 'Bedding',
  attributes: [
    ...commonAttributes,
    {
      key: 'material',
      displayName: 'Material',
      type: 'enum',
      enumValues: ['shavings', 'straw', 'hemp', 'cardboard', 'pellet', 'flax', 'other'],
      promptGuidance:
        'The bedding material. Prefer the specific value ("shavings", "pellet") over "other". Only use "other" if the description names a material outside this list.',
    },
    {
      key: 'bale_size',
      displayName: 'Bale size',
      type: 'string',
      promptGuidance:
        'The bale size as stated (e.g. "20 kg", "550 L", "medium"). Free-text because units vary; a later ADR may normalise.',
    },
    {
      key: 'dust_extracted',
      displayName: 'Dust extracted',
      type: 'boolean',
      promptGuidance:
        'True iff the description states the bedding is dust-extracted or low-dust. Absence of a claim is null, not false.',
    },
    {
      key: 'intended_species',
      displayName: 'Intended species',
      type: 'enum',
      enumValues: ['horse', 'small_animal', 'poultry', 'other'],
      promptGuidance:
        'The species the bedding is intended for. Extract only if the description names it.',
    },
  ],
};
