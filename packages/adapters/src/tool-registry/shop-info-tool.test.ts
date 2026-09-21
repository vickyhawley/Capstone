/**
 * Unit tests for ShopInfoTool. Sprint 4 (2026-09-21).
 *
 * Covers the topic-hint validation, response-shape stability
 * (always returns full struct regardless of topic), and the
 * common failure modes on the port contract.
 */

import { describe, expect, it } from 'vitest';

import {
  ShopInfoTool,
  type ShopInfo,
  type ShopInfoResult,
} from './shop-info-tool.js';

const FIXTURE: ShopInfo = {
  phone: '01234 567890',
  messaging: 'WhatsApp on the same number',
  email: null,
  address: {
    locality: 'Testville',
    postcode: 'TE1',
    street: null,
  },
  openingHours: {
    monday: '9am – 5pm',
    tuesday: '9am – 5pm',
    wednesday: '9am – 5pm',
    thursday: '9am – 5pm',
    friday: '9am – 5pm',
    saturday: '10am – 3pm',
    sunday: '10am – 2pm',
  },
  bankHolidays: 'Open on bank holidays',
  howToOrder: ['Phone during hours', 'WhatsApp any time'],
  deliverySummary: 'Free within 20 miles',
  subscriptionDelivery: {
    description: 'Regular delivery available for feed, bedding, haylage',
    eligibleTypes: ['Feed', 'Bedding', 'Haylage'],
  },
};

describe('ShopInfoTool', () => {
  describe('list()', () => {
    it('advertises exactly one tool, named logistics.shop_info', () => {
      const tool = new ShopInfoTool(FIXTURE);
      const defs = tool.list();
      expect(defs).toHaveLength(1);
      expect(defs[0]?.name).toBe('logistics.shop_info');
    });

    it('advertises topic enum in the schema', () => {
      const tool = new ShopInfoTool(FIXTURE);
      const schema = tool.list()[0]?.schema as {
        properties?: { topic?: { enum?: string[] } };
      };
      expect(schema.properties?.topic?.enum).toEqual([
        'contact',
        'hours',
        'address',
        'ordering',
      ]);
    });
  });

  describe('invoke() — response shape', () => {
    it('returns the full info struct regardless of topic', async () => {
      const tool = new ShopInfoTool(FIXTURE);
      const result = await tool.invoke({
        name: 'logistics.shop_info',
        args: { topic: 'contact' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as ShopInfoResult;
      expect(value.info).toEqual(FIXTURE);
      expect(value.topic).toBe('contact');
    });

    it('accepts no args and returns null topic', async () => {
      const tool = new ShopInfoTool(FIXTURE);
      const result = await tool.invoke({
        name: 'logistics.shop_info',
        args: {},
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as ShopInfoResult;
      expect(value.topic).toBeNull();
      expect(value.info).toEqual(FIXTURE);
    });

    it('surfaces all four topic hints without altering payload', async () => {
      const tool = new ShopInfoTool(FIXTURE);
      for (const topic of ['contact', 'hours', 'address', 'ordering'] as const) {
        const result = await tool.invoke({
          name: 'logistics.shop_info',
          args: { topic },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const value = result.value as ShopInfoResult;
        expect(value.topic).toBe(topic);
        expect(value.info).toEqual(FIXTURE);
      }
    });
  });

  describe('invoke() — argument validation', () => {
    it('rejects unknown topic value', async () => {
      const tool = new ShopInfoTool(FIXTURE);
      const result = await tool.invoke({
        name: 'logistics.shop_info',
        args: { topic: 'unknown-topic' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('topic must be one of');
    });

    it('rejects non-string topic', async () => {
      const tool = new ShopInfoTool(FIXTURE);
      const result = await tool.invoke({
        name: 'logistics.shop_info',
        args: { topic: 42 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('must be a string');
    });

    it('rejects wrong tool name', async () => {
      const tool = new ShopInfoTool(FIXTURE);
      const result = await tool.invoke({
        name: 'not.this.tool',
        args: {},
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('tool not found');
    });
  });
});
