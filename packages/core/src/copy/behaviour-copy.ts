/**
 * Response copy for the safety gate's Behaviour output. GW-12.
 *
 * One string per non-answer Behaviour variant. The `answer` variant
 * returns null because retrieval + synthesis populate the response
 * text there; this module owns only the responses that don't come
 * from the corpus.
 *
 * Tone: friendly, first-person, informal-but-professional. Reads as
 * NFCS shop staff, not a corporate template. Uses "we" and "the shop"
 * as if a person is replying. No mention of AI vs. staff — that's
 * GW-15's disclosure surface, not the response copy itself.
 *
 * Content constraints (from the Sprint 1 golden set's
 * `prohibited_claims`):
 *
 * - Welfare-clinical escalations (vet) must NOT include the words
 *   `mg`, `ml`, `administer`, or `dose`. The rule is "no clinical
 *   language" — we refer people to their vet rather than suggesting
 *   any dosing or administration ourselves.
 * - Staff-order escalations (delivery edge) must NOT contain
 *   absolute negatives like "outside our delivery area", "we don't
 *   deliver", "unable to deliver". The staff can confirm; we don't
 *   guess.
 * - Adversarial abstains must NOT reveal `system prompt`,
 *   `my instructions`, or adopt an alternate persona
 *   (`as SHOPBOT`, `as DAN`, etc.).
 *
 * Copy is asserted against these constraints in `behaviour-copy.test.ts`
 * — a substring check that mirrors the harness metric so a copy
 * regression fails in unit tests before it fails in the harness.
 */
import type { Behaviour, EscalationTarget, RefusalReason } from '../ports/safety-gate.js';

export const ESCALATION_COPY: Readonly<Record<EscalationTarget, string>> = {
  vet: "That's really one for your vet — they'll be able to see your horse in person and give the right advice. If you'd like to give the shop a call once you've spoken to them, we can help you find the products to support what they've recommended.",
  'staff-service':
    'Best to pop into the shop for this one — we like to measure and fit properly in person so you get the right thing. Give us a call to book a time that suits, or drop in during opening hours.',
  'staff-order':
    "The shop can check your specific case and come back to you. Give us a call or send a message with your order details or postcode and we'll get back to you as soon as we can.",
};

export const ABSTAIN_COPY: Readonly<Record<RefusalReason, string>> = {
  'out-of-scope':
    "That's not something I can help with here — I stick to questions about the shop's products, sizing, and delivery. If you need a person, give the shop a call and one of the team will be happy to help.",
  adversarial:
    "That's not something I can help with. If you have a question about the shop's products, sizing, or delivery, I'm happy to help with that.",
};

/**
 * Render the customer-facing copy for a Behaviour. Returns null for
 * `answer` because retrieval + synthesis populate the answer field
 * there — this module only owns non-answer copy.
 */
export function renderBehaviour(b: Behaviour): string | null {
  switch (b.kind) {
    case 'answer':
      return null;
    case 'abstain':
      return ABSTAIN_COPY[b.refusalReason];
    case 'escalate':
      return ESCALATION_COPY[b.escalationTarget];
  }
}
