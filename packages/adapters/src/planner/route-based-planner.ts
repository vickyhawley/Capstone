/**
 * RouteBasedPlanner. Sprint 4 opener — replaces NoopPlanner in the
 * default deps to make the three Sprint-3 tools actually fire on
 * real requests.
 *
 * Implements ADR-0014's Tier 1 route-based dispatch: the planner
 * reads `RouterDecision.intent` (+ extracted entities) and emits a
 * fixed sequence of tool calls, one per iteration, then terminates.
 * No LLM — this is intent-driven pattern-matching. When Sprint 4+
 * needs LLM-driven planning (compound queries, clarification loops,
 * multi-tool reasoning), an `LlmPlanner` adapter slots in without
 * changing this one.
 *
 * Dispatch table:
 *
 * | intent    | additional            | iter 0                        | iter 1 (given iter 0 result)                                          | iter 2+ |
 * |-----------|-----------------------|-------------------------------|-----------------------------------------------------------------------|---------|
 * | product   | productQuery present  | product.stock_lookup          | product.substitute_lookup if stockStatus in {orderable, unavailable}  | done    |
 * | product   | productQuery absent   | done                          | —                                                                     | —       |
 * | logistics | postcode present      | logistics.delivery_zone       | done                                                                  | —       |
 * | logistics | postcode absent       | done                          | —                                                                     | —       |
 * | anything else                      | done                          | —                                                                     | —       |
 *
 * Non-product/non-logistics intents (welfare-clinical, out-of-scope,
 * service-referral, fit) never reach this planner — the safety gate
 * short-circuits them to escalate/abstain before the tool loop runs
 * (see `apps/api/src/answer.ts`).
 *
 * Termination discipline: this planner never emits `call-tool` with
 * the same tool name twice in one turn — the loop-side iteration
 * bound is a backstop for a misbehaving planner, not the primary
 * termination signal here. Reading `context.toolResults` for the
 * dispatch state (rather than tracking iteration numbers) keeps the
 * planner idempotent under retry: same context in → same decision
 * out.
 *
 * Failure handling: if a dispatched tool returns `ok: false`, the
 * planner does NOT retry — it terminates on the next iteration.
 * ADR-0014's contract is that tool failures are the model's / the
 * planner's problem to interpret, and a Tier-1 planner has no
 * interpretation beyond "the tool didn't answer; hand off to
 * synthesis with whatever we have." Retries are a Sprint-4+
 * concern that couples to the circuit breaker's failure counting.
 */

import type {
  Planner,
  PlannerContext,
  PlannerDecision,
  ToolInvocationRecord,
} from '@groundwork/core';

const TOOL_STOCK_LOOKUP = 'product.stock_lookup';
const TOOL_SUBSTITUTE_LOOKUP = 'product.substitute_lookup';
const TOOL_DELIVERY_ZONE = 'logistics.delivery_zone';

type StockLookupValue = { readonly status: string };

export class RouteBasedPlanner implements Planner {
  async plan(context: PlannerContext): Promise<PlannerDecision> {
    const { routerDecision, toolResults } = context;

    if (routerDecision.intent === 'product' && routerDecision.productQuery) {
      return this.planProduct(routerDecision.productQuery, toolResults);
    }

    if (routerDecision.intent === 'logistics' && routerDecision.postcode) {
      return this.planLogistics(routerDecision.postcode, toolResults);
    }

    return {
      kind: 'done',
      rationale: reasonForNoDispatch(routerDecision.intent, routerDecision),
    };
  }

  private planProduct(
    productQuery: string,
    toolResults: readonly ToolInvocationRecord[],
  ): PlannerDecision {
    const stockLookupCall = toolResults.find((r) => r.call.name === TOOL_STOCK_LOOKUP);
    const substituteCall = toolResults.find((r) => r.call.name === TOOL_SUBSTITUTE_LOOKUP);

    if (!stockLookupCall) {
      return {
        kind: 'call-tool',
        toolCall: {
          name: TOOL_STOCK_LOOKUP,
          args: { productQuery },
        },
        rationale: `Tier-1 dispatch: product intent with productQuery '${productQuery}'`,
      };
    }

    if (substituteCall) {
      // Both tools have run; nothing more to do.
      return { kind: 'done', rationale: 'stock + substitute dispatched' };
    }

    // Substitute runs only when stock_lookup returned a non-exact
    // status AND the call itself succeeded. Exact and pending are
    // resolved — no reason to look up substitutes. Failed tool call
    // → terminate rather than compound the failure.
    if (!stockLookupCall.result.ok) {
      return { kind: 'done', rationale: 'stock_lookup failed; no substitute lookup' };
    }
    const stockValue = stockLookupCall.result.value as StockLookupValue | undefined;
    const status = stockValue?.status;
    if (status === 'orderable' || status === 'unavailable') {
      return {
        kind: 'call-tool',
        toolCall: {
          name: TOOL_SUBSTITUTE_LOOKUP,
          args: { productQuery, stockStatus: status },
        },
        rationale: `Tier-1 dispatch: stock_lookup returned '${status}' → substitute lookup`,
      };
    }
    return {
      kind: 'done',
      rationale: `stock_lookup returned '${status ?? 'unknown'}'; no substitute lookup needed`,
    };
  }

  private planLogistics(
    postcode: string,
    toolResults: readonly ToolInvocationRecord[],
  ): PlannerDecision {
    const deliveryCall = toolResults.find((r) => r.call.name === TOOL_DELIVERY_ZONE);
    if (deliveryCall) {
      return { kind: 'done', rationale: 'delivery_zone dispatched' };
    }
    return {
      kind: 'call-tool',
      toolCall: {
        name: TOOL_DELIVERY_ZONE,
        args: { postcode },
      },
      rationale: `Tier-1 dispatch: logistics intent with postcode '${postcode}'`,
    };
  }
}

function reasonForNoDispatch(
  intent: string,
  decision: { readonly productQuery?: string; readonly postcode?: string },
): string {
  if (intent === 'product' && !decision.productQuery) {
    return 'product intent but no productQuery extracted; nothing to dispatch';
  }
  if (intent === 'logistics' && !decision.postcode) {
    return 'logistics intent but no postcode extracted; nothing to dispatch';
  }
  return `intent '${intent}' has no Tier-1 tool dispatch`;
}
