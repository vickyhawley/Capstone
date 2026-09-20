/**
 * Router port. ADR-0010.
 *
 * Classifies a user query into one of six intents so the pipeline can
 * decide whether to retrieve, escalate, or decline before spending any
 * further budget. Descriptive-only: the router says *what* the query
 * is about; the safety gate (GW-11) says *what to do* with that.
 *
 * The label set is the exact `Intent` literal from
 * `evals/groundwork_evals/schema.py:18`. Adding a label here without
 * adding it there (or vice versa) is a contract violation —
 * `intent_classification_accuracy` would score against a mismatched
 * space. Keep them in lock-step.
 */

export type Intent =
  | 'product'
  | 'fit'
  | 'logistics'
  | 'welfare-clinical'
  | 'out-of-scope'
  | 'service-referral';

export const INTENTS: readonly Intent[] = [
  'product',
  'fit',
  'logistics',
  'welfare-clinical',
  'out-of-scope',
  'service-referral',
];

export interface RouterQuery {
  readonly text: string;
}

export interface RouterDecision {
  readonly intent: Intent;
  /**
   * NOT LOAD-BEARING. ADR-0010 amendment 2 (post-baseline).
   *
   * The Sprint 2 baseline showed all 40 cases at >= 0.90, with the
   * LLM emitting exactly 0.90 on every case including both
   * misclassifications. No threshold on this field distinguishes
   * correct from incorrect predictions. GW-11 does not consume it.
   * Kept in the interface so future calibrated-confidence work
   * (Sprint 3+) does not need another shape change.
   */
  readonly confidence: number;
  /** Short human-readable trace: rule name, or LLM rationale. */
  readonly rationale: string;
  /** Which layer set the intent. Feeds observability. */
  readonly matched: 'rule' | 'llm';
  /**
   * A safety-signal rule (adversarial pattern) fired on this query.
   * ADR-0010 amendment 1. Orthogonal to `intent` — a message can be
   * `intent: 'fit'` and `adversarialSuspected: true` simultaneously
   * when a legitimate query carries an injection payload.
   * GW-11 policy decides what to do with the combination.
   */
  readonly adversarialSuspected: boolean;
  /** Name of the safety-signal rule that matched, when applicable. */
  readonly adversarialPattern?: string;
  /**
   * ADR-0010 amendment 3 (2026-09-17, Sprint 3) — reverses the original
   * "Entity extraction" non-goal. Feeds ADR-0014's Tier 1 route-based
   * dispatch: intent === 'product' && productQuery !== undefined fires
   * a deterministic tool call (per ADR-0016). Absent when the query is
   * compound, ambiguous, or non-product; also absent for non-product
   * intents (the field has no meaning there).
   *
   * The rule pass extracts common shapes ("do you sell X", "how much
   * is X", "do you stock X"); the LLM pass covers the residual. Both
   * populate this field. See ADR-0016 §4 for the tool-side semantics
   * and the separate `product_query_extraction_accuracy` metric that
   * measures this field's correctness (it does not ride on
   * `intent_classification_accuracy`).
   */
  readonly productQuery?: string;
  /**
   * Sprint 4 (Tier-1 route-based dispatch). Symmetric with
   * `productQuery`: a postcode-shaped substring extracted from the
   * query when intent === 'logistics'. When set, the Tier-1 planner
   * fires `logistics.delivery_zone { postcode }`. The value is
   * intentionally not-yet-normalised — the delivery-zone tool owns
   * the outward-code extraction (see delivery-zone-tool.ts's
   * `extractOutwardCode`).
   *
   * Absent when the query is a general delivery question ("how much
   * is delivery?"), a compound message, or non-logistics intent.
   */
  readonly postcode?: string;
}

export interface Router {
  route(query: RouterQuery): Promise<RouterDecision>;
}
