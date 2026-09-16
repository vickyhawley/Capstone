/**
 * Planner port. ADR-0014 (GW-18).
 *
 * The planner decides, given the current turn context, whether to call
 * another tool or finish. It is the "brain" of the tool loop — the
 * layer that reads what happened so far and picks the next step. The
 * loop itself (see `tool-loop.ts`) is pure orchestration and does not
 * decide anything.
 *
 * Two implementations expected:
 * - `NoopPlanner` (adapter, ships with GW-18): always returns
 *   `{ kind: 'done' }`. Lets the loop's termination + trace + budget
 *   machinery be tested and wired end-to-end without an LLM.
 * - `LlmPlanner` (adapter, ships with GW-24 model tiering): calls a
 *   fast planner-tier model with the current context serialised as
 *   messages, parses the model's function-call response back into
 *   either a `call-tool` or `done` decision.
 *
 * Structured errors, not exceptions. The planner returns a decision;
 * if the model produces malformed output the adapter converts to
 * `{ kind: 'done' }` with a rationale rather than throwing (same
 * shape as ADR-0014's tool-failure handling: infra failures throw,
 * planner failures are context the loop uses).
 */
import type { RetrievedChunk } from './retriever.js';
import type { RouterDecision, RouterQuery } from './router.js';
import type { ToolInvocation, ToolResult } from './tool-registry.js';

/**
 * One tool invocation the loop performed, plus its result. Populates
 * the loop's `toolResults` context the planner reads on the next
 * iteration.
 */
export interface ToolInvocationRecord {
  readonly call: ToolInvocation;
  readonly result: ToolResult;
  /** Wall-clock ms from invoke start to result. */
  readonly durationMs: number;
}

/**
 * Everything the planner sees for one iteration. `iteration` starts
 * at 0. `toolResults` accumulates across iterations.
 */
export interface PlannerContext {
  readonly query: RouterQuery;
  readonly routerDecision: RouterDecision;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly toolResults: readonly ToolInvocationRecord[];
  readonly iteration: number;
}

/**
 * Planner output. Either "call this tool next" or "I'm done, hand off
 * to synthesis". No other kinds — the loop only knows how to dispatch
 * or terminate. Rationale is optional but recommended for traceability.
 */
export type PlannerDecision =
  | {
      readonly kind: 'call-tool';
      readonly toolCall: ToolInvocation;
      readonly rationale?: string;
    }
  | {
      readonly kind: 'done';
      readonly rationale?: string;
    };

export interface Planner {
  plan(context: PlannerContext): Promise<PlannerDecision>;
}
