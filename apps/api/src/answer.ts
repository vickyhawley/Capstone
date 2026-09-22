/**
 * POST /api/answer — the endpoint the eval harness hits.
 *
 * Sprint 4 shape (opener): runs the intent router (with per-
 * dependency circuit breakers, GW-23), then the safety gate, then —
 * for `answer` behaviour — runs the bounded tool loop (ADR-0014)
 * with a `RouteBasedPlanner` doing Tier-1 dispatch. Product intent +
 * productQuery dispatches `product.stock_lookup` and conditionally
 * `product.substitute_lookup`; logistics intent + postcode dispatches
 * `logistics.delivery_zone`. Tool outputs surface on the response as
 * `substitute_handles` and `delivery_zone_status`.
 *
 * `answer` copy for non-escalate/non-abstain turns is still empty —
 * synthesis (Sprint 4, next story) composes it from tool results +
 * retrieved chunks. Escalate/abstain/degraded turns already carry
 * the correct customer copy via the safety gate + degraded-escalate
 * paths.
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
  OpenAiSynthesizer,
  PgTsRankRetriever,
  PgvectorDenseRetriever,
  ProductStockLookupTool,
  ProductSubstituteLookupTool,
  RouteBasedPlanner,
  RulesSafetyGate,
  ShopInfoTool,
  SupabaseConversationStore,
  SupabaseTraceSink,
  loadDeliveryDistricts,
  loadShopInfo,
  loadStatusOverrideList,
  rewriteWithContext,
  rrf,
} from '@groundwork/adapters';
import type {
  Behaviour,
  ConversationStore,
  ConversationTurn,
  Planner,
  Router,
  SafetyGate,
  Synthesizer,
  ToolRegistry,
  TraceSink,
} from '@groundwork/core';
import { CircuitBreaker, renderBehaviour, runToolLoop } from '@groundwork/core';
import { createClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

// Repo root — anchor for default data-file paths so the api process
// finds YAMLs regardless of what directory it was launched from.
// Before this: `data/nfcs-*.yaml` defaults resolved relative to
// CWD, which breaks any run that isn't `pnpm dev` from repo root
// (e.g. `pnpm --filter @groundwork/api dev` sets CWD to apps/api/).
// The env-var overrides (STOCK_LOOKUP_*, DELIVERY_DISTRICTS_PATH,
// SHOP_INFO_PATH) still take precedence when set — this just makes
// the defaults sane.
//
// answer.ts sits at apps/api/src/answer.ts in dev and apps/api/dist/
// answer.js in prod build; both are three levels below repo root,
// so the same relative offset works.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function dataPath(relative: string): string {
  return resolve(REPO_ROOT, relative);
}

import { MAX_ITERATIONS, TIME_BUDGET_MS } from './limits.js';
import {
  extractDeliveryZoneStatus,
  extractProductLinks,
  extractSubstituteHandles,
  generateTraceId,
  type DeliveryZoneStatus,
  type ProductLink,
} from './tool-output.js';

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
  /** Sprint 4 (Tier-1 dispatch): handles from `product.substitute_lookup`
   *  when the loop dispatched it. Empty when the tool didn't run
   *  (stock returned 'exact' or 'pending', substitute short-circuited,
   *  or planner terminated before dispatch). Consumed by the Python
   *  harness `substitute_offered_correct` metric — closes the GW-19
   *  producer-ahead-of-consumer gap. */
  readonly substitute_handles: readonly string[];
  /** Sprint 4 (Tier-1 dispatch): status from `logistics.delivery_zone`
   *  when the loop dispatched it. Null when the tool didn't run.
   *  Consumed by the Python harness `delivery_zone_correct` metric —
   *  closes the GW-21 producer-ahead-of-consumer gap. */
  readonly delivery_zone_status: DeliveryZoneStatus | null;
  /** Sprint 4 (product deep-links): clickable storefront links
   *  derived from stock_lookup's matched product and substitute_
   *  lookup's returned substitutes. Priority: matched first, then
   *  substitutes. Empty when neither tool ran with a product
   *  result. URLs built from NFCS_STOREFRONT_BASE_URL + Shopify's
   *  /products/{handle} pattern. */
  readonly product_links: readonly ProductLink[];
  /** GW-16: server-issued conversation id. Present on every response
   *  (turn 1 mints it, subsequent turns echo the client's). Client
   *  quotes this on the next request to continue the conversation.
   *  Null only on degraded-escalate turns that failed before the
   *  conversation could be created (rare). */
  readonly conversation_id: string | null;
  /** GW-16: the query the router actually saw, after context-aware
   *  rewriting. Equal to the input query for turn 1 or when the
   *  rewriter chose to pass it through unchanged. Surfaced for
   *  legibility in the evidence panel and to make eval diffs
   *  reproducible when a rewrite changed behaviour. */
  readonly rewritten_query: string | null;
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
  /** Sprint 4: composes customer-facing answer copy for
   *  answer-behaviour turns from the loop's tool outputs.
   *  Escalate / abstain / degraded turns bypass this — their
   *  copy is set by the safety gate + graceful-escalate paths. */
  readonly synthesizer: Synthesizer;
  /** GW-16: persists multi-turn conversation history so ambiguous
   *  follow-ups can be resolved against prior turns. See ADR-0017.
   *  Optional in the interface so pre-GW-16 tests can keep passing
   *  a slimmer deps object; when null, the handler skips both the
   *  rewrite step and the append step, and every request is treated
   *  as turn 1 with a fresh id. */
  readonly conversationStore?: ConversationStore;
  /** GW-16: rewrites the current query using the last N turns so
   *  the descriptive router (ADR-0010) doesn't need to grow
   *  context awareness. Called only when history is non-empty.
   *  Optional for the same reason as conversationStore. */
  readonly contextRewriter?: (query: string, history: readonly ConversationTurn[]) => Promise<string>;
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

    const originalQueryText = body.query;

    // GW-23: any infra exception (router, tool loop) below converts
    // to the graceful-escalate response, not a 500. Per-dependency
    // circuit breakers wired into the router + retrievers throw
    // CircuitOpenError once N failures accumulate; a bare throw
    // from an uninstrumented failure path lands here too. Same
    // shape either way — the safety gate's `escalate` behaviour
    // with `staff-order` is reused rather than inventing a new
    // "degraded" enum value, matching existing escalation copy.
    let conversationId: string | null = null;
    try {
      // GW-16: load-or-create conversation. Client supplies id on
      // continuations; server mints on turn 1. A stale id (client
      // reload after retention) is treated as turn 1, not an error.
      const clientConvId = typeof body.conversation_id === 'string' ? body.conversation_id : null;
      const conversation = await loadOrCreateConversation(deps.conversationStore, clientConvId);
      conversationId = conversation?.id ?? null;
      const history = conversation?.history ?? [];

      // GW-16: context-aware query rewrite. Runs only when history
      // exists (turn 2+). Passes through unchanged when the query
      // already stands alone (per rewriter's own policy). See
      // ADR-0017 §3.
      const routerQueryText =
        history.length > 0 && deps.contextRewriter
          ? await deps.contextRewriter(originalQueryText, history)
          : originalQueryText;
      const rewritten = routerQueryText !== originalQueryText ? routerQueryText : null;
      const query = { text: routerQueryText };

      const decision = await deps.router.route(query);
      const behaviour = deps.safetyGate.decide(decision, query);
      const behaviourCopy = renderBehaviour(behaviour);

      // GW-18: for answer-behaviour cases, run the bounded tool
      // loop. Non-answer cases (abstain, escalate) skip the loop
      // entirely — no tool call is meaningful when we're about to
      // refuse or escalate.
      let toolCalls: readonly ToolCallSummary[] = [];
      let substituteHandles: readonly string[] = [];
      let deliveryZoneStatus: DeliveryZoneStatus | null = null;
      let productLinks: readonly ProductLink[] = [];
      let synthesizedAnswer: string | null = null;
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
        // Sprint 4: surface the two tool-output fields the Python
        // schema already carries so `substitute_offered_correct` /
        // `delivery_zone_correct` metrics have something to read.
        // Extraction reads the full ToolInvocationRecord (not the
        // ToolCallSummary above, which has already dropped
        // result.value). Unknown shapes degrade to null / empty
        // rather than throw.
        substituteHandles = extractSubstituteHandles(loopResult.toolInvocations);
        deliveryZoneStatus = extractDeliveryZoneStatus(loopResult.toolInvocations);
        productLinks = extractProductLinks(loopResult.toolInvocations);

        // Sprint 4: synthesis. Compose the customer-facing answer
        // copy from the tool loop's outputs + the router's
        // classification. Failure (LLM 5xx / breaker-open) throws
        // and gets caught by the request-boundary try/catch as
        // graceful-escalate (GW-23). Empty-content and malformed
        // responses land in the adapter's fallback path, NOT here.
        const synth = await deps.synthesizer.synthesize({
          query,
          routerDecision: decision,
          toolResults: loopResult.toolInvocations,
          history,
        });
        synthesizedAnswer = synth.answer;
      }

      const finalAnswer = behaviourCopy ?? synthesizedAnswer ?? '';

      // GW-16: append both sides of the exchange after we know the
      // final answer. Best-effort — an append failure logs and
      // continues rather than degrading the customer response. The
      // conversation id in the response still refers to the created
      // conversation; the client can retry on the next turn.
      if (deps.conversationStore && conversationId) {
        await appendTurnPair(
          deps.conversationStore,
          conversationId,
          originalQueryText,
          finalAnswer,
        );
      }

      const response: AnswerResponseBody = {
        // Escalate/abstain copy takes precedence when the safety gate
        // decided; synthesis fills the answer field on answer-behaviour
        // turns. `?? ''` is a last-resort guard — behaviourCopy is
        // guaranteed non-null for non-answer behaviours by the copy
        // renderer, and synthesizedAnswer is guaranteed non-null for
        // answer-behaviour turns by the adapter's own fallback.
        answer: finalAnswer,
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
        substitute_handles: substituteHandles,
        delivery_zone_status: deliveryZoneStatus,
        product_links: productLinks,
        conversation_id: conversationId,
        rewritten_query: rewritten,
      };
      return c.json(response);
    } catch (error) {
      const degraded = renderDegradedEscalate(error, conversationId);
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
function renderDegradedEscalate(
  error: unknown,
  conversationId: string | null = null,
): AnswerResponseBody {
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
    substitute_handles: [],
    delivery_zone_status: null,
    product_links: [],
    conversation_id: conversationId,
    rewritten_query: null,
    degraded_reason: message,
  };
}

