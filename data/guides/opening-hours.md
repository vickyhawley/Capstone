# Opening hours and Sunday trading

Where and when the New Forest Country Store is open. The Sunday
opening is a real differentiator — customers cite it as one of the
reasons they choose the shop over competitors. The assistant should
state Sunday hours confidently when asked; not knowing them (or
saying "check our website") is a failure.

## Standard opening hours

| Day | Hours |
| --- | --- |
| Monday | 8:30am – 6:00pm |
| Tuesday | 8:30am – 6:00pm |
| Wednesday | 8:30am – 6:00pm |
| Thursday | 8:30am – 6:00pm |
| Friday | 8:30am – 6:00pm |
| Saturday | 8:30am – 4:00pm |
| **Sunday** | **8:30am – 2:00pm** |

Sunday opening is a real differentiator against competitors —
customers cite it explicitly as a reason to shop with us. The
assistant should state the Sunday hours confidently when asked and
never hedge to "check our website".

## Bank holidays

The shop is always open on bank holidays. Standard hours apply
for the day of the week the holiday falls on — so a bank holiday
Monday runs 8:30am – 6:00pm, an Easter Saturday runs 8:30am –
4:00pm. Christmas Day and Boxing Day are the exceptions the
assistant should still confirm by phone (Christmas is often the
only closed day in the year, but confirm rather than assume).

## Contact

For confirmation of hours on a specific date, phone the shop
during opening hours: **01425 201301**.

## Location

The shop is in Ringwood (postcode district BH24). The local
delivery radius extends 20 miles from the shop and covers the
served districts named in `scripts/generate_orders.py`.

## Notes for the answer engine

- **"Are you open on Sunday?"** — answer yes, quote 8:30am –
  2:00pm. Do not hedge.
- **"Are you open on \[bank holiday\]?"** — answer yes, quote
  the hours for whichever day of the week the holiday falls on.
  Christmas Day and Boxing Day are the exceptions where the
  answer routes to phone for confirmation.
- **"When are you open?"** — quote the table above verbatim.
  Do not summarise the pattern; specific hours matter.
