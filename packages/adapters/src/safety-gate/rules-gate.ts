/**
 * Rules-based safety gate. ADR-0011.
 *
 * Three-step dispatch:
 *   1. Look up the intent's default behaviour (intent-policy).
 *   2. If the default is `answer`, check tag rules; a matching rule
 *      overrides the default with an escalate behaviour.
 *   3. Return. Adversarial signal is preserved on the response
 *      wrapper elsewhere; this layer does not override intent-based
 *      behaviour on adversarial-suspected legitimate intents (ADR-0011
 *      rule 4 — case 030 must still answer).
 */
import type { Behaviour, RouterDecision, RouterQuery, SafetyGate } from '@groundwork/core';

import { INTENT_DEFAULT_BEHAVIOUR } from './intent-policy.js';
import { matchTagRule } from './tag-rules.js';

export class RulesSafetyGate implements SafetyGate {
  decide(decision: RouterDecision, query: RouterQuery): Behaviour {
    const defaultBehaviour = INTENT_DEFAULT_BEHAVIOUR[decision.intent];

    // Tag rules only refine the answer default. Escalate/abstain
    // defaults are deterministic per ADR-0011 and are not further
    // subdivided at this layer.
    if (defaultBehaviour.kind !== 'answer') {
      return defaultBehaviour;
    }

    const tagMatch = matchTagRule(decision.intent, query.text);
    if (tagMatch !== null) {
      return tagMatch.behaviour;
    }

    return defaultBehaviour;
  }
}
