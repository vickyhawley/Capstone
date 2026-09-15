import { describe, expect, it } from 'vitest';

import { renderVariantTable } from './render-variant-table.js';

describe('renderVariantTable', () => {
  it('returns empty string for no rows', () => {
    expect(renderVariantTable([])).toBe('');
  });

  it('renders header, separator, and one row per variant', () => {
    const result = renderVariantTable([
      { optionName: 'Size', optionValue: '17"', sku: 'SDL-17', price: 950 },
      { optionName: 'Size', optionValue: '17.5"', sku: 'SDL-175', price: 950 },
    ]);
    expect(result).toMatchInlineSnapshot(`
      "Size | SKU | Price
      - | - | -
      17" | SDL-17 | £950.00
      17.5" | SDL-175 | £950.00"
    `);
  });

  it('replaces blank option values with (default)', () => {
    const result = renderVariantTable([
      { optionName: 'Title', optionValue: '', sku: 'HB-STD', price: 12 },
    ]);
    expect(result).toContain('(default)');
    expect(result).not.toContain(' |  |');
  });

  it('renders null price as em-dash', () => {
    const result = renderVariantTable([
      { optionName: 'Colour', optionValue: 'Navy', sku: 'RUG-N', price: null },
    ]);
    expect(result).toContain('—');
    expect(result).not.toContain('£');
  });
});
