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
  HybridRetriever,
  HybridRouter,
  NoopPlanner,
  PgTsRankRetriever,
  PgvectorDenseRetriever,
  ProductStockLookupTool,
  RulesSafetyGate,
  SupabaseTraceSink,
  loadStatusOverrideList,
  rrf,
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
import { createClient } from '@supabase/supabase-js';
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
  readonly product_query: string | null;
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
      product_query: decision.productQuery ?? null,
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
 * from `server.ts` at request-scope so a missing env var produces a
 * 500 on the first hit rather than an import-time crash.
 *
 * Async because GW-20 (ProductStockLookupTool) reads two YAML files
 * at startup — `data/nfcs-out-of-scope.yaml` (permanent brand
 * won't-stock) and `data/nfcs-pending.yaml` (temporary pre-condition
 * override). Loaded once at composition-root per ADR-0016 §"loader
 * pattern"; a corrupt file surfaces at deps-build time rather than
 * on the first customer request. The YAML paths default to the
 * repo-root data/ directory but can be overridden via
 * `STOCK_LOOKUP_OUT_OF_SCOPE_PATH` and `STOCK_LOOKUP_PENDING_PATH`
 * for deployment layouts that put data elsewhere.
 *
 * Sprint 3 (GW-25) added Supabase requirements — the trace sink
 * writes to the `traces` table. Router still needs OpenAI. Both
 * are checked up front; a missing var fails cleanly.
 */
export async function defaultAnswerDeps(): Promise<AnswerDeps> {
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (!openaiKey) {
    throw new Error('OPENAI_API_KEY is required for /api/answer');
  }
  const supabaseUrl = process.env['SUPABASE_URL'];
  const supabaseKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for /api/answer (GW-25 trace persistence)',
    );
  }
  const openai = new OpenAI({ apiKey: openaiKey });
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  // GW-20: real tool registry, replacing StubToolRegistry. The tool
  // takes two retrievers per ADR-0016 §3 Option A: the hybrid
  // retriever owns ordering + chunk IDs; the dense retriever owns
  // the cosine confidence score the floor is applied against. RRF is
  // ordinal (rank-0 on a tangential chunk scores identically to
  // rank-0 on the correct product), so the floor lives on the metric
  // signal, not the fused output. The two share an OpenAI client, so
  // the extra embed call per invocation is a small cost.
  // `null` minMatchScore is not passed from this path — the tool's
  // default (ADR-0016 §3) applies to every customer-reaching call.
  // Only the smoke script sets `null` for characterisation.
  const dense = new PgvectorDenseRetriever(supabase, openai);
  const sparse = new PgTsRankRetriever(supabase);
  const retriever = new HybridRetriever(dense, sparse, rrf());
  const outOfScopePath =
    process.env['STOCK_LOOKUP_OUT_OF_SCOPE_PATH'] ?? 'data/nfcs-out-of-scope.yaml';
  const pendingPath = process.env['STOCK_LOOKUP_PENDING_PATH'] ?? 'data/nfcs-pending.yaml';
  const [outOfScope, pending] = await Promise.all([
    loadStatusOverrideList(outOfScopePath),
    loadStatusOverrideList(pendingPath),
  ]);
  const toolRegistry = new ProductStockLookupTool(retriever, dense, outOfScope, pending);

  return {
    router: new HybridRouter(openai),
    safetyGate: new RulesSafetyGate(),
    planner: new NoopPlanner(),
    toolRegistry,
    traceSink: new SupabaseTraceSink(supabase),
  };
}
