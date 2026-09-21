/**
 * HybridRouter — the composed router. ADR-0010.
 *
 * Four layers, in order:
 *   1. Safety-signal rules — record `adversarialSuspected` and the
 *      pattern that matched. Do NOT set intent.
 *   2. Intent-shortcut rules — set intent for service-referral or
 *      order-status shapes. If hit, skip the LLM.
 *   3. Shop-info topic extractor (Sprint 4) — if the query matches
 *      a contact / hours / address / ordering phrasing, force
 *      intent=logistics via rule-shortcut style. The LLM was
 *      classifying "what is your number?" as out-of-scope, which
 *      then abstained ironically. This layer catches those
 *      phrasings BEFORE the LLM sees them.
 *   4. LLM classifier — describes the underlying intent. Runs
 *      regardless of whether the safety layer fired, and its
 *      classification stands even when adversarialSuspected is true
 *      (the fit-with-injection case; ADR-0010 amendment 1).
 *
 * The safety signal always attaches to the final decision, whether
 * intent was set by rule, shop-info extractor, or LLM.
 */

import type { CircuitBreaker, Router, RouterDecision, RouterQuery } from '@groundwork/core';
import type OpenAI from 'openai';

import { classifyWithLLM } from './llm-classifier.js';
import {
  extractPostcode,
  extractProductQuery,
  extractShopInfoTopic,
  matchIntentRule,
  matchSafetyRule,
} from './rules.js';

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
      // Intent-shortcut rules today cover service-referral +
      // logistics:order-status. Service-referral has no entity to
      // extract; the order-status shape IS a logistics intent, so
      // extract a postcode if one's present (order-status queries
      // can still carry a postcode — "I ordered to BH24, any
      // update?"). productQuery stays absent on this branch (no
      // rule shortcut fires for product intent).
      const postcode =
        intentRule.rule.intent === 'logistics'
          ? (extractPostcode(query.text) ?? undefined)
          : undefined;
      base = {
        intent: intentRule.rule.intent,
        confidence: 1.0,
        rationale: `matched pattern: ${intentRule.rule.name}`,
        matched: 'rule',
        ...(postcode !== undefined ? { postcode } : {}),
      };
    } else if (extractShopInfoTopic(query.text)) {
      // Sprint 4 shop-info shortcut. Force intent=logistics + set
      // the topic. Bypasses the LLM entirely, which was
      // misclassifying these as out-of-scope.
      const shopInfoTopic = extractShopInfoTopic(query.text);
      // Non-null: we just checked. TypeScript narrowing across the
      // else-if doesn't reach here, so re-assert.
      if (!shopInfoTopic) throw new Error('unreachable');
      // Even shop-info-shaped queries can carry a postcode ("what's
      // your number for delivery to BH24?"). Extract if present so
      // the planner can decide priority.
      const postcode = extractPostcode(query.text) ?? undefined;
      base = {
        intent: 'logistics',
        confidence: 1.0,
        rationale: `matched shop-info topic: ${shopInfoTopic}`,
        matched: 'rule',
        shopInfoTopic,
        ...(postcode !== undefined ? { postcode } : {}),
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
      // Sprint 4: symmetric with productQuery. Rule-based only for now
      // (the classifier doesn't emit a postcode field). Extraction is
      // permissive; the tool owns normalisation and district lookup.
      const postcode =
        llm.intent === 'logistics'
          ? (extractPostcode(query.text) ?? undefined)
          : undefined;
      // Defence-in-depth on logistics intent: if the LLM correctly
      // classified but the query is a shop-info topic, populate the
      // hint so the planner can dispatch shop_info. The shortcut
      // above handles the pre-LLM case; this handles the LLM-agrees
      // case.
      const shopInfoTopic =
        llm.intent === 'logistics'
          ? (extractShopInfoTopic(query.text) ?? undefined)
          : undefined;
      base = {
        intent: llm.intent,
        confidence: llm.confidence,
        rationale: llm.rationale,
        matched: 'llm',
        ...(productQuery !== undefined ? { productQuery } : {}),
        ...(postcode !== undefined ? { postcode } : {}),
        ...(shopInfoTopic !== undefined ? { shopInfoTopic } : {}),
      };
    }

    return safety
      ? { ...base, adversarialSuspected, adversarialPattern: safety.rule.name }
      : { ...base, adversarialSuspected };
  }
}
