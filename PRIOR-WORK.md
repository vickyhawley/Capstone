# Prior work

An honest inventory of what already exists in this space, and what
Groundwork does differently. Populated during literature review and
competitive scan.

## Format

For each entry:

```
### <name>
- Link: <url or citation>
- What it does:
- Where it overlaps with Groundwork:
- Where it diverges:
- What we can learn from it:
```

## Entries

### NFCS production hub (client-record system)
- Link: internal — the shop's existing order-management and CRM
  system, in use at New Forest Country Store.
- What it does: unifies online and phone orders, buckets customers
  by a normalised phone-first `clientKey`, segments the client base
  into regular / occasional / at-risk / one-off, and tags products
  with delivery constraints (notably `local-delivery-only` for
  bulky feed and bedding).
- Where it overlaps with Groundwork: the shape of the data
  (clientKey bucketing, three-state stock, local-delivery rule,
  archetype segmentation) is the exact shape a grounded answer
  engine needs to reason correctly about a returning customer.
- Where it diverges: the hub carries phone numbers, horse names,
  birthdays, staff notes and delivery photographs. Groundwork does
  *not* consume any of this — see
  `docs/design-and-testing.md#synthetic-order-data-not-real-nfcs-records`
  for the reasoning. Order fixtures under `data/synthetic/` are
  generated over the real catalogue with fabricated customers.
- What we can learn from it: the archetype segmentation and the
  business rules encoded in tags (three-state stock, local-only
  delivery) are load-bearing signals worth reproducing in the
  synthetic set, not incidental colour.
