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
  CompositeToolRegistry,
  DeliveryZoneTool,
  HybridRetriever,
  HybridRouter,
  NoopPlanner,
  PgTsRankRetriever,
  PgvectorDenseRetriever,
  ProductStockLookupTool,
  ProductSubstituteLookupTool,
  RulesSafetyGate,
  SupabaseTraceSink,
  loadDeliveryDistricts,
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
import { CircuitBreaker, renderBehaviour, runToolLoop } from '@groundwork/core';
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
  readonly intent: string | null;
  readonly adversarial_suspected: boolean;
  readonly adversarial_pattern: string | null;
  readonly product_query: string | null;
  readonly behavior: 'answer' | 'abstain' | 'escalate';
  readonly escalation_target: string | null;
  readonly tool_calls: readonly ToolCallSummary[];
  /** GW-23: populated when the request completed via the infra-
   *  failure graceful-escalate path. Null on all normal responses.
   *  Machine-readable free string; harness metrics can key on
   *  non-null to slice degraded turns. */
  readonly degraded_reason?: string | null;
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

    // GW-23: any infra exception (router, tool loop) below converts
    // to the graceful-escalate response, not a 500. Per-dependency
    // circuit breakers wired into the router + retrievers throw
    // CircuitOpenError once N failures accumulate; a bare throw
    // from an uninstrumented failure path lands here too. Same
    // shape either way — the safety gate's `escalate` behaviour
    // with `staff-order` is reused rather than inventing a new
    // "degraded" enum value, matching existing escalation copy.
    try {
      const decision = await deps.router.route(query);
      const behaviour = deps.safetyGate.decide(decision, query);
      const behaviourCopy = renderBehaviour(behaviour);

      // GW-18: for answer-behaviour cases, run the bounded tool
      // loop. Non-answer cases (abstain, escalate) skip the loop
      // entirely — no tool call is meaningful when we're about to
      // refuse or escalate.
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
    } catch (error) {
      const degraded = renderDegradedEscalate(error);
      return c.json(degraded);
    }
  });

  return route;
}

/**
 * Build the graceful-escalate response for an infra failure. GW-23.
 *
 * Reuses the safety gate's `escalate` behaviour with `staff-order`
 * so downstream consumers (harness metrics, UI) that already
 * switch on the escalate/target shape need no change. The
 * `refusal_reason` field stays null — this is not a refusal, it's
 * a degraded route to staff. `intent` reports 'unknown' honestly
 * rather than fabricating a classification the router never
 * returned.
 */
function renderDegradedEscalate(error: unknown): AnswerResponseBody {
  const message = error instanceof Error ? error.message : String(error);
  const escalate: Behaviour = { kind: 'escalate', escalationTarget: 'staff-order' };
  const copy = renderBehaviour(escalate) ?? '';
  return {
    answer: copy,
    citations: [],
    retrieved_chunk_ids: [],
    refusal_reason: null,
    trace_id: null,
    // Null rather than a placeholder — the router never returned
    // a classification on this path. Reporting a fake intent would
    // corrupt harness slicing.
    intent: null,
    adversarial_suspected: false,
    adversarial_pattern: null,
    product_query: null,
    behavior: 'escalate',
    escalation_target: 'staff-order',
    tool_calls: [],
    degraded_reason: message,
  };
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

  // GW-23: per-dependency circuit breakers. Failure threshold and
  // cooldown are set for demo-legibility rather than tuned against
  // production traffic — 5 consecutive failures in a demo window
  // is enough to be clearly "broken" without being trigger-happy
  // on a single transient error, and 30s cooldown means the
  // half-open probe happens well within a viewer's attention span.
  // These numbers are stated honestly in the sprint-log close-out
  // as chosen-not-tuned; production tuning is a Sprint-4 candidate.
  const openaiBreaker = new CircuitBreaker('openai', {
    failureThreshold: 5,
    cooldownMs: 30_000,
  });
  const supabaseBreaker = new CircuitBreaker('supabase', {
    failureThreshold: 5,
    cooldownMs: 30_000,
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
  const dense = new PgvectorDenseRetriever(supabase, openai, openaiBreaker, supabaseBreaker);
  const sparse = new PgTsRankRetriever(supabase, supabaseBreaker);
  const retriever = new HybridRetriever(dense, sparse, rrf());
  const outOfScopePath =
    process.env['STOCK_LOOKUP_OUT_OF_SCOPE_PATH'] ?? 'data/nfcs-out-of-scope.yaml';
  const pendingPath = process.env['STOCK_LOOKUP_PENDING_PATH'] ?? 'data/nfcs-pending.yaml';
  const districtsPath =
    process.env['DELIVERY_DISTRICTS_PATH'] ?? 'data/delivery-districts.yaml';
  const [outOfScope, pending, districts] = await Promise.all([
    loadStatusOverrideList(outOfScopePath),
    loadStatusOverrideList(pendingPath),
    loadDeliveryDistricts(districtsPath),
  ]);
  const stockLookupTool = new ProductStockLookupTool(retriever, dense, outOfScope, pending);
  // GW-19: substitute lookup runs after stock_lookup when the loop
  // dispatches non-exact results. Shares the dense retriever with
  // stock_lookup — same product corpus, same embedding model.
  const substituteLookupTool = new ProductSubstituteLookupTool(dense);
  // GW-21: delivery zone runs on logistics-intent postcode queries.
  // Two states (within_radius / defer_to_staff) per the guide's
  // "never refuse" rule.
  const deliveryZoneTool = new DeliveryZoneTool(districts);
  const toolRegistry = new CompositeToolRegistry([
    stockLookupTool,
    substituteLookupTool,
    deliveryZoneTool,
  ]);

  return {
    router: new HybridRouter(openai, openaiBreaker),
    safetyGate: new RulesSafetyGate(),
    planner: new NoopPlanner(),
    toolRegistry,
    // Trace sink stays uninstrumented — its port contract already
    // makes failures best-effort, so a Supabase outage there
    // silently degrades observability without failing the parent
    // request. Not a breaker call site.
    traceSink: new SupabaseTraceSink(supabase),
  };
}
