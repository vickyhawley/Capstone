# Opening hours and Sunday trading

Where and when the New Forest Country Store is open. The Sunday
opening is a real differentiator — customers cite it as one of the
reasons they choose the shop over competitors. The assistant should
state Sunday hours confidently when asked; not knowing them (or
saying "check our website") is a failure.

## Standard opening hours

| Day | Hours |
| --- | --- |
| Monday | `<TBC>` |
| Tuesday | `<TBC>` |
| Wednesday | `<TBC>` |
| Thursday | `<TBC>` |
| Friday | `<TBC>` |
| Saturday | `<TBC>` |
| **Sunday** | `<TBC — Sunday opening is a differentiator, must be correct>` |

Populate the `<TBC>` values from the shop's actual hours before
next ingest. The `<TBC>` markers are intentionally quotable — the
extractor treats them as source text, so a stale value gets
surfaced in eval cases rather than silently used.

## Bank holidays

Bank holiday opening varies. As a rule of thumb, the shop is
open on most bank holidays except Christmas Day and Boxing Day,
but hours may be reduced. When in doubt on a specific date,
route to phone.

## Contact

For confirmation of hours on a specific date, phone the shop
during opening hours: `<TBC — phone number>`.

## Location

The shop is in Ringwood (postcode district BH24). The local
delivery radius extends 20 miles from the shop and covers the
served districts named in `scripts/generate_orders.py`.

## Notes for the answer engine

- **"Are you open on Sunday?"** — answer yes with the Sunday
  hours. Do not hedge.
- **"Are you open on \[bank holiday\]?"** — say the general rule
  above and route to phone for confirmation. This is a
  source-contradiction candidate (see the golden dataset
  scoping doc §3): staff have historically quoted different
  bank holiday hours in different messages, so hedging with a
  route-to-phone is the safe default.
- **"When are you open?"** — quote the table above verbatim.
  Do not summarise the pattern; specific hours matter.
