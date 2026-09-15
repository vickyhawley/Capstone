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
  /** [0, 1]. Rule matches emit 1.0; LLM classifier emits its own estimate. */
  readonly confidence: number;
  /** Short human-readable trace: rule name, or LLM rationale. */
  readonly rationale: string;
  /** Which layer decided. Feeds observability. */
  readonly matched: 'rule' | 'llm';
}

export interface Router {
  route(query: RouterQuery): Promise<RouterDecision>;
}
