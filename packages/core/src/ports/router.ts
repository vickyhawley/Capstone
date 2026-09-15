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
}

export interface Router {
  route(query: RouterQuery): Promise<RouterDecision>;
}
