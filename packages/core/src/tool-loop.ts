import type { Planner, PlannerContext, ToolInvocationRecord } from './ports/planner.js';
/**
 * Tool loop. GW-18. ADR-0014.
 *
 * Bounded orchestration between planner and tool registry. The loop's
 * job is *only* to gather tool results — answer synthesis is a
 * separate step. This split keeps each piece testable in isolation:
 * the loop is testable with a stub planner and stub tools; synthesis
 * is testable with a fixed context.
 *
 * Termination contract (ADR-0002 + ADR-0014 §Termination):
 *
 * 1. **Iteration bound reached** — primary termination signal. Clean
 *    boundary. Loop returns with whatever it has. Trace records
 *    `terminated: 'iteration-bound'`.
 * 2. **Budget-aware early exit** — before entering iteration N, check
 *    `remaining_budget_ms >= iteration_cost_estimate(N)`. If not,
 *    break. Clean boundary, `terminated: 'budget-aware'`. This is
 *    the ADR-0002 promise: don't start an iteration you can't
 *    afford.
 * 3. **Planner says done** — `plan.kind === 'done'`. Clean boundary,
 *    `terminated: 'planner-done'`.
 * 4. **AbortSignal fires mid-iteration** — backstop for a hung
 *    iteration, not the loop's primary termination. Torn boundary;
 *    `terminated: 'timeout-backstop'` and whatever partial state
 *    the loop has.
 *
 * Error handling contract (ADR-0014 §Error handling):
 *
 * - Tool `ok: false` results are appended to context and the loop
 *   continues. The planner decides retry / adjust / stop on the
 *   next iteration. The loop itself never retries.
 * - Planner errors (adapter converts to `{ kind: 'done' }`) end the
 *   loop cleanly.
 * - Infrastructure errors (LLM API 5xx, network partition) throw.
 *   Caller (`/api/answer` handler) catches at the request boundary.
 * - TraceSink failures are best-effort per its port contract — the
 *   loop swallows them so a broken sink doesn't fail the request.
 */
import type { RetrievedChunk } from './ports/retriever.js';
import type { RouterDecision, RouterQuery } from './ports/router.js';
import type { ToolRegistry } from './ports/tool-registry.js';
import type { Span, TraceSink } from './ports/trace-sink.js';

export interface ToolLoopDeps {
  readonly planner: Planner;
  readonly toolRegistry: ToolRegistry;
  readonly traceSink: TraceSink;
  /** Millisecond clock; overridable for tests. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Random-ish span id generator. Overridable for tests. */
  readonly spanId?: () => string;
}

export interface ToolLoopInput {
  readonly query: RouterQuery;
  readonly routerDecision: RouterDecision;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly traceId: string;
  readonly parentSpanId?: string;
}

export interface ToolLoopOptions {
  readonly maxIterations: number;
  readonly timeBudgetMs: number;
  /**
   * Backstop signal. Fires mid-iteration if the wall-clock exceeds
   * `timeBudgetMs` at the /api/answer request boundary. The loop's
   * own pre-entry budget check should catch this in normal
   * operation.
   */
  readonly signal?: AbortSignal;
  /**
   * First-iteration cost floor in ms. The running average kicks in
   * from iteration 1. Default 2000ms — matches ADR-0002's per-
   * iteration estimate.
   */
  readonly firstIterationEstimateMs?: number;
}

export type ToolLoopTermination =
  | 'iteration-bound'
  | 'budget-aware'
  | 'planner-done'
  | 'timeout-backstop';

export interface ToolLoopResult {
  readonly toolInvocations: readonly ToolInvocationRecord[];
  readonly terminatedBy: ToolLoopTermination;
  readonly iterationsUsed: number;
  readonly elapsedMs: number;
}

const DEFAULT_FIRST_ITER_ESTIMATE_MS = 2000;

/**
 * Run the tool loop. Pure orchestration — every side effect goes
 * through an injected port (planner, tool registry, trace sink).
 */
