/**
 * Unit tests for RouteBasedPlanner. Sprint 4 opener.
 *
 * Covers every row of the dispatch table in the file header + the
 * idempotency property (same context in → same decision out) that
 * matters when the tool loop retries under transient state.
 */

import type {
  PlannerContext,
  RouterDecision,
  ToolInvocation,
  ToolInvocationRecord,
  ToolResult,
} from '@groundwork/core';
import { describe, expect, it } from 'vitest';

import { RouteBasedPlanner } from './route-based-planner.js';

function makeContext(
  overrides: {
    readonly intent?: RouterDecision['intent'];
    readonly productQuery?: string;
    readonly postcode?: string;
    readonly toolResults?: readonly ToolInvocationRecord[];
  } = {},
): PlannerContext {
  const decision: RouterDecision = {
    intent: overrides.intent ?? 'product',
    confidence: 1.0,
    rationale: 'test',
    matched: 'llm',
    adversarialSuspected: false,
    ...(overrides.productQuery !== undefined ? { productQuery: overrides.productQuery } : {}),
    ...(overrides.postcode !== undefined ? { postcode: overrides.postcode } : {}),
  };
  return {
    query: { text: 'test query' },
    routerDecision: decision,
    retrievedChunks: [],
    toolResults: overrides.toolResults ?? [],
    iteration: (overrides.toolResults ?? []).length,
  };
}

function toolRecord(name: string, result: ToolResult, args: Record<string, unknown> = {}): ToolInvocationRecord {
  const call: ToolInvocation = { name, args };
  return { call, result, durationMs: 10 };
}

