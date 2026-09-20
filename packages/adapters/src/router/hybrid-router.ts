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

import type { CircuitBreaker, Router, RouterDecision, RouterQuery } from '@groundwork/core';
import type OpenAI from 'openai';

import { classifyWithLLM } from './llm-classifier.js';
import { extractProductQuery, matchIntentRule, matchSafetyRule } from './rules.js';

export class HybridRouter implements Router {
  constructor(
    private readonly openai: OpenAI,
    /** Optional per-dependency breaker. GW-23. When present, wraps
     *  the LLM classifier call; on open, the caller receives the
     *  breaker's throw and converts to graceful-escalate at the
     *  request boundary. Intent-shortcut rules bypass the LLM and
     *  therefore bypass the breaker — that's intentional (they
     *  don't hit openai). */
    private readonly openaiBreaker?: CircuitBreaker,
  ) {}

  async route(query: RouterQuery): Promise<RouterDecision> {
    const safety = matchSafetyRule(query.text);
    const adversarialSuspected = safety !== null;

    const intentRule = matchIntentRule(query.text);
    let base: Omit<RouterDecision, 'adversarialSuspected' | 'adversarialPattern'>;

    if (intentRule) {
      // Intent-shortcut rules today only cover service-referral +
      // logistics:order-status. Neither is a product intent, so
      // productQuery is not populated on this branch.
      base = {
        intent: intentRule.rule.intent,
        confidence: 1.0,
        rationale: `matched pattern: ${intentRule.rule.name}`,
        matched: 'rule',
      };
    } else {
      const llm = await (this.openaiBreaker
        ? this.openaiBreaker.run(() => classifyWithLLM(this.openai, query.text))
        : classifyWithLLM(this.openai, query.text));
      // Defence-in-depth: on product-intent, if the LLM didn't extract
      // (transient error path returns null, or the LLM missed a common
      // shape), the regex extractor gets a second attempt. ADR-0016 §4.
      const productQuery =
        llm.intent === 'product'
          ? (llm.productQuery ?? extractProductQuery(query.text) ?? undefined)
          : undefined;
      base = {
        intent: llm.intent,
        confidence: llm.confidence,
        rationale: llm.rationale,
        matched: 'llm',
        ...(productQuery !== undefined ? { productQuery } : {}),
      };
    }

    return safety
      ? { ...base, adversarialSuspected, adversarialPattern: safety.rule.name }
      : { ...base, adversarialSuspected };
  }
}