export async function runToolLoop(
  deps: ToolLoopDeps,
  input: ToolLoopInput,
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const clock = deps.clock ?? Date.now;
  const spanId = deps.spanId ?? defaultSpanId;
  const firstEstimate = options.firstIterationEstimateMs ?? DEFAULT_FIRST_ITER_ESTIMATE_MS;

  // Read the signal freshly each time via a closure so TS's narrowing
  // from the first `=== true` check doesn't leak into later checks.
  const isAborted = (): boolean => options.signal?.aborted === true;

  const startedAt = clock();
  const toolResults: ToolInvocationRecord[] = [];
  let iterationsUsed = 0;
  let terminatedBy: ToolLoopTermination = 'iteration-bound';

  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    // Pre-entry budget check: don't start an iteration we can't afford.
    // Running-average of past iterations' durations; floor to the
    // first-iteration estimate before we have any samples.
    const elapsed = clock() - startedAt;
    const remaining = options.timeBudgetMs - elapsed;
    const estimate = estimateNextIterationMs(toolResults, firstEstimate);
    if (remaining < estimate) {
      terminatedBy = 'budget-aware';
      break;
    }

    // Abort backstop before we even ask the planner. If the signal
    // fired between iterations, honour it now rather than spending
    // another planner turn.
    if (isAborted()) {
      terminatedBy = 'timeout-backstop';
      break;
    }

    const context: PlannerContext = {
      query: input.query,
      routerDecision: input.routerDecision,
      retrievedChunks: input.retrievedChunks,
      toolResults,
      iteration,
    };

    let decision: Awaited<ReturnType<Planner['plan']>>;
    try {
      decision = await deps.planner.plan(context);
    } catch (error) {
      // Planner adapter should convert its own errors to
      // `{ kind: 'done' }`. Anything reaching here is infra-level
      // and should propagate — the request handler catches at the
      // boundary. But record the iteration used before rethrowing
      // so the trace shows how far we got.
      iterationsUsed = iteration + 1;
      throw error;
    }

    iterationsUsed = iteration + 1;

    if (decision.kind === 'done') {
      terminatedBy = 'planner-done';
      break;
    }

    // decision.kind === 'call-tool'
    const invokeStartedAt = clock();
    const invokeStartedIso = new Date(invokeStartedAt).toISOString();
    const currentSpanId = spanId();

    let result: Awaited<ReturnType<ToolRegistry['invoke']>>;
    try {
      result = await deps.toolRegistry.invoke(decision.toolCall, options.signal);
    } catch (error) {
      // Convert unexpected throws from the registry into a
      // structured error result — the port contract says
      // `invoke` returns a ToolResult rather than throwing, but
      // a defensive wrapper here protects the loop from a
      // misbehaving registry adapter.
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }

    const duration = clock() - invokeStartedAt;
    const record: ToolInvocationRecord = {
      call: decision.toolCall,
      result,
      durationMs: duration,
    };
    toolResults.push(record);

    // Best-effort trace emission — sink port contract says failures
    // must not fail the parent request, so swallow. `parentSpanId`
    // is spread conditionally because `exactOptionalPropertyTypes`
    // won't let us pass `undefined` to an optional field.
    const span: Span = {
      traceId: input.traceId,
      spanId: currentSpanId,
      ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
      kind: 'tool-call',
      startedAt: invokeStartedIso,
      durationMs: duration,
      attributes: {
        tool_name: decision.toolCall.name,
        iteration,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error, retryable: result.retryable }),
        ...(decision.rationale ? { rationale: decision.rationale } : {}),
      },
    };
    await safeTraceRecord(deps.traceSink, span);

    // Backstop check between iterations: if the tool's own
    // execution tripped the abort signal (via the AbortSignal
    // passed into invoke), don't ask the planner again — the
    // request is winding down.
    if (isAborted()) {
      terminatedBy = 'timeout-backstop';
      break;
    }
  }

  const elapsedMs = clock() - startedAt;
  return { toolInvocations: toolResults, terminatedBy, iterationsUsed, elapsedMs };
}

/**
 * Estimate the next iteration's duration in ms. Running average of
 * completed iterations' durations, falling back to the first-iteration
 * estimate before any data.
 *
 * This is intentionally simple. The goal is to prevent starting
 * iteration N=7 when 500ms remains and the previous 6 iterations
 * averaged 3000ms each. Refining beyond running-average is Sprint
 * 3+ scope if the pre-entry check turns out to be too pessimistic.
 */
function estimateNextIterationMs(
  toolResults: readonly ToolInvocationRecord[],
  firstIterationEstimateMs: number,
): number {
  if (toolResults.length === 0) return firstIterationEstimateMs;
  const total = toolResults.reduce((acc, r) => acc + r.durationMs, 0);
  return Math.max(total / toolResults.length, firstIterationEstimateMs);
}

async function safeTraceRecord(sink: TraceSink, span: Span): Promise<void> {
  try {
    await sink.record(span);
  } catch {
    // Port contract: sinks are best-effort. Swallow.
  }
}

function defaultSpanId(): string {
  // 8-char hex is enough for one turn's spans to not collide with
  // themselves; not a UUID because spans are scoped per-trace.
  return Math.random().toString(16).slice(2, 10);
}
