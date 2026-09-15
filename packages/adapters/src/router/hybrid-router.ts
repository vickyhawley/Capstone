/**
 * HybridRouter — the composed router. ADR-0010.
 *
 * Three layers, in order:
 *   1. Safety-signal rules — record `adversarialSuspected` and the
 *      pattern that matched. Do NOT set intent.
 *   2. Intent-shortcut rules — set intent for service-referral or
 *      order-status shapes. If hit, skip the LLM.
 *   3. LLM classifier — describes the underlying intent. Runs
 *      regardless of whether the safety layer fired, and its
 *      classification stands even when adversarialSuspected is true
 *      (the fit-with-injection case; ADR-0010 amendment 1).
 *
 * The safety signal always attaches to the final decision, whether
 * intent was set by an intent-shortcut rule or by the LLM.
 */

import type { Router, RouterDecision, RouterQuery } from '@groundwork/core';
import type OpenAI from 'openai';

import { classifyWithLLM } from './llm-classifier.js';
import { matchIntentRule, matchSafetyRule } from './rules.js';

export class HybridRouter implements Router {
  constructor(private readonly openai: OpenAI) {}

  async route(query: RouterQuery): Promise<RouterDecision> {
    const safety = matchSafetyRule(query.text);
    const adversarialSuspected = safety !== null;

    const intentRule = matchIntentRule(query.text);
    const base = intentRule
      ? {
          intent: intentRule.rule.intent,
          confidence: 1.0,
          rationale: `matched pattern: ${intentRule.rule.name}`,
          matched: 'rule' as const,
        }
      : {
          ...(await classifyWithLLM(this.openai, query.text)),
          matched: 'llm' as const,
        };

    return safety
      ? { ...base, adversarialSuspected, adversarialPattern: safety.rule.name }
      : { ...base, adversarialSuspected };
  }
}