describe('RouteBasedPlanner', () => {
  describe('product intent', () => {
    it('iter 0: dispatches stock_lookup with the productQuery', async () => {
      const p = new RouteBasedPlanner();
      const decision = await p.plan(makeContext({ intent: 'product', productQuery: 'haynets' }));
      expect(decision.kind).toBe('call-tool');
      if (decision.kind !== 'call-tool') return;
      expect(decision.toolCall.name).toBe('product.stock_lookup');
      expect(decision.toolCall.args).toEqual({ productQuery: 'haynets' });
    });

    it('iter 0 with no productQuery: done (nothing to dispatch)', async () => {
      const p = new RouteBasedPlanner();
      const decision = await p.plan(makeContext({ intent: 'product' }));
      expect(decision.kind).toBe('done');
      if (decision.kind !== 'done') return;
      expect(decision.rationale).toContain('no productQuery');
    });

    it('iter 1 after stock exact: done (no substitute needed)', async () => {
      const p = new RouteBasedPlanner();
      const toolResults = [
        toolRecord('product.stock_lookup', { ok: true, value: { status: 'exact' } }),
      ];
      const decision = await p.plan(
        makeContext({ intent: 'product', productQuery: 'haynets', toolResults }),
      );
      expect(decision.kind).toBe('done');
    });

    it('iter 1 after stock pending: done (no substitute needed)', async () => {
      const p = new RouteBasedPlanner();
      const toolResults = [
        toolRecord('product.stock_lookup', { ok: true, value: { status: 'pending' } }),
      ];
      const decision = await p.plan(
        makeContext({ intent: 'product', productQuery: 'wormers', toolResults }),
      );
      expect(decision.kind).toBe('done');
    });

    it('iter 1 after stock orderable: dispatches substitute_lookup', async () => {
      const p = new RouteBasedPlanner();
      const toolResults = [
        toolRecord('product.stock_lookup', { ok: true, value: { status: 'orderable' } }),
      ];
      const decision = await p.plan(
        makeContext({
          intent: 'product',
          productQuery: 'haygates conditioning cubes',
          toolResults,
        }),
      );
      expect(decision.kind).toBe('call-tool');
      if (decision.kind !== 'call-tool') return;
      expect(decision.toolCall.name).toBe('product.substitute_lookup');
      expect(decision.toolCall.args).toEqual({
        productQuery: 'haygates conditioning cubes',
        stockStatus: 'orderable',
      });
    });

    it('iter 1 after stock unavailable: dispatches substitute_lookup', async () => {
      const p = new RouteBasedPlanner();
      const toolResults = [
        toolRecord('product.stock_lookup', { ok: true, value: { status: 'unavailable' } }),
      ];
      const decision = await p.plan(
        makeContext({ intent: 'product', productQuery: 'lemieux', toolResults }),
      );
      expect(decision.kind).toBe('call-tool');
      if (decision.kind !== 'call-tool') return;
      expect(decision.toolCall.args).toEqual({
        productQuery: 'lemieux',
        stockStatus: 'unavailable',
      });
    });

    it('iter 1 after stock_lookup failed: done (do not compound)', async () => {
      const p = new RouteBasedPlanner();
      const toolResults = [
        toolRecord('product.stock_lookup', { ok: false, error: 'boom', retryable: false }),
      ];
      const decision = await p.plan(
        makeContext({ intent: 'product', productQuery: 'haynets', toolResults }),
      );
      expect(decision.kind).toBe('done');
      if (decision.kind !== 'done') return;
      expect(decision.rationale).toContain('failed');
    });

    it('iter 2 after both tools ran: done', async () => {
      const p = new RouteBasedPlanner();
      const toolResults = [
        toolRecord('product.stock_lookup', { ok: true, value: { status: 'orderable' } }),
        toolRecord('product.substitute_lookup', { ok: true, value: { substitutes: [] } }),
      ];
      const decision = await p.plan(
        makeContext({ intent: 'product', productQuery: 'haynets', toolResults }),
      );
      expect(decision.kind).toBe('done');
    });
  });

  describe('logistics intent', () => {
    it('iter 0 with postcode: dispatches delivery_zone', async () => {
      const p = new RouteBasedPlanner();
      const decision = await p.plan(makeContext({ intent: 'logistics', postcode: 'BH24' }));
      expect(decision.kind).toBe('call-tool');
      if (decision.kind !== 'call-tool') return;
      expect(decision.toolCall.name).toBe('logistics.delivery_zone');
      expect(decision.toolCall.args).toEqual({ postcode: 'BH24' });
    });

    it('iter 0 with no postcode: done', async () => {
      const p = new RouteBasedPlanner();
      const decision = await p.plan(makeContext({ intent: 'logistics' }));
      expect(decision.kind).toBe('done');
      if (decision.kind !== 'done') return;
      expect(decision.rationale).toContain('no postcode');
    });

    it('iter 1 after delivery_zone: done (single-tool dispatch)', async () => {
      const p = new RouteBasedPlanner();
      const toolResults = [
        toolRecord('logistics.delivery_zone', {
          ok: true,
          value: { status: 'within_radius' },
        }),
      ];
      const decision = await p.plan(
        makeContext({ intent: 'logistics', postcode: 'BH24', toolResults }),
      );
      expect(decision.kind).toBe('done');
    });
  });

  describe('other intents', () => {
    // These are safety-gate-short-circuited to escalate/abstain
    // before the loop even runs, but the planner has to behave
    // sanely if invoked anyway (defence-in-depth).
    it.each([
      ['fit'],
      ['welfare-clinical'],
      ['out-of-scope'],
      ['service-referral'],
    ] as const)('%s intent: done (no Tier-1 dispatch)', async ([intent]) => {
      const p = new RouteBasedPlanner();
      const decision = await p.plan(makeContext({ intent }));
      expect(decision.kind).toBe('done');
    });
  });

  describe('idempotency', () => {
    it('same context in → same decision out (no hidden state)', async () => {
      const p = new RouteBasedPlanner();
      const context = makeContext({ intent: 'product', productQuery: 'haynets' });
      const first = await p.plan(context);
      const second = await p.plan(context);
      expect(first).toEqual(second);
    });
  });
});