/**
 * GW-16 helper. Loads the conversation named by the client's id, or
 * creates a fresh one when the id is missing or unknown. Never throws
 * on a stale id — treats it as turn 1. Returns null only when no
 * conversation store is wired (pre-GW-16 tests + local dev without
 * SUPABASE creds).
 */
async function loadOrCreateConversation(
  store: ConversationStore | undefined,
  clientId: string | null,
) {
  if (!store) return null;
  if (clientId) {
    const existing = await store.get(clientId);
    if (existing) return existing;
    // Fall through — mint a new one. Ignoring the stale id rather
    // than surfacing it is the port contract's documented behaviour.
  }
  return store.create();
}

/**
 * GW-16 helper. Appends the user + assistant turn pair after the
 * pipeline has produced a final answer. Best-effort — a persistence
 * failure logs and continues rather than degrading the customer
 * response. TurnIds are trace-id-shaped 12-char randoms; scoping
 * to the conversation avoids the trace-id-uniqueness concern.
 */
async function appendTurnPair(
  store: ConversationStore,
  conversationId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await store.appendTurn(conversationId, {
      turnId: newTurnId(),
      role: 'user',
      text: userText,
      createdAt: now,
    });
    await store.appendTurn(conversationId, {
      turnId: newTurnId(),
      role: 'assistant',
      text: assistantText,
      createdAt: now,
    });
  } catch (err) {
    console.warn('conversation-append: persistence failed, response unaffected', err);
  }
}

