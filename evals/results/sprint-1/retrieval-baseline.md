# Sprint 1 retrieval baseline

Run at 2026-09-15T20:03:23.422Z. See 
`docs/adr/0001-hybrid-retrieval.md#addendum` for interpretation.

Four configurations, all with the noop reranker as the control.
Reranker treatment is deferred to Sprint 2 per the "leave it as
the control for now" instruction; addendum applies ADR-0001's
stopping rule accordingly.

## Headline table

| config | recall@5 | recall@10 | relevance | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| dense | 83.3% | 94.4% | 15.0% | 228 | 340 |
| sparse | 5.6% | 5.6% | 5.6% | 57 | 207 |
| hybrid-rrf | 83.3% | 94.4% | 15.0% | 229 | 266 |
| hybrid-weighted | 83.3% | 94.4% | 15.0% | 251 | 290 |

Scored over 18 cases with populated source IDs. The 8 legitimately-empty answer cases (§1) and 14 escalate/abstain cases are excluded from recall — they score elsewhere.

## By provenance

| config | slice | scored | recall@5 | recall@10 | relevance |
| --- | --- | ---: | ---: | ---: | ---: |
| dense | real | 17 | 82.4% | 94.1% | 15.3% |
| dense | boundary | 1 | 100.0% | 100.0% | 10.0% |
| dense | adversarial | 0 | — | — | — |
| sparse | real | 17 | 5.9% | 5.9% | 5.9% |
| sparse | boundary | 1 | 0.0% | 0.0% | 0.0% |
| sparse | adversarial | 0 | — | — | — |
| hybrid-rrf | real | 17 | 82.4% | 94.1% | 15.3% |
| hybrid-rrf | boundary | 1 | 100.0% | 100.0% | 10.0% |
| hybrid-rrf | adversarial | 0 | — | — | — |
| hybrid-weighted | real | 17 | 82.4% | 94.1% | 15.3% |
| hybrid-weighted | boundary | 1 | 100.0% | 100.0% | 10.0% |
| hybrid-weighted | adversarial | 0 | — | — | — |

## By intent

| config | intent | scored | recall@5 | recall@10 | relevance |
| --- | --- | ---: | ---: | ---: | ---: |
| dense | product | 7 | 85.7% | 100.0% | 20.0% |
| dense | fit | 1 | 100.0% | 100.0% | 10.0% |
| dense | logistics | 10 | 80.0% | 90.0% | 12.0% |
| dense | welfare-clinical | 0 | — | — | — |
| dense | out-of-scope | 0 | — | — | — |
| dense | service-referral | 0 | — | — | — |
| sparse | product | 7 | 0.0% | 0.0% | 0.0% |
| sparse | fit | 1 | 0.0% | 0.0% | 0.0% |
| sparse | logistics | 10 | 10.0% | 10.0% | 10.0% |
| sparse | welfare-clinical | 0 | — | — | — |
| sparse | out-of-scope | 0 | — | — | — |
| sparse | service-referral | 0 | — | — | — |
| hybrid-rrf | product | 7 | 85.7% | 100.0% | 20.0% |
| hybrid-rrf | fit | 1 | 100.0% | 100.0% | 10.0% |
| hybrid-rrf | logistics | 10 | 80.0% | 90.0% | 12.0% |
| hybrid-rrf | welfare-clinical | 0 | — | — | — |
| hybrid-rrf | out-of-scope | 0 | — | — | — |
| hybrid-rrf | service-referral | 0 | — | — | — |
| hybrid-weighted | product | 7 | 85.7% | 100.0% | 20.0% |
| hybrid-weighted | fit | 1 | 100.0% | 100.0% | 10.0% |
| hybrid-weighted | logistics | 10 | 80.0% | 90.0% | 12.0% |
| hybrid-weighted | welfare-clinical | 0 | — | — | — |
| hybrid-weighted | out-of-scope | 0 | — | — | — |
| hybrid-weighted | service-referral | 0 | — | — | — |

## Flagged cases (per session brief)

These are named in the Job-3 brief as cases whose retrieval outcome is evidence for downstream ADR follow-ups. Report the outcome, do not adjust:

- **Fit gap** (cases 026, 027, 030) — no saddle or girth fit-rule chunks exist. Expected to miss; the miss is the ADR-0003 sprint-2 guide-gap evidence.
- **Trade synonym** (case 007) — "purple horsehage" ↔ HorseHage Timothy. Nothing in the Timothy listing says "purple"; a miss is ADR-0009 synonym-dictionary follow-up evidence.

| config | case | required | top-5 hit? | top-10 hit? |
| --- | --- | --- | :---: | :---: |
| dense | fit-026-cob-wide-back-saddle | (none in corpus) | n/a | n/a |
| dense | fit-027-dressage-girth-line | (none in corpus) | n/a | n/a |
| dense | fit-030-saddle-prompt-injection | (none in corpus) | n/a | n/a |
| dense | product-007-purple-horsehage-price | 1acc7b64… | ✗ | ✓ |
| sparse | fit-026-cob-wide-back-saddle | (none in corpus) | n/a | n/a |
| sparse | fit-027-dressage-girth-line | (none in corpus) | n/a | n/a |
| sparse | fit-030-saddle-prompt-injection | (none in corpus) | n/a | n/a |
| sparse | product-007-purple-horsehage-price | 1acc7b64… | ✗ | ✗ |
| hybrid-rrf | fit-026-cob-wide-back-saddle | (none in corpus) | n/a | n/a |
| hybrid-rrf | fit-027-dressage-girth-line | (none in corpus) | n/a | n/a |
| hybrid-rrf | fit-030-saddle-prompt-injection | (none in corpus) | n/a | n/a |
| hybrid-rrf | product-007-purple-horsehage-price | 1acc7b64… | ✗ | ✓ |
| hybrid-weighted | fit-026-cob-wide-back-saddle | (none in corpus) | n/a | n/a |
| hybrid-weighted | fit-027-dressage-girth-line | (none in corpus) | n/a | n/a |
| hybrid-weighted | fit-030-saddle-prompt-injection | (none in corpus) | n/a | n/a |
| hybrid-weighted | product-007-purple-horsehage-price | 1acc7b64… | ✗ | ✓ |
