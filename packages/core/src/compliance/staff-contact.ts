/**
 * Staff contact + degraded-mode fallback copy.
 *
 * Served by `/api/about` so the embed widget can render concrete
 * escalation details (phone, email, opening hours) without a redeploy
 * cycle: edit here, publish core, API picks it up.
 *
 * Placeholders use the TODO_ prefix as a sentinel. The paired
 * `staff-contact.test.ts` fails if any field is still at a sentinel
 * value, so CI (and `pnpm -w test`) stays red until real values are
 * supplied. Treat the test failure the same as a typecheck failure.
 *
 * Phrasing rule for `DEGRADED_FALLBACK`: do NOT use veterinary framing
 * ("vet knowledge bot", "equine clinical assistant"). The assistant is
 * a shopping surface for NFCS and the safety gate routes welfare
 * questions to a vet by design. Framing a quiescent bot as a vet-ish
 * thing cuts across that boundary.
 */

export interface StaffContact {
  readonly phone: string;
  readonly email: string;
  readonly openingHours: string;
}

export const STAFF_CONTACT: StaffContact = {
  phone: '01425 201301',
  email: 'dan@newforestcountrystore.co.uk',
  // Phrased to read naturally after "We're open " in DEGRADED_FALLBACK.
  openingHours: '8:30am–6pm Monday to Saturday, and 9am–2pm on Sunday',
};

/**
 * Rendered to the user when the daily spend cap is tripped or the
 * answer pipeline fails after retries. Kept short, non-clinical, and
 * action-giving: a phone number + an email, nothing else.
 */
export const DEGRADED_FALLBACK =
  'Our chat assistant is resting. Please call NFCS on ' +
  `${STAFF_CONTACT.phone} or email ${STAFF_CONTACT.email}. ` +
  `We're open ${STAFF_CONTACT.openingHours}.`;
