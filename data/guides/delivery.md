# Delivery policy

The current delivery policy at New Forest Country Store, confirmed
by the shop owner 2026-09-15. Written to be the single source of
truth for the answer engine — anywhere an older policy is quoted
in the corpus is superseded by this document.

## Current policy

- **Free delivery.** No minimum order value. The shop does not
  charge for delivery, and has decided never to.
- **Radius: 20 miles from the shop.** The origin is the shop
  itself in Ringwood, near Jubilee Park — not "Ringwood" as a
  postcode centroid. Road distance, not straight-line, is what
  matters at the boundary because the two differ enough at
  20 miles to change which side of the line an address falls on.
- **Scheduling.** Two options: the customer picks a set day, or
  the shop delivers when there is a van going that way.
  Same-day is often possible; a day's notice is helpful.
- **Saturdays.** Not a normal delivery day, but the shop will
  make it work for someone stuck.
- **Ordering channel.** Phone or message — customers do not have
  to ring. WhatsApp is fine.

## Edge of the 20-mile radius

The 20-mile radius is a stated policy. In practice, staff have
quoted free delivery to addresses beyond it — sometimes without
realising they were outside. So the boundary has not been
consistently enforced.

**The assistant must not be the first thing to enforce it.**

- **Well inside the radius (e.g. BH24, BH31, SP6, most of the
  BH postcode districts named in `scripts/generate_orders.py`)**
  — answer confidently that free delivery is available.
- **Near the boundary or beyond (e.g. DT11, SO51, SO22, or any
  address the customer flags as "we're just outside") — do not
  refuse. Route to staff.** Phrasing along the lines of "our
  standard radius is 20 miles from the shop; the team can
  confirm for your address" is the right shape. Refusing a
  customer that staff would happily have served is a worse
  failure than deferring.
- The one thing the assistant must never do is invent a
  delivery charge. There is no charge under any policy in force.

## Superseded policy — do not resurface

Earlier customer messages (May–August 2026, pre-opening) quote a
different delivery policy: *free for the first three months, then
a small charge on orders under £200*. That was the shop's
pre-opening intention and is **no longer correct**. It never went
into effect in the form described.

If retrieval surfaces one of those old messages alongside a
current policy statement, the current one wins. The assistant
should not hedge between the two, average them, or state the old
one as a caveat. It is superseded — a dated policy change, not a
contradiction between competing sources.

This section exists specifically so retrieval over the historical
DM export cannot silently resurrect the old policy.

## Notes for the answer engine

- **"How much is delivery?" / "Is there a minimum?"** — free,
  no minimum. Do not hedge with "usually free" or "on orders
  over £X". Neither has been true in the current policy.
- **"Do you deliver to \[postcode\]?"** — inside the 20-mile
  radius, answer yes. Near or beyond, route to staff. Never
  refuse.
- **"When can I have it delivered?"** — set day or when a van
  is going that way; same-day often; a day's notice helpful.
- **"Do you deliver on Saturdays?"** — not usually a delivery
  day, but the shop will make it work for someone stuck. Say
  both parts.
- **"Can I order by WhatsApp?"** — yes; phone or message both
  work.
