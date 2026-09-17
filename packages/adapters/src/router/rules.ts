/**
 * Rules layer of the hybrid intent router. ADR-0010.
 *
 * Two kinds of rules, doing two different jobs.
 *
 * **Safety-signal rules** match canonical adversarial shapes and
 * emit `adversarialSuspected: true` without setting intent. They
 * fire orthogonally to intent classification — a message can carry
 * both a legitimate customer question and an injection attempt, and
 * the router now records both facts. ADR-0010 amendment 1
 * (post-baseline) explains why: case 030 in the pre-tuning
 * measurement showed the earlier "adversarial rule sets intent to
 * out-of-scope" shape collapsed a fit query into a refusal because
 * the fit query happened to also contain an injection payload.
 *
 * **Intent-shortcut rules** match phrasings for which a regex is a
 * cheap correct answer — service-referral shapes and order-status
 * shapes. They set intent with `matched: 'rule'`. Only these two
 * intent classes get rule shortcuts today; every other class goes
 * to the LLM.
 *
 * On eval hygiene: safety-rule patterns are drawn from public
 * prompt-injection corpora, not from the golden set. Intent-shortcut
 * patterns are drawn from canonical customer-service phrasings, not
 * from the golden set. The golden 036–038 adversarial cases match
 * the safety patterns for the same reason a spam filter catches
 * viagra spam — they are the canonical attack shapes. See the
 * `router-baseline.md` post-baseline note for what 1.00 on
 * SME-authored cases demonstrates and does not.
 */

import type { Intent } from '@groundwork/core';

// ---------- Safety-signal rules ----------

export interface SafetyRule {
  readonly name: string;
  readonly pattern: RegExp;
}

export const SAFETY_RULES: readonly SafetyRule[] = [
  {
    name: 'adversarial:ignore-previous-instructions',
    pattern:
      /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?|directives?)\b/i,
  },
  {
    name: 'adversarial:dan-jailbreak',
    pattern: /\b(you\s+are|act\s+as|pretend\s+to\s+be)\s+(now\s+)?dan\b|\bdo\s+anything\s+now\b/i,
  },
  {
    name: 'adversarial:role-play-bot',
    pattern: /\b(let'?s\s+play\s+a\s+game|you'?re\s+(now\s+)?)?[A-Z]{3,}BOT\b/,
  },
  {
    name: 'adversarial:pretend-you-are',
    pattern:
      /\bpretend\s+(that\s+)?you\s+(are|were)\s+(an?\s+)?(ai|assistant|chatbot|bot)\s+(with\s+no|without\s+any|that\s+has\s+no)\s+(restrictions?|limits?|safety|guardrails?)\b/i,
  },
  {
    name: 'adversarial:reveal-system-prompt',
    pattern:
      /\b(print|show|reveal|output|display|share)\s+(me\s+)?(your\s+)?(system|initial|original)\s+(prompt|instructions?|message)\b/i,
  },
  {
    name: 'adversarial:jailbreak-keyword',
    pattern: /\bjailbreak\b|\bbypass\s+(all\s+)?(safety\s+)?(restrictions?|guardrails?|limits?)\b/i,
  },
];

export interface SafetyMatch {
  readonly rule: SafetyRule;
}

/** First safety rule that matches, or null. */
export function matchSafetyRule(query: string): SafetyMatch | null {
  for (const rule of SAFETY_RULES) {
    if (rule.pattern.test(query)) return { rule };
  }
  return null;
}

// ---------- Intent-shortcut rules ----------

export interface IntentRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly intent: Intent;
}

export const INTENT_RULES: readonly IntentRule[] = [
  {
    name: 'service-referral:fitting-service',
    pattern:
      /\bdo\s+you\s+(do|offer|provide|run)\s+(a\s+|any\s+)?(hat|saddle|bridle|bit)\s+fittings?\b/i,
    intent: 'service-referral',
  },
  {
    name: 'logistics:order-status',
    pattern: /\bi\s+ordered\b.*\b(when|where|delivery|arrive|arriving|status|update|tracking)\b/i,
    intent: 'logistics',
  },
];

