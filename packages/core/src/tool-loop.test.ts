/**
 * Unit tests for the tool loop. GW-18, ADR-0014.
 *
 * Every test uses inline fakes rather than the shipped adapters so the
 * loop's behaviour is measured in isolation. Termination signals,
 * error handling, trace emission, and budget-awareness all have named
 * tests — a regression in any of them is caught here rather than
 * end-to-end.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Planner, PlannerContext, PlannerDecision } from './ports/planner.js';
import type { RouterDecision, RouterQuery } from './ports/router.js';
import type { ToolInvocation, ToolRegistry, ToolResult } from './ports/tool-registry.js';
import type { Span, TraceSink } from './ports/trace-sink.js';
import { runToolLoop } from './tool-loop.js';

// ---------- fixtures ----------

const testQuery: RouterQuery = { text: 'do you sell haynets' };
const testDecision: RouterDecision = {
  intent: 'product',
  confidence: 1.0,
  rationale: 'test',
  matched: 'rule',
  adversarialSuspected: false,
};

function makePlanner(decisions: PlannerDecision[]): Planner {
  let i = 0;
  return {
    async plan(_c: PlannerContext): Promise<PlannerDecision> {
      const next = decisions[i] ?? { kind: 'done' as const, rationale: 'no more decisions queued' };
      i += 1;
      return next;
    },
  };
}

function makeRegistry(results: ToolResult[]): ToolRegistry {
  let i = 0;
  return {
    list() {
      return [];
    },
    async invoke(_call: ToolInvocation, _signal?: AbortSignal): Promise<ToolResult> {
      const next = results[i] ?? {
        ok: false as const,
        error: 'no more results queued',
        retryable: false,
      };
      i += 1;
      return next;
    },
  };
}

function makeSpySink(): { sink: TraceSink; spans: Span[] } {
  const spans: Span[] = [];
  return {
    sink: {
      async record(span: Span) {
        spans.push(span);
      },
    },
    spans,
  };
}

const noopSink: TraceSink = { async record() {} };

function makeClock(sequence: number[]): () => number {
  let i = 0;
  return () => {
    const next = sequence[i] ?? sequence[sequence.length - 1] ?? 0;
    i += 1;
    return next;
  };
}

const baseInput = {
  query: testQuery,
  routerDecision: testDecision,
  retrievedChunks: [],
  traceId: 'trace-1',
};

// ---------- planner-done termination ----------

describe('runToolLoop — planner-done termination', () => {
  it('terminates immediately when planner says done', async () => {
    const result = await runToolLoop(
      {
        planner: makePlanner([{ kind: 'done', rationale: 'nothing to do' }]),
        toolRegistry: makeRegistry([]),
        traceSink: noopSink,
      },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(result.terminatedBy).toBe('planner-done');
    expect(result.iterationsUsed).toBe(1);
    expect(result.toolInvocations).toHaveLength(0);
  });

  it('terminates on planner-done after a tool call', async () => {
    const result = await runToolLoop(
      {
        planner: makePlanner([
          { kind: 'call-tool', toolCall: { name: 'lookup', args: {} } },
          { kind: 'done' },
        ]),
        toolRegistry: makeRegistry([{ ok: true, value: 'looked-up' }]),
        traceSink: noopSink,
      },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(result.terminatedBy).toBe('planner-done');
    expect(result.iterationsUsed).toBe(2);
    expect(result.toolInvocations).toHaveLength(1);
    expect(result.toolInvocations[0]?.result).toEqual({ ok: true, value: 'looked-up' });
  });
});

// ---------- iteration-bound termination ----------

describe('runToolLoop — iteration-bound termination', () => {
  it('stops at maxIterations even if planner keeps requesting tools', async () => {
    const planner = makePlanner(
      Array.from({ length: 20 }, () => ({
        kind: 'call-tool' as const,
        toolCall: { name: 't', args: {} },
      })),
    );
    const registry = makeRegistry(
      Array.from({ length: 20 }, () => ({ ok: true as const, value: null })),
    );
    const result = await runToolLoop(
      { planner, toolRegistry: registry, traceSink: noopSink },
      baseInput,
      { maxIterations: 3, timeBudgetMs: 25_000 },
    );
    expect(result.terminatedBy).toBe('iteration-bound');
    expect(result.iterationsUsed).toBe(3);
    expect(result.toolInvocations).toHaveLength(3);
  });

  it('maxIterations = 0 terminates without asking the planner', async () => {
    const planSpy = vi.fn().mockResolvedValue({ kind: 'done' as const });
    await runToolLoop(
      {
        planner: { plan: planSpy },
        toolRegistry: makeRegistry([]),
        traceSink: noopSink,
      },
      baseInput,
      { maxIterations: 0, timeBudgetMs: 25_000 },
    );
    expect(planSpy).not.toHaveBeenCalled();
  });
});

// ---------- budget-aware early exit ----------

describe('runToolLoop — budget-aware early exit', () => {
  it("doesn't start an iteration it can't afford", async () => {
    // Clock sequence: start=0, iter0-pre=0 (budget check: 25000 remaining, need 2000 -> OK),
    // iter0 tool start=100, tool end=8100 (duration 8000),
    // iter1-pre=8100 (budget check: 16900 remaining, need 8000 -> OK),
    // iter1 tool start=8200, tool end=16200 (duration 8000),
    // iter2-pre=16200 (budget check: 8800 remaining, avg=8000 -> OK),
    // iter2 tool start=16300, tool end=24300 (duration 8000),
    // iter3-pre=24300 (budget check: 700 remaining, avg=8000 -> BREAK).
    const clock = makeClock([
      0, 0, 100, 8100, 8100, 8200, 16200, 16200, 16300, 24300, 24300, 24300,
    ]);
    const planner = makePlanner([
      { kind: 'call-tool', toolCall: { name: 't', args: {} } },
      { kind: 'call-tool', toolCall: { name: 't', args: {} } },
      { kind: 'call-tool', toolCall: { name: 't', args: {} } },
      { kind: 'call-tool', toolCall: { name: 't', args: {} } },
    ]);
    const registry = makeRegistry([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
      { ok: true, value: 3 },
      { ok: true, value: 4 },
    ]);
    const result = await runToolLoop(
      { planner, toolRegistry: registry, traceSink: noopSink, clock },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000, firstIterationEstimateMs: 2_000 },
    );
    expect(result.terminatedBy).toBe('budget-aware');
    expect(result.iterationsUsed).toBe(3);
    expect(result.toolInvocations).toHaveLength(3);
  });

  it('uses firstIterationEstimateMs as floor before any samples', async () => {
    // First iteration hasn't run yet. remaining=1000, floor=2000 -> break.
    const clock = makeClock([0, 0]);
    const planSpy = vi.fn().mockResolvedValue({ kind: 'done' as const });
    const result = await runToolLoop(
      { planner: { plan: planSpy }, toolRegistry: makeRegistry([]), traceSink: noopSink, clock },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 1_000, firstIterationEstimateMs: 2_000 },
    );
    expect(result.terminatedBy).toBe('budget-aware');
    expect(planSpy).not.toHaveBeenCalled();
  });
});

// ---------- timeout-backstop termination ----------

describe('runToolLoop — timeout-backstop termination', () => {
  it('breaks between iterations when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const planSpy = vi.fn().mockResolvedValue({ kind: 'done' as const });
    const result = await runToolLoop(
      { planner: { plan: planSpy }, toolRegistry: makeRegistry([]), traceSink: noopSink },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000, signal: controller.signal },
    );
    expect(result.terminatedBy).toBe('timeout-backstop');
    expect(planSpy).not.toHaveBeenCalled();
  });

  it('breaks after a tool call if the signal fired during the tool', async () => {
    const controller = new AbortController();
    const planner = makePlanner([
      { kind: 'call-tool', toolCall: { name: 't', args: {} } },
      { kind: 'call-tool', toolCall: { name: 't', args: {} } },
    ]);
    const registry: ToolRegistry = {
      list: () => [],
      async invoke() {
        controller.abort();
        return { ok: true, value: 'done' };
      },
    };
    const result = await runToolLoop(
      { planner, toolRegistry: registry, traceSink: noopSink },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000, signal: controller.signal },
    );
    expect(result.terminatedBy).toBe('timeout-backstop');
    expect(result.iterationsUsed).toBe(1);
    expect(result.toolInvocations).toHaveLength(1);
  });
});

// ---------- error handling ----------

describe('runToolLoop — tool errors', () => {
  it('appends ok:false result and continues (never itself retries)', async () => {
    const planner = makePlanner([
      { kind: 'call-tool', toolCall: { name: 't1', args: {} } },
      { kind: 'call-tool', toolCall: { name: 't2', args: {} } },
      { kind: 'done' },
    ]);
    const registry = makeRegistry([
      { ok: false, error: 'temporary failure', retryable: true },
      { ok: true, value: 'ok this time' },
    ]);
    const result = await runToolLoop(
      { planner, toolRegistry: registry, traceSink: noopSink },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(result.terminatedBy).toBe('planner-done');
    expect(result.toolInvocations).toHaveLength(2);
    expect(result.toolInvocations[0]?.result.ok).toBe(false);
    expect(result.toolInvocations[1]?.result.ok).toBe(true);
  });

  it('converts a throw from tool registry into a structured error result', async () => {
    // The port contract says invoke returns a ToolResult rather than
    // throwing, but a misbehaving adapter shouldn't kill the loop.
    const registry: ToolRegistry = {
      list: () => [],
      async invoke() {
        throw new Error('adapter blew up');
      },
    };
    const result = await runToolLoop(
      {
        planner: makePlanner([
          { kind: 'call-tool', toolCall: { name: 't', args: {} } },
          { kind: 'done' },
        ]),
        toolRegistry: registry,
        traceSink: noopSink,
      },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(result.toolInvocations).toHaveLength(1);
    const result0 = result.toolInvocations[0]?.result;
    expect(result0?.ok).toBe(false);
    if (result0 && result0.ok === false) {
      expect(result0.error).toBe('adapter blew up');
      expect(result0.retryable).toBe(false);
    }
  });

  it('planner throws propagate (infra failure, not planner-context)', async () => {
    const planner: Planner = {
      async plan() {
        throw new Error('LLM API 500');
      },
    };
    await expect(
      runToolLoop({ planner, toolRegistry: makeRegistry([]), traceSink: noopSink }, baseInput, {
        maxIterations: 8,
        timeBudgetMs: 25_000,
      }),
    ).rejects.toThrow('LLM API 500');
  });
});

// ---------- trace emission ----------

describe('runToolLoop — trace emission', () => {
  it('emits one tool-call span per invocation with the expected attributes', async () => {
    const { sink, spans } = makeSpySink();
    await runToolLoop(
      {
        planner: makePlanner([
          {
            kind: 'call-tool',
            toolCall: { name: 'stock-lookup', args: { handle: 'aubiose' } },
            rationale: 'product intent, extract handle',
          },
          { kind: 'done' },
        ]),
        toolRegistry: makeRegistry([{ ok: true, value: { in_stock: true } }]),
        traceSink: sink,
      },
      { ...baseInput, parentSpanId: 'parent-1' },
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (!span) throw new Error('expected a span');
    expect(span.kind).toBe('tool-call');
    expect(span.traceId).toBe('trace-1');
    expect(span.parentSpanId).toBe('parent-1');
    expect(span.attributes['tool_name']).toBe('stock-lookup');
    expect(span.attributes['iteration']).toBe(0);
    expect(span.attributes['ok']).toBe(true);
    expect(span.attributes['rationale']).toBe('product intent, extract handle');
    // ADR-0014 §Tracing is native + ADR-0016 §6 — span carries args
    // + value so a trace reader can reconstruct the invocation without
    // needing to re-run the tool.
    expect(span.attributes['args']).toEqual({ handle: 'aubiose' });
    expect(span.attributes['value']).toEqual({ in_stock: true });
  });

  it('trace-sink failure does not fail the loop (best-effort port contract)', async () => {
    const failingSink: TraceSink = {
      async record() {
        throw new Error('trace store unreachable');
      },
    };
    const result = await runToolLoop(
      {
        planner: makePlanner([
          { kind: 'call-tool', toolCall: { name: 't', args: {} } },
          { kind: 'done' },
        ]),
        toolRegistry: makeRegistry([{ ok: true, value: 'ok' }]),
        traceSink: failingSink,
      },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(result.terminatedBy).toBe('planner-done');
    expect(result.toolInvocations).toHaveLength(1);
  });

  it('failed tool result surfaces error + retryable in span attributes', async () => {
    const { sink, spans } = makeSpySink();
    await runToolLoop(
      {
        planner: makePlanner([
          { kind: 'call-tool', toolCall: { name: 't', args: {} } },
          { kind: 'done' },
        ]),
        toolRegistry: makeRegistry([{ ok: false, error: 'not found', retryable: false }]),
        traceSink: sink,
      },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes['ok']).toBe(false);
    expect(spans[0]?.attributes['error']).toBe('not found');
    expect(spans[0]?.attributes['retryable']).toBe(false);
  });
});

// ---------- context accumulation ----------

describe('runToolLoop — planner context accumulates across iterations', () => {
  it('each planner call sees the previous iterations toolResults', async () => {
    const seenSizes: number[] = [];
    const planner: Planner = {
      async plan(ctx) {
        seenSizes.push(ctx.toolResults.length);
        if (ctx.iteration < 2) {
          return { kind: 'call-tool', toolCall: { name: 't', args: { i: ctx.iteration } } };
        }
        return { kind: 'done' };
      },
    };
    await runToolLoop(
      {
        planner,
        toolRegistry: makeRegistry([
          { ok: true, value: 0 },
          { ok: true, value: 1 },
        ]),
        traceSink: noopSink,
      },
      baseInput,
      { maxIterations: 8, timeBudgetMs: 25_000 },
    );
    expect(seenSizes).toEqual([0, 1, 2]);
  });
});
