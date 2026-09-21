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
  SupabaseTraceSink,
  loadDeliveryDistricts,
  loadShopInfo,
  loadStatusOverrideList,
  rrf,
} from '@groundwork/adapters';
import type {
  Behaviour,
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

interface AnswerRequestBody {
  readonly query?: unknown;
  readonly conversation_id?: unknown;
}

interface ProductLink {
  readonly handle: string;
  readonly title: string | null;
  readonly url: string;
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
  readonly delivery_zone_status: 'within_radius' | 'defer_to_staff' | null;
  /** Sprint 4 (product deep-links): clickable storefront links
   *  derived from stock_lookup's matched product and substitute_
   *  lookup's returned substitutes. Priority: matched first, then
   *  substitutes. Empty when neither tool ran with a product
   *  result. URLs built from NFCS_STOREFRONT_BASE_URL + Shopify's
   *  /products/{handle} pattern. */
  readonly product_links: readonly ProductLink[];
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
      let substituteHandles: readonly string[] = [];
      let deliveryZoneStatus: 'within_radius' | 'defer_to_staff' | null = null;
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
        });
        synthesizedAnswer = synth.answer;
      }

      const response: AnswerResponseBody = {
        // Escalate/abstain copy takes precedence when the safety gate
        // decided; synthesis fills the answer field on answer-behaviour
        // turns. `?? ''` is a last-resort guard — behaviourCopy is
        // guaranteed non-null for non-answer behaviours by the copy
        // renderer, and synthesizedAnswer is guaranteed non-null for
        // answer-behaviour turns by the adapter's own fallback.
        answer: behaviourCopy ?? synthesizedAnswer ?? '',
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
    substitute_handles: [],
    delivery_zone_status: null,
    product_links: [],
    degraded_reason: message,
  };
}

// ---------- Sprint 4: tool-output extraction for ApiResponse ----------
//
// Tool results flow through the loop as opaque `unknown` values by
// port contract (ToolResult.value is unknown so tool authors' surfaces
// stay flexible). The two extractors below reach INTO that unknown
// with defensive shape checks. Two rules:
//   1. Unknown shapes must degrade to empty/null, never throw. A
//      broken tool result should not fail the whole response.
//   2. Tool name is the switch — matches the string constants used
//      in the tools themselves (product.substitute_lookup /
//      logistics.delivery_zone). Rename a tool → update here.

interface ToolInvocationLite {
  readonly call: { readonly name: string };
  readonly result: { readonly ok: boolean; readonly value?: unknown };
}

function extractSubstituteHandles(
  invocations: readonly ToolInvocationLite[],
): readonly string[] {
  const substituteInv = invocations.find(
    (inv) => inv.call.name === 'product.substitute_lookup' && inv.result.ok,
  );
  if (!substituteInv) return [];
  const value = substituteInv.result.value as
    | { readonly substitutes?: readonly { readonly handle?: unknown }[] }
    | undefined;
  const substitutes = value?.substitutes;
  if (!Array.isArray(substitutes)) return [];
  return substitutes
    .map((s) => (typeof s?.handle === 'string' ? s.handle : null))
    .filter((h): h is string => h !== null);
}

function extractDeliveryZoneStatus(
  invocations: readonly ToolInvocationLite[],
): 'within_radius' | 'defer_to_staff' | null {
  const deliveryInv = invocations.find(
    (inv) => inv.call.name === 'logistics.delivery_zone' && inv.result.ok,
  );
  if (!deliveryInv) return null;
  const value = deliveryInv.result.value as { readonly status?: unknown } | undefined;
  const status = value?.status;
  if (status === 'within_radius' || status === 'defer_to_staff') return status;
  return null;
}

// ---------- Sprint 4: storefront deep links ----------
//
// Turn product handles from tool results into clickable URLs the
// UI renders as chips below the answer bubble. Shopify pattern:
// /products/{handle}. Base URL configurable via env var so a
// staging storefront (or a moved deployment) doesn't need a code
// change.
//
// Priority: stock_lookup.matchedHandle first (the product the
// customer asked about), then substitute_lookup.substitutes[] in
// the order the tool returned them (top-ranked substitute first).
// Duplicates dropped — a matched product also appearing as a
// substitute would render twice otherwise.

const STOREFRONT_BASE_URL_DEFAULT = 'https://newforestcountrystore.co.uk';

function storefrontBaseUrl(): string {
  const raw = process.env['NFCS_STOREFRONT_BASE_URL']?.trim();
  const base = raw && raw.length > 0 ? raw : STOREFRONT_BASE_URL_DEFAULT;
  // Trim a trailing slash so the join is unambiguous.
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function productUrl(handle: string): string {
  return `${storefrontBaseUrl()}/products/${encodeURIComponent(handle)}`;
}

function extractProductLinks(
  invocations: readonly ToolInvocationLite[],
): readonly ProductLink[] {
  const links: ProductLink[] = [];
  const seen = new Set<string>();
  const push = (handle: unknown, title: unknown): void => {
    if (typeof handle !== 'string' || handle.length === 0) return;
    if (seen.has(handle)) return;
    seen.add(handle);
    links.push({
      handle,
      title: typeof title === 'string' && title.length > 0 ? title : null,
      url: productUrl(handle),
    });
  };

  const stockInv = invocations.find(
    (inv) => inv.call.name === 'product.stock_lookup' && inv.result.ok,
  );
  if (stockInv) {
    const value = stockInv.result.value as
      | { readonly matchedHandle?: unknown; readonly matchedTitle?: unknown }
      | undefined;
    push(value?.matchedHandle, value?.matchedTitle);
  }

  const substituteInv = invocations.find(
    (inv) => inv.call.name === 'product.substitute_lookup' && inv.result.ok,
  );
  if (substituteInv) {
    const value = substituteInv.result.value as
      | {
          readonly substitutes?: readonly {
            readonly handle?: unknown;
            readonly title?: unknown;
          }[];
        }
      | undefined;
    const substitutes = value?.substitutes;
    if (Array.isArray(substitutes)) {
      for (const s of substitutes) {
        push(s?.handle, s?.title);
      }
    }
  }

  return links;
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
  const stockLookupTool = new ProductStockLookupTool(retriever, dense, outOfScope, pending);
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
  };
}
