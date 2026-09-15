import type { AttributeDefinition } from './types.js';

/**
 * Attributes that appear on every product-type schema. `colour` is the
 * ground-truth carrier for the ADR-0004 metafield-agreement check (109
 * products across many types have the colour metafield populated).
 *
 * Kept as a plain readonly array rather than a re-usable schema so each
 * type's schema still owns its full attribute list — the composition
 * happens at schema-definition time, not at read time. That keeps the
 * registry data-only and each schema self-contained.
 */
export const commonAttributes: readonly AttributeDefinition[] = [
  {
    key: 'colour',
    displayName: 'Colour',
    type: 'string',
    promptGuidance:
      'The product colour as stated. Only extract if the description or title names a colour; a product image alone is not evidence. Use the term the description uses (navy, tan, etc.), do not normalise.',
  },
];
