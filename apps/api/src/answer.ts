/**
 * POST /api/answer — the endpoint the eval harness hits.
 *
 * Sprint 3 shape (GW-10 + GW-11 + GW-12 + GW-18 landed; GW-20+ tools
 * and synthesis pending): runs the intent router, then the safety
 * gate, then — for `answer` behaviour — runs the bounded tool loop
 * (ADR-0014) with a NoopPlanner + empty tool registry until GW-20/21/22
 * register real tools. `answer` / `citations` / `retrieved_chunk_ids`
 * are populated only when synthesis lands downstream.
 *
 * The response schema matches `evals/groundwork_evals/schema.py`
 * `ApiResponse` — that Python file is the source of truth per
 * ADR-0010, ADR-0011, and ADR-0014.
 *
 * Runtime dependency: OPENAI_API_KEY. The router's LLM classifier
 * needs it; the endpoint fails cleanly with a 500 if it's missing
 * rather than instantiating a broken client at import time.
 */

import {
  HybridRouter,
  NoopPlanner,
  RulesSafetyGate,
  StubToolRegistry,
  StubTraceSink,
} from '@groundwork/adapters';
import type {
  Behaviour,
  Planner,
  Router,
  SafetyGate,
  ToolRegistry,
  TraceSink,
} from '@groundwork/core';
import { renderBehaviour, runToolLoop } from '@groundwork/core';
import { Hono } from 'hono';
import OpenAI from 'openai';

import { MAX_ITERATIONS, TIME_BUDGET_MS } from './limits.js';

interface AnswerRequestBody {
  readonly query?: unknown;
  readonly conversation_id?: unknown;
}

interface AnswerResponseBody {
  readonly answer: string;
  readonly citations: readonly never[];
  readonly retrieved_chunk_ids: readonly string[];
  readonly refusal_reason: string | null;
  readonly trace_id: string | null;
  readonly intent: string;
  readonly adversarial_suspected: boolean;
  readonly adversarial_pattern: string | null;
  readonly behavior: 'answer' | 'abstain' | 'escalate';
  readonly escalation_target: string | null;
  readonly tool_calls: readonly ToolCallSummary[];
}

interface ToolCallSummary {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  readonly duration_ms: number;
}

export interface AnswerDeps {
  readonly router: Router;
  readonly safetyGate: SafetyGate;
  readonly planner: Planner;
  readonly toolRegistry: ToolRegistry;
  readonly traceSink: TraceSink;
}

/**
 * Build the /api/answer route. Dependencies are injected so tests can
 * pass stubs and skip the OpenAI network call.
 */
export function createAnswerRoute(deps: AnswerDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: AnswerRequestBody;
    try {
      body = (await c.req.json()) as AnswerRequestBody;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.query !== 'string' || body.query.trim() === '') {
      return c.json({ error: '`query` is required and must be a non-empty string' }, 400);
    }

    const query = { text: body.query };

    let decision: Awaited<ReturnType<Router['route']>>;
    try {
      decision = await deps.router.route(query);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }

    const behaviour = deps.safetyGate.decide(decision, query);
    const behaviourCopy = renderBehaviour(behaviour);

    // GW-18: for answer-behaviour cases, run the bounded tool loop.
    // Non-answer cases (abstain, escalate) skip the loop entirely —
    // no tool call is meaningful when we're about to refuse or
    // escalate.
    let toolCalls: readonly ToolCallSummary[] = [];
    let traceId: string | null = null;
    if (behaviour.kind === 'answer') {
      traceId = generateTraceId();
      const loopResult = await runToolLoop(
        {
          planner: deps.planner,
          toolRegistry: deps.toolRegistry,
          traceSink: deps.traceSink,
        },
        {
          query,
          routerDecision: decision,
          retrievedChunks: [], // Retrieval is a Sprint 3 downstream story.
          traceId,
        },
        {
          maxIterations: MAX_ITERATIONS,
          timeBudgetMs: TIME_BUDGET_MS,
          signal: c.req.raw.signal,
        },
      );
      toolCalls = loopResult.toolInvocations.map((inv) => ({
        name: inv.call.name,
        args: inv.call.args,
        ok: inv.result.ok,
        duration_ms: inv.durationMs,
      }));
    }

    const response: AnswerResponseBody = {
      answer: behaviourCopy ?? '',
      citations: [],
      retrieved_chunk_ids: [],
      refusal_reason: behaviour.kind === 'abstain' ? behaviour.refusalReason : null,
      trace_id: traceId,
      intent: decision.intent,
      adversarial_suspected: decision.adversarialSuspected,
      adversarial_pattern: decision.adversarialPattern ?? null,
      behavior: behaviour.kind,
      escalation_target: escalationTargetOf(behaviour),
      tool_calls: toolCalls,
    };
    return c.json(response);
  });

  return route;
}

function escalationTargetOf(b: Behaviour): string | null {
  return b.kind === 'escalate' ? b.escalationTarget : null;
}

function generateTraceId(): string {
  // Random UUID-shaped hex string. Not spec-compliant UUID; scope is
  // one turn's traces, doesn't need to be. Sprint 3 GW-25 may swap
  // to a proper UUID when traces persist across turns.
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Instantiate the default production dependencies from env. Called
 * from `server.ts` at request-scope so a missing key produces a 500
 * on the first hit rather than an import-time crash.
 */
export function defaultAnswerDeps(): AnswerDeps {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for /api/answer');
  }
  const openai = new OpenAI({ apiKey });
  return {
    router: new HybridRouter(openai),
    safetyGate: new RulesSafetyGate(),
    planner: new NoopPlanner(),
    toolRegistry: new StubToolRegistry(),
    traceSink: new StubTraceSink(),
  };
}