export interface IntentMatch {
  readonly rule: IntentRule;
}

/** First intent-shortcut rule that matches, or null. */
export function matchIntentRule(query: string): IntentMatch | null {
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(query)) return { rule };
  }
  return null;
}

// ---------- Product-query extraction (ADR-0016 §4) ----------
//
// Regex-based extraction for the common phrasings named in ADR-0016:
// "do you sell X", "do you stock X", "how much is X". Defence-in-
// depth alongside the LLM classifier's own extraction; either can
// populate RouterDecision.productQuery.
//
// Not exhaustive by design. Compound queries, referential pronouns,
// and paraphrased phrasings fall through to the LLM. The regex
// exists to guarantee a productQuery on the common shape when the
// LLM misses (e.g. on transient API failure the classifier defaults
// to out-of-scope + null productQuery; the regex still catches the
// obvious "do you sell X" case).
//
// Case preservation matters — brand names ("CSJ", "Thunderbrook",
// "Haygates") are proper nouns and are meaningful to the retriever
// as capitalised strings. Extraction preserves case.
//
// The tail-stripping list drops "please/thanks/pls/still/in stock"
// noise that would otherwise degrade retrieval by adding non-product
// tokens to the match query.

const PRODUCT_EXTRACT_PATTERNS: readonly RegExp[] = [
  // "do you sell / stock / stocking / have / carry X"
  // Also "are you (currently) stocking X" — accepted via optional "are".
  /\b(?:do|are)\s+you\s+(?:currently\s+|going\s+to\s+|only\s+)?(?:sell|stock|stocking|have|carry|carrying|got)\s+(?:any\s+|the\s+)?(.+?)(?=\s*[?.,!]|\s+(?:in\s+stock|still|please|pls|thanks?|thx|by\s+any\s+chance|at\s+all)\b|$)/i,
  // "how much is / are X" / "how much (is|are) the/your X"
  /\bhow\s+much\s+(?:is|are|does)\s+(?:your\s+|the\s+|a\s+bag\s+of\s+)?(.+?)(?=\s*[?.,!]|\s+(?:cost|per\s+|still|please|pls|thanks?|thx)\b|$)/i,
  // "what is your cost of X" / "cost per bale of X"
  /\b(?:cost|price)\s+(?:per\s+\w+\s+)?of\s+(.+?)(?=\s*[?.,!]|\s+(?:please|pls|thanks?|thx)\b|$)/i,
];

// Tokens that on their own carry no product-signal — pronouns,
// context-referential words, quantifiers, and empty-set nouns.
// An extraction composed *entirely* of these is referential ("of
// those", "any of them", "some more") rather than a product-string.
const REFERENTIAL_TOKENS = new Set([
  'it',
  'that',
  'them',
  'one',
  'ones',
  'this',
  'these',
  'those',
  'stock',
  'anything',
  'something',
  'of',
  'the',
  'a',
  'an',
  'any',
  'some',
  'more',
  'other',
  'another',
  'all',
  'each',
]);

function isContextReferential(str: string): boolean {
  const tokens = str
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  return tokens.every((t) => REFERENTIAL_TOKENS.has(t));
}

/**
 * Attempt regex extraction of the product-string from a customer
 * query. Returns the extracted string trimmed and with trailing
 * courtesies stripped, or null when no pattern matched or the
 * extracted string is entirely composed of context-referential
 * tokens ("of those", "any of them") that carry no product-signal.
 */
export function extractProductQuery(query: string): string | null {
  for (const pattern of PRODUCT_EXTRACT_PATTERNS) {
    const match = pattern.exec(query);
    if (!match || !match[1]) continue;
    const raw = match[1].trim();
    if (raw.length < 3) continue;
    if (isContextReferential(raw)) continue;
    return raw;
  }
  return null;
}
