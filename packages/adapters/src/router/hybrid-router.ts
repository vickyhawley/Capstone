/**
 * HybridRouter — the composed router. ADR-0010.
 *
 * Rules pass first; on a rule miss, delegate to the LLM classifier.
 * This is the shape the API server uses; the pipeline calls
 * `router.route({ text })` and passes the decision to the safety gate.
 */

import type { Router, RouterDecision, RouterQuery } from '@groundwork/core';
import type OpenAI from 'openai';

import { classifyWithLLM } from './llm-classifier.js';
import { matchRule } from './rules.js';

export class HybridRouter implements Router {
  constructor(private readonly openai: OpenAI) {}

  async route(query: RouterQuery): Promise<RouterDecision> {
    const ruleMatch = matchRule(query.text);
    if (ruleMatch) {
      return {
        intent: ruleMatch.rule.intent,
        confidence: 1.0,
        rationale: `matched pattern: ${ruleMatch.rule.name}`,
        matched: 'rule',
      };
    }

    const llm = await classifyWithLLM(this.openai, query.text);
    return { ...llm, matched: 'llm' };
  }
}
