/**
 * Test-only stub. Returns a fixed decision. Lets test fixtures build
 * pipelines without an OpenAI client, same pattern as StubRetriever.
 */

import type { Intent, Router, RouterDecision, RouterQuery } from '@groundwork/core';

export class StubRouter implements Router {
  constructor(private readonly intent: Intent = 'product') {}

  async route(_query: RouterQuery): Promise<RouterDecision> {
    return {
      intent: this.intent,
      confidence: 1.0,
      rationale: 'stub',
      matched: 'rule',
      adversarialSuspected: false,
    };
  }
}
