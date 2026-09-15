import { describe, expect, it } from 'vitest';

import { getAttributeSchema, listAttributeSchemas } from './index.js';

describe('attribute schema registry', () => {
  it('returns null for an unknown product type', () => {
    expect(getAttributeSchema('Nonexistent')).toBeNull();
  });

  it('returns a schema for every registered type', () => {
    for (const schema of listAttributeSchemas()) {
      expect(getAttributeSchema(schema.productType)).toBe(schema);
    }
  });

  it('has no schema with zero attributes', () => {
    for (const schema of listAttributeSchemas()) {
      expect(schema.attributes.length).toBeGreaterThan(0);
    }
  });

  it('has unique attribute keys within each schema', () => {
    for (const schema of listAttributeSchemas()) {
      const keys = schema.attributes.map((attr) => attr.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('provides prompt guidance for every attribute', () => {
    for (const schema of listAttributeSchemas()) {
      for (const attr of schema.attributes) {
        expect(attr.promptGuidance.length).toBeGreaterThan(0);
      }
    }
  });

  it('has enumValues iff type is enum', () => {
    for (const schema of listAttributeSchemas()) {
      for (const attr of schema.attributes) {
        if (attr.type === 'enum') {
          expect(attr.enumValues).toBeDefined();
          expect(attr.enumValues?.length).toBeGreaterThan(0);
        } else {
          expect(attr.enumValues).toBeUndefined();
        }
      }
    }
  });
});
