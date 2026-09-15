/**
 * Rules layer of the hybrid intent router. ADR-0010.
 *
 * Regex-based fast path for classes with strong, canonical lexical
 * signals. Runs before the LLM classifier — a hit here means we don't
 * pay the LLM latency and the decision is auditable ("we matched
 * pattern X" is a stronger claim than "the LLM decided").
 *
 * On eval hygiene: the patterns below are canonical attack / query
 * shapes drawn from what is publicly known about prompt-injection
 * corpora, standard customer-service phrasings, and the shop's
 * SME-defined service list. They are NOT derived from the golden
 * dataset. The golden cases 036–038 happen to match these patterns
 * because those cases *are* the canonical attack shapes — the rules
 * catch them for the same reason a spam filter catches Viagra spam,
 * not because we peeked at the test set. This distinction matters
 * because ADR-0010's stated bar is that 1.00 on six SME-authored
 * cases demonstrates the rules match the rules; the real test
 * arrives with GW-14's red-team expansion.
 *
 * Rules are tried in order; first match wins. Order reflects
 * safety-cost ordering — adversarial first, because a miss there is
 * the worst failure the router can commit.
 */

import type { Intent } from '@groundwork/core';

export interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly intent: Intent;
}

export const RULES: readonly Rule[] = [
  // ---------- Adversarial (→ out-of-scope) ----------
  //
  // Canonical prompt-injection preambles. Case-insensitive; word
  // boundaries where possible so "ignoring" doesn't fire on
  // legitimate use of the word "ignore".
  {
    name: 'adversarial:ignore-previous-instructions',
    pattern:
      /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?|directives?)\b/i,
    intent: 'out-of-scope',
  },
  {
    name: 'adversarial:dan-jailbreak',
    pattern: /\b(you\s+are|act\s+as|pretend\s+to\s+be)\s+(now\s+)?dan\b|\bdo\s+anything\s+now\b/i,
    intent: 'out-of-scope',
  },
  {
    name: 'adversarial:role-play-bot',
    pattern: /\b(let'?s\s+play\s+a\s+game|you'?re\s+(now\s+)?)?[A-Z]{3,}BOT\b/,
    intent: 'out-of-scope',
  },
  {
    name: 'adversarial:pretend-you-are',
    pattern:
      /\bpretend\s+(that\s+)?you\s+(are|were)\s+(an?\s+)?(ai|assistant|chatbot|bot)\s+(with\s+no|without\s+any|that\s+has\s+no)\s+(restrictions?|limits?|safety|guardrails?)\b/i,
    intent: 'out-of-scope',
  },
  {
    name: 'adversarial:reveal-system-prompt',
    pattern:
      /\b(print|show|reveal|output|display|share)\s+(me\s+)?(your\s+)?(system|initial|original)\s+(prompt|instructions?|message)\b/i,
    intent: 'out-of-scope',
  },
  {
    name: 'adversarial:jailbreak-keyword',
    pattern: /\bjailbreak\b|\bbypass\s+(all\s+)?(safety\s+)?(restrictions?|guardrails?|limits?)\b/i,
    intent: 'out-of-scope',
  },

  // ---------- Service-referral (→ service-referral) ----------
  //
  // Narrow list of services the shop can plausibly be asked about.
  // SME-confirmed list: hat fitting, saddle fitting, bridle fitting,
  // bit fitting. Anything the shop doesn't offer will fall through
  // to the LLM and likely land as out-of-scope, which is correct.
  {
    name: 'service-referral:fitting-service',
    pattern:
      /\bdo\s+you\s+(do|offer|provide|run)\s+(a\s+|any\s+)?(hat|saddle|bridle|bit)\s+fitting?s?\b/i,
    intent: 'service-referral',
  },

  // ---------- Logistics: order status (→ logistics) ----------
  //
  // The canonical order-status phrasing: "I ordered X ... [status
  // word]". Rules only fire when both signals present, so
  // "I ordered feed last month" alone doesn't classify. This is
  // deliberately narrower than the LLM would be — the LLM can
  // handle "any update on my order?" and other rephrasings.
  {
    name: 'logistics:order-status',
    pattern: /\bi\s+ordered\b.*\b(when|where|delivery|arrive|arriving|status|update|tracking)\b/i,
    intent: 'logistics',
  },
];

export interface RuleMatch {
  readonly rule: Rule;
}

/**
 * Try every rule in order. Returns the first match, or null. Callers
 * translate the match into a RouterDecision.
 */
export function matchRule(query: string): RuleMatch | null {
  for (const rule of RULES) {
    if (rule.pattern.test(query)) {
      return { rule };
    }
  }
  return null;
}
