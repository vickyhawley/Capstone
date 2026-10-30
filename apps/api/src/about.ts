/**
 * GET /api/about — Article 50 disclosure + capability profile. ADR-0012.
 *
 * Serves the constants from @groundwork/core as JSON. No auth, no
 * per-request computation, no route deps. Snake_case at the boundary
 * matches the ApiResponse convention (`disclosure`, `capability_profile`,
 * `can_do`, `cannot_do`, `escalates_to`).
 *
 * Not attached to /api/answer per-response per ADR-0012 §Decision 2 —
 * disclosure content is stable and shouldn't inflate every turn's
 * payload.
 */
import {
  ARTICLE_50_DISCLOSURE,
  CAPABILITY_PROFILE,
  DEGRADED_FALLBACK,
  STAFF_CONTACT,
} from '@groundwork/core';
import { Hono } from 'hono';

export function createAboutRoute(): Hono {
  const route = new Hono();
  route.get('/', (c) =>
    c.json({
      disclosure: ARTICLE_50_DISCLOSURE,
      capability_profile: {
        can_do: CAPABILITY_PROFILE.canDo,
        cannot_do: CAPABILITY_PROFILE.cannotDo,
        escalates_to: CAPABILITY_PROFILE.escalatesTo,
        intents: CAPABILITY_PROFILE.intents,
      },
      // Added for the embed widget: concrete escalation details so a
      // degraded-mode panel can render a phone + email without a
      // redeploy of the API. Snake_case at the boundary matches the
      // ApiResponse convention already used by capability_profile.
      escalation: {
        phone: STAFF_CONTACT.phone,
        email: STAFF_CONTACT.email,
        opening_hours: STAFF_CONTACT.openingHours,
      },
      degraded_fallback: DEGRADED_FALLBACK,
    }),
  );
  return route;
}
