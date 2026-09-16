# Sprint 1 retrieval baseline

Run at 2026-09-16T12:15:30.001Z. See 
`docs/adr/0001-hybrid-retrieval.md#addendum` for interpretation.

Four configurations, all with the noop reranker as the control.
Reranker treatment is deferred to Sprint 2 per the "leave it as
the control for now" instruction; addendum applies ADR-0001's
stopping rule accordingly.

## Headline table

| config | recall@5 | recall@10 | nDCG@10 | p50 ms | p95 ms |
<!-- nDCG@10 matches evals/groundwork_evals/metrics.py `retrieval_relevance` — binary relevance, log-position discount. An earlier version of this report labelled precision@10 as "relevance"; that mismatched the harness. Fixed. -->
| --- | ---: | ---: | ---: | ---: | ---: |
| dense | 88.9% | 100.0% | 65.1% | 235 | 459 |
| sparse | 83.3% | 88.9% | 54.1% | 56 | 72 |
| hybrid-rrf | 100.0% | 100.0% | 65.6% | 244 | 300 |
| hybrid-weighted | 94.4% | 100.0% | 65.6% | 244 | 310 |

Scored over 18 cases with populated source IDs. The 8 legitimately-empty answer cases (§1) and 14 escalate/abstain cases are excluded from recall — they score elsewhere.

### Hybrid vs dense — the comparison did not happen this sprint

The rows above show hybrid-rrf and hybrid-weighted matching dense-only exactly. That is *not* evidence that fusion adds no value. It is evidence that the sparse component was returning empty on almost every query (see the ts_query AND-semantics finding in ADR-0001's addendum) — 5.6% recall@10 means 1 case in 18 got any sparse hit at all. Hybrid was compared against dense-plus-nothing, not against dense-plus-a-working-sparse-retriever. The Sprint 1 recommendation ships dense-only; the hybrid comparison is deferred to Sprint 2 after `plainto_tsquery` is replaced with `websearch_to_tsquery` or an OR-fallback.

## By provenance

| config | slice | scored | recall@5 | recall@10 | nDCG@10 |
| --- | --- | ---: | ---: | ---: | ---: |
| dense | real | 17 | 88.2% | 100.0% | 65.1% |
| dense | boundary | 1 | 100.0% | 100.0% | 65.1% |
| dense | adversarial | 0 | — | — | — |
| sparse | real | 17 | 88.2% | 94.1% | 57.2% |
| sparse | boundary | 1 | 0.0% | 0.0% | 0.0% |
| sparse | adversarial | 0 | — | — | — |
| hybrid-rrf | real | 17 | 100.0% | 100.0% | 66.7% |
| hybrid-rrf | boundary | 1 | 100.0% | 100.0% | 45.6% |
| hybrid-rrf | adversarial | 0 | — | — | — |
| hybrid-weighted | real | 17 | 94.1% | 100.0% | 66.0% |
| hybrid-weighted | boundary | 1 | 100.0% | 100.0% | 59.1% |
| hybrid-weighted | adversarial | 0 | — | — | — |

## By intent

| config | intent | scored | recall@5 | recall@10 | nDCG@10 |
| --- | --- | ---: | ---: | ---: | ---: |
| dense | product | 7 | 85.7% | 100.0% | 84.6% |
| dense | fit | 1 | 100.0% | 100.0% | 65.1% |
| dense | logistics | 10 | 90.0% | 100.0% | 51.4% |
| dense | welfare-clinical | 0 | — | — | — |
| dense | out-of-scope | 0 | — | — | — |
| dense | service-referral | 0 | — | — | — |
| sparse | product | 7 | 85.7% | 100.0% | 73.3% |
| sparse | fit | 1 | 0.0% | 0.0% | 0.0% |
| sparse | logistics | 10 | 90.0% | 90.0% | 46.0% |
| sparse | welfare-clinical | 0 | — | — | — |
| sparse | out-of-scope | 0 | — | — | — |
| sparse | service-referral | 0 | — | — | — |
| hybrid-rrf | product | 7 | 100.0% | 100.0% | 85.0% |
| hybrid-rrf | fit | 1 | 100.0% | 100.0% | 45.6% |
| hybrid-rrf | logistics | 10 | 100.0% | 100.0% | 54.0% |
| hybrid-rrf | welfare-clinical | 0 | — | — | — |
| hybrid-rrf | out-of-scope | 0 | — | — | — |
| hybrid-rrf | service-referral | 0 | — | — | — |
| hybrid-weighted | product | 7 | 85.7% | 100.0% | 84.8% |
| hybrid-weighted | fit | 1 | 100.0% | 100.0% | 59.1% |
| hybrid-weighted | logistics | 10 | 100.0% | 100.0% | 52.8% |
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
| dense | product-007-purple-horsehage-price | ec43a939… | ✗ | ✓ |
| sparse | fit-026-cob-wide-back-saddle | (none in corpus) | n/a | n/a |
| sparse | fit-027-dressage-girth-line | (none in corpus) | n/a | n/a |
| sparse | fit-030-saddle-prompt-injection | (none in corpus) | n/a | n/a |
| sparse | product-007-purple-horsehage-price | ec43a939… | ✓ | ✓ |
| hybrid-rrf | fit-026-cob-wide-back-saddle | (none in corpus) | n/a | n/a |
| hybrid-rrf | fit-027-dressage-girth-line | (none in corpus) | n/a | n/a |
| hybrid-rrf | fit-030-saddle-prompt-injection | (none in corpus) | n/a | n/a |
| hybrid-rrf | product-007-purple-horsehage-price | ec43a939… | ✓ | ✓ |
| hybrid-weighted | fit-026-cob-wide-back-saddle | (none in corpus) | n/a | n/a |
| hybrid-weighted | fit-027-dressage-girth-line | (none in corpus) | n/a | n/a |
| hybrid-weighted | fit-030-saddle-prompt-injection | (none in corpus) | n/a | n/a |
| hybrid-weighted | product-007-purple-horsehage-price | ec43a939… | ✗ | ✓ |
