/**
 * NoopPlanner. GW-18, ADR-0014.
 *
 * Always returns `{ kind: 'done' }`. The loop calls it once per turn
 * and terminates via `planner-done` immediately. Purpose: let the
 * loop's termination + trace + budget machinery run end-to-end without
 * an LLM. Ships as the default planner for /api/answer until GW-24
 * wires model tiering with a real planner adapter.
 *
 * A turn served by NoopPlanner produces zero tool invocations. The
 * downstream synthesis step (Sprint 3+ story) then composes an answer
 * from whatever retrieval already put in the context — for Sprint 3
 * Story 2 that's an empty answer string, same as pre-GW-18 behaviour.
 */
import type { Planner, PlannerContext, PlannerDecision } from '@groundwork/core';

export class NoopPlanner implements Planner {
  async plan(_context: PlannerContext): Promise<PlannerDecision> {
    return { kind: 'done', rationale: 'noop planner — no tools registered yet' };
  }
}