function newTurnId(): string {
  return Math.random().toString(36).slice(2, 14);
}

function escalationTargetOf(b: Behaviour): string | null {
  return b.kind === 'escalate' ? b.escalationTarget : null;
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
    process.env['STOCK_LOOKUP_OUT_OF_SCOPE_PATH'] ?? dataPath('data/nfcs-out-of-scope.yaml');
  const pendingPath =
    process.env['STOCK_LOOKUP_PENDING_PATH'] ?? dataPath('data/nfcs-pending.yaml');
  const districtsPath =
    process.env['DELIVERY_DISTRICTS_PATH'] ?? dataPath('data/delivery-districts.yaml');
  const shopInfoPath = process.env['SHOP_INFO_PATH'] ?? dataPath('data/nfcs-shop-info.yaml');
  const [outOfScope, pending, districts, shopInfo] = await Promise.all([
    loadStatusOverrideList(outOfScopePath),
    loadStatusOverrideList(pendingPath),
    loadDeliveryDistricts(districtsPath),
    loadShopInfo(shopInfoPath),
  ]);
  // Sprint 4: subscription-eligible categories come from the shop-
  // info YAML — single source of truth. Passed here so a matched
  // Feed/Bedding/Haylage product flags subscriptionEligible=true and
  // the synthesizer surfaces the regular-delivery option.
  const stockLookupTool = new ProductStockLookupTool(
    retriever,
    dense,
    outOfScope,
    pending,
    shopInfo.subscriptionDelivery.eligibleTypes,
  );
  // GW-19: substitute lookup runs after stock_lookup when the loop
  // dispatches non-exact results. Shares the dense retriever with
  // stock_lookup — same product corpus, same embedding model.
  const substituteLookupTool = new ProductSubstituteLookupTool(dense);
  // GW-21: delivery zone runs on logistics-intent postcode queries.
  // Two states (within_radius / defer_to_staff) per the guide's
  // "never refuse" rule.
  const deliveryZoneTool = new DeliveryZoneTool(districts);
  // Sprint 4: shop info fires when the customer asks contact /
  // hours / address / ordering questions. No breaker — pure YAML
  // read, no external service to fail after composition-root load.
  const shopInfoTool = new ShopInfoTool(shopInfo);
  const toolRegistry = new CompositeToolRegistry([
    stockLookupTool,
    substituteLookupTool,
    deliveryZoneTool,
    shopInfoTool,
  ]);

  return {
    router: new HybridRouter(openai, openaiBreaker),
    safetyGate: new RulesSafetyGate(),
    // Sprint 4: real planner. Replaces NoopPlanner so product-intent
    // + productQuery / logistics-intent + postcode requests actually
    // dispatch tools. ADR-0014 Tier-1 dispatch.
    planner: new RouteBasedPlanner(),
    toolRegistry,
    // Trace sink stays uninstrumented — its port contract already
    // makes failures best-effort, so a Supabase outage there
    // silently degrades observability without failing the parent
    // request. Not a breaker call site.
    traceSink: new SupabaseTraceSink(supabase),
    // Sprint 4: OpenAI-backed synthesis. Shares the openai client
    // with the router + retrievers, wraps under the same openai
    // breaker so cascading LLM failures open the circuit and route
    // to graceful-escalate at the request boundary (GW-23).
    synthesizer: new OpenAiSynthesizer(openai, openaiBreaker),
    // GW-16: server-side conversation memory (ADR-0017). Same
    // Supabase client as the trace sink; a separate table
    // (migration 005) so cascade delete of a conversation does
    // not lose trace evidence.
    conversationStore: new SupabaseConversationStore(supabase),
    // GW-16: context-aware query rewrite. Wraps the shared openai
    // client with the openaiBreaker so a cascading LLM failure
    // opens the same breaker as router + synthesizer, keeping
    // one degradation surface rather than three.
    contextRewriter: (query, history) =>
      rewriteWithContext(query, history, { openai, openaiBreaker }),
  };
}
