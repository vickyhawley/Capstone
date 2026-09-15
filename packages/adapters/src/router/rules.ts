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
