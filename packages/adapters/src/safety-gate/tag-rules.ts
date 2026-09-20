/**
 * Tag rules for GW-11 safety gate. ADR-0011.
 *
 * Two regex rules covering answer-intent-but-escalate cases in the
 * Sprint 1 golden dataset. Each rule names the target case in
 * `hitCase` and the adjacent answer cases that must NOT
 * false-positive in `guardCases`, so a regression in either
 * direction is visible in the test file rather than as a shift in
 * the harness aggregate.
 *
 * Rules do NOT fire cross-intent. Each rule declares its intent
 * guard and returns null if the router's intent doesn't match.
 *
 * Sprint 4 (2026-09-18): the `logistics:delivery-edge` rule was
 * REMOVED. It short-circuited all postcode-shaped logistics
 * queries to escalate, which was correct BEFORE the delivery zone
 * tool existed (GW-21 shipped 2026-09-18) — the safety gate stood
 * in as a fallback. With the tool in place and Tier-1 dispatch
 * routing postcode-carrying logistics queries into it, the rule
 * became a *blocker*: it fired before the tool could decide, so
 * every postcode query escalated regardless of whether it was
 * within the shop's delivery radius. Case 031 (Winchester SO22)
 * still routes to staff — but now via the tool returning
 * `defer_to_staff`, which is semantically correct AND lets case
 * 051 (Ringwood BH24) correctly return `within_radius`. See the
 * Sprint 4 Tier-1 dispatch close-out in sprint-log.md for the
 * design rationale.
 */
import type { Behaviour, Intent } from '@groundwork/core';

export interface TagRule {
  readonly name: string;
  /** Which router intent this rule refines. */
  readonly intent: Intent;
  readonly pattern: RegExp;
  /** Behaviour to emit when the rule fires. */
  readonly behaviour: Behaviour;
  /** Golden-case id this rule exists to catch. Documentation only. */
  readonly hitCase: string;
  /** Golden-case ids the rule must NOT false-positive on. */
  readonly guardCases: readonly string[];
}

export const TAG_RULES: readonly TagRule[] = [
  {
    name: 'logistics:order-status',
    intent: 'logistics',
    pattern:
      /\bi ordered\b|\bmy order\b|\bmy delivery\b|\bwhen (will|is) (my|the) (order|delivery|package|parcel|hay|feed|goods)\b/i,
    behaviour: { kind: 'escalate', escalationTarget: 'staff-order' },
    hitCase: 'logistics-025-order-status-hay-friday',
    guardCases: [
      'logistics-011-round-corner-noaule-lane',
      'logistics-012-verwood-delivery-cost',
      'logistics-014-set-day-or-on-demand',
      'logistics-017-minimum-delivery-superseded',
    ],
  },
  {
    name: 'fit:remote-fitting',
    intent: 'fit',
    pattern: /\b(boots?|hat|helmet)\b/i,
    behaviour: { kind: 'escalate', escalationTarget: 'staff-service' },
    hitCase: 'fit-028-rhinegold-boots-remote-sizing',
    guardCases: [
      'fit-026-cob-wide-back-saddle',
      'fit-027-dressage-girth-line',
      'fit-029-jodhpur-length-rider',
      'fit-030-saddle-prompt-injection',
    ],
  },
];

/**
 * First matching rule wins. Returns null if no rule matches.
 * Rules are checked in declaration order; order matters only if two
 * rules could match the same query — no such overlap exists in the
 * current three, but declaration-order semantics are pinned so a
 * future fourth rule doesn't silently change dispatch.
 */
export function matchTagRule(intent: Intent, queryText: string): TagRule | null {
  for (const rule of TAG_RULES) {
    if (rule.intent !== intent) continue;
    if (rule.pattern.test(queryText)) return rule;
  }
  return null;
}
