/**
 * SafetyGate port. ADR-0011.
 *
 * Consumes a `RouterDecision` (from ADR-0010) and the original query
 * text, and emits a `Behaviour` — the assistant's dispatch decision
 * for this turn. The router says *what* the query is about; this port
 * says *what to do* with that.
 *
 * The gate does not synthesize copy, does not retrieve, and does not
 * decide adversarial content-filtering. Escalation copy is GW-12;
 * retrieval is ADR-0001 + ADR-0007; adversarial synthesis-side
 * handling is downstream. This layer is a policy dispatcher.
 *
 * The `Behaviour` shape mirrors the `expected_behavior` label from
 * `evals/groundwork_evals/schema.py` — the three values are the exact
 * set the golden dataset was authored against. Keep them in lock-step.
 */
import type { RouterDecision, RouterQuery } from './router.js';

export type EscalationTarget =
  /** welfare-clinical → route to vet. */
  | 'vet'
  /** service-referral (booking) or remote-fitting (boots/hat/helmet). */
  | 'staff-service'
  /** order status, delivery edge cases. */
  | 'staff-order';

/**
 * Machine-readable refusal reason. Not customer-facing copy — that is
 * GW-12's concern. Values are a fixed set so downstream consumers can
 * switch on them without string-parsing.
 */
export type RefusalReason = 'out-of-scope' | 'adversarial';

export type Behaviour =
  | { readonly kind: 'answer' }
  | { readonly kind: 'abstain'; readonly refusalReason: RefusalReason }
  | { readonly kind: 'escalate'; readonly escalationTarget: EscalationTarget };

export interface SafetyGate {
  /**
   * Decide behaviour from the router's classification plus the raw
   * query text. Query text is passed because the three tag rules
   * (ADR-0011) need to regex-match against it — the router does not
   * carry the raw text in its decision, and adding it there would
   * couple two layers unnecessarily.
   */
  decide(decision: RouterDecision, query: RouterQuery): Behaviour;
}
