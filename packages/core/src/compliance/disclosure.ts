/**
 * Article 50 disclosure text. ADR-0012.
 *
 * The single string a compliant surface must show the user before
 * the interaction proceeds. Content requirements (ADR-0012 §Artefact
 * shape → Disclosure):
 *
 * - States the user is talking to an AI assistant, not shop staff.
 * - Names the corpus the AI is answering from.
 * - Names what it will not do (routes to a vet for clinical, staff
 *   for order status).
 * - Names how to reach a person.
 *
 * Phrasing rule (ADR-0012 §Decision 5): use "AI assistant". Do not
 * substitute "bot", "our assistant", or unqualified "assistant"
 * without documenting a reason.
 *
 * Constraint compliance is verified in `disclosure.test.ts` — a
 * regression on any of the required phrases fails a test before
 * it fails an audit.
 */

export const ARTICLE_50_DISCLOSURE =
  "You're chatting with an AI assistant, not a member of the NFCS team. " +
  "I answer using the shop's published product catalogue and policies. " +
  'I can help with questions about products, sizing, delivery, and where ' +
  "to find things — but I'll refer you to your vet for anything clinical " +
  "or about your horse's health, and to the shop staff for questions about " +
  'a specific order, in-person fitting for boots or hats, or anything ' +
  "outside the shop's day-to-day. To reach a person directly, give the " +
  'shop a call or drop in during opening hours.';
