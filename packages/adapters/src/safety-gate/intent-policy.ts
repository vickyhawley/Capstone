/**
 * Deterministic intent → default behaviour table. ADR-0011.
 *
 * Three intents map to a single behaviour with no query-content
 * inspection: welfare-clinical always escalates, out-of-scope always
 * abstains, service-referral always escalates. Two intents (product,
 * fit) default to answer. Logistics defaults to answer.
 *
 * The three "answer-default but sometimes escalate" cases (025, 028,
 * 031 in the Sprint 1 golden set) are handled by tag rules on top of
 * this table; see `tag-rules.ts`.
 */
import type { Behaviour, Intent } from '@groundwork/core';

type DefaultBehaviour = Behaviour;

export const INTENT_DEFAULT_BEHAVIOUR: Readonly<Record<Intent, DefaultBehaviour>> = {
  'welfare-clinical': { kind: 'escalate', escalationTarget: 'vet' },
  'out-of-scope': { kind: 'abstain', refusalReason: 'out-of-scope' },
  'service-referral': { kind: 'escalate', escalationTarget: 'staff-service' },
  product: { kind: 'answer' },
  fit: { kind: 'answer' },
  logistics: { kind: 'answer' },
};
