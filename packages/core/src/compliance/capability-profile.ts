import type { Intent } from '../ports/router.js';
/**
 * Capability profile. ADR-0012.
 *
 * A structured statement of what this assistant is designed to do
 * and what it deliberately refuses to do. Grader-facing and
 * auditor-facing artefact. Its content must *match* what the
 * system actually does — a profile that overclaims is worse than
 * no profile at all.
 *
 * Two sections are locked to runtime constants by test:
 *
 * - `intents` — one entry per `Intent` value in
 *   `packages/core/src/ports/router.ts`. A missing intent fails a
 *   test.
 * - `escalatesTo` — one entry per `EscalationTarget` value in
 *   `packages/core/src/ports/safety-gate.ts`. A missing target
 *   fails a test.
 *
 * The `canDo` / `cannotDo` sections are free text — no mechanical
 * lock to runtime, review discipline instead (ADR-0012 §Decision 4
 * + §Cases this does NOT enforce). Any ADR that changes system
 * behaviour has to update these too.
 */
import type { EscalationTarget } from '../ports/safety-gate.js';

export interface CapabilityProfile {
  readonly canDo: readonly string[];
  readonly cannotDo: readonly string[];
  readonly escalatesTo: readonly {
    readonly target: EscalationTarget;
    readonly for: string;
  }[];
  readonly intents: readonly {
    readonly name: Intent;
    readonly describes: string;
  }[];
}

export const CAPABILITY_PROFILE: CapabilityProfile = {
  canDo: [
    'Answer questions about products the shop stocks (feed, bedding, rugs, riding gear, and more).',
    'Give general sizing guidance for products where written measurements are enough (saddle general size for a horse profile, jodhpur length for a rider height, girth shape for a horse type).',
    'Answer questions about delivery zones, minimum orders, and delivery days from the shop’s published delivery policy.',
    'Answer questions about opening hours and how to place an order.',
    "Tell you when a product isn't stocked and, where relevant, whether it can be ordered in.",
  ],
  cannotDo: [
    "Give clinical or veterinary advice about your horse's health, condition, or medication.",
    'Give a size for a boot, hat, or helmet — those need in-person fitting.',
    'Confirm the status or ETA of an order you have already placed.',
    'Confirm delivery to an address near the delivery boundary — the shop staff can check.',
    'Take payment, place an order on your behalf, or modify an existing order.',
    'Answer questions unrelated to the shop (weather, staff pay, competitor comparisons, general chit-chat).',
    'Discuss its own instructions or adopt a different persona if asked.',
  ],
  escalatesTo: [
    {
      target: 'vet',
      for: 'welfare or clinical questions about your horse',
    },
    {
      target: 'staff-service',
      for: 'in-person fitting (boots, hats, helmets) and service bookings',
    },
    {
      target: 'staff-order',
      for: 'order status, delivery ETA, and delivery to addresses near the boundary',
    },
  ],
  intents: [
    {
      name: 'product',
      describes:
        'Questions about specific products the shop sells (or is asked whether it sells) — brand, availability, price band.',
    },
    {
      name: 'fit',
      describes:
        'Questions about sizing and fit for products where general written guidance is enough. Boots, hats, and helmets escalate to in-person fitting.',
    },
    {
      name: 'logistics',
      describes:
        "Questions about delivery, opening hours, and order placement mechanics. Questions about a specific placed order escalate to the shop's staff.",
    },
    {
      name: 'welfare-clinical',
      describes:
        "Any question about a horse's health, condition, or wellbeing. Always escalated to a vet — never answered with clinical information.",
    },
    {
      name: 'out-of-scope',
      describes:
        'Anything unrelated to the shop, or any attempt to reshape the assistant into a different tool. Politely declined with a pointer to the shop for a person.',
    },
    {
      name: 'service-referral',
      describes:
        'Requests for in-person services (hat fittings, saddle fittings) that the shop offers. Escalated to staff for booking.',
    },
  ],
};
