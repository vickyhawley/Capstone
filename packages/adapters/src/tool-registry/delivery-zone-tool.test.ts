/**
 * Unit tests for DeliveryZoneTool. GW-21 (2026-09-18).
 *
 * Covers the two-state decision (within_radius / defer_to_staff),
 * postcode normalisation (case, whitespace, full-vs-outward), the
 * three defer_to_staff sub-shapes (beyond-radius, unknown district,
 * unparseable input), and structured-error paths for arg validation.
 */

import { describe, expect, it } from 'vitest';

import {
  DeliveryZoneTool,
  type DeliveryZoneResult,
  type DistrictEntry,
  extractOutwardCode,
} from './delivery-zone-tool.js';

// Test fixtures — invented for tests, not copied from the real
// delivery-districts.yaml (eval-hygiene rule; same as GW-20's tool
// tests use TestBrandA/B rather than Ariat/LeMieux).
const DISTRICTS: readonly DistrictEntry[] = [
  { postcode: 'TE1', locality: 'Testcastle', distanceMiles: 3, withinRadius: true },
  { postcode: 'TE2', locality: 'Testcastle Outer', distanceMiles: 18, withinRadius: true },
  { postcode: 'FR3', locality: 'Farsville', distanceMiles: 30, withinRadius: false },
];

describe('DeliveryZoneTool', () => {
  describe('list()', () => {
    it('advertises exactly one tool, named logistics.delivery_zone', () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const defs = tool.list();
      expect(defs).toHaveLength(1);
      expect(defs[0]?.name).toBe('logistics.delivery_zone');
    });

    it('requires postcode in the args schema', () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const schema = tool.list()[0]?.schema as { required?: string[] };
      expect(schema.required).toContain('postcode');
    });
  });

  describe('invoke() — two-state decision', () => {
    it('returns WITHIN_RADIUS for a known in-radius district', async () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: 'TE1' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as DeliveryZoneResult;
      expect(value.status).toBe('within_radius');
      expect(value.postcode).toBe('TE1');
      expect(value.matchedDistrict?.locality).toBe('Testcastle');
      expect(value.reason).toContain('within the stated 20-mile radius');
    });

    it('returns DEFER_TO_STAFF for a known beyond-radius district', async () => {
      // Sub-shape: district is in the list, but its within_radius
      // flag is false. Populate matchedDistrict for observability.
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: 'FR3' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as DeliveryZoneResult;
      expect(value.status).toBe('defer_to_staff');
      expect(value.postcode).toBe('FR3');
      expect(value.matchedDistrict?.locality).toBe('Farsville');
      expect(value.reason).toContain('beyond the stated 20-mile radius');
    });

    it('returns DEFER_TO_STAFF for an unknown but well-formed postcode', async () => {
      // Sub-shape: parseable outward code, not in the district list.
      // The tool defers rather than refuses — see file header.
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: 'ZZ99' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as DeliveryZoneResult;
      expect(value.status).toBe('defer_to_staff');
      expect(value.postcode).toBe('ZZ99');
      expect(value.matchedDistrict).toBeNull();
      expect(value.reason).toContain('not in the curated district list');
    });

    it('returns DEFER_TO_STAFF for unparseable input rather than a structured error', async () => {
      // The tool's whole job is never to be the first thing to
      // refuse. Unparseable input is very likely a real customer
      // whose address didn't match the regex. Fall through with a
      // reason naming the parse failure.
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: 'not-a-postcode' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as DeliveryZoneResult;
      expect(value.status).toBe('defer_to_staff');
      expect(value.postcode).toBe('');
      expect(value.matchedDistrict).toBeNull();
      expect(value.reason).toContain('did not parse');
    });
  });

  describe('postcode normalisation', () => {
    it('is case-insensitive', async () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: 'te1' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as DeliveryZoneResult).status).toBe('within_radius');
    });

    it('accepts a full postcode by extracting the outward code', async () => {
      // Customer types "BH24 1AA" — outward-code lookup on the
      // "BH24" prefix. The rest is discarded.
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: 'TE1 9XY' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as DeliveryZoneResult;
      expect(value.status).toBe('within_radius');
      expect(value.postcode).toBe('TE1');
    });

    it('tolerates surrounding whitespace', async () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: '  TE1  ' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as DeliveryZoneResult).status).toBe('within_radius');
    });
  });

  describe('extractOutwardCode helper', () => {
    it('handles all UK outward-code shapes', () => {
      expect(extractOutwardCode('B1')).toBe('B1');
      expect(extractOutwardCode('B1A')).toBe('B1A');
      expect(extractOutwardCode('B99')).toBe('B99');
      expect(extractOutwardCode('BH1')).toBe('BH1');
      expect(extractOutwardCode('BH24')).toBe('BH24');
      expect(extractOutwardCode('BH1A')).toBe('BH1A');
    });

    it('strips inward code from a full postcode', () => {
      expect(extractOutwardCode('BH24 1AA')).toBe('BH24');
      expect(extractOutwardCode('SW1A 1AA')).toBe('SW1A');
    });

    it('returns null for garbage', () => {
      expect(extractOutwardCode('not a postcode')).toBeNull();
      expect(extractOutwardCode('123')).toBeNull();
      expect(extractOutwardCode('')).toBeNull();
    });
  });

  describe('argument validation', () => {
    it('rejects empty postcode', async () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: '' },
      });
      expect(result.ok).toBe(false);
    });

    it('rejects overlong postcode', async () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'logistics.delivery_zone',
        args: { postcode: 'A'.repeat(64) },
      });
      expect(result.ok).toBe(false);
    });

    it('rejects calls with the wrong tool name', async () => {
      const tool = new DeliveryZoneTool(DISTRICTS);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { postcode: 'TE1' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('tool not found');
    });
  });
});
