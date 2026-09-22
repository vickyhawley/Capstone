# Groundwork project board

The capstone rubric requires an accessible board showing all user
stories delivered. This document is that board. It is versioned
alongside the code, so the state at any commit is reproducible
and the story-by-story evolution is auditable via `git log`.

Status legend:

- **Done** — story is closed in the sprint-log with evidence
  (eval numbers, smoke test result, or shipped commit).
- **In progress** — story is under active work in the current
  sprint.
- **Roadmap** — story is recognised work, scoped and named,
  sequenced for after the capstone. Deferred by a decision that
  is recorded in the sprint-log rather than dropped.

Every row links to the primary evidence in `docs/sprint-log.md`
or `docs/adr/`. The sprint-log is the authoritative narrative;
this document is a cross-cut view of it, organised by story.

Scope was frozen at 36 stories at Sprint 0 start. GW-37 (rate
limiting) was added mid-Sprint-1-prep as a Sprint-0 defect
correction — the addition is recorded in the sprint-log with
its rationale. Effective board size: **37 stories**.

---

## Sprint 0 — Scaffold (2026-09-06 → 2026-09-13)

**Goal.** Deployable skeleton: web shell + API health + SSE
stream verified end to end, CI green, port interfaces defined,
ADR-0001 opened.

| Story | Title | Status | Evidence |
|---|---|---|---|
| GW-00 | Repo, workspace and CI baseline | Done | sprint-log §Sprint 0 "Shipped" |
| GW-00a | Port interfaces defined (retriever, synthesizer, router, safety gate, tool registry, trace sink) | Done | `packages/core/src/ports/` |
| GW-00b | Adapter stubs for every port | Done | `packages/adapters/src/*/stub-*.ts` |
| GW-00c | Migration 001 baseline schema | Done | `supabase/migrations/001_*.sql` |
| GW-00d | ADR-0001 opened (retrieval strategy) | Done | `docs/adr/0001-hybrid-retrieval.md` |
| GW-00e | README, deploy path documented | Done | `README.md` |

Sprint-0 stories were bundled behind a single scaffold epic in
the original board; expanded here for auditability. Everything
in this table is present in the repo at Sprint-0 close.

---

## Sprint 1 prep + Sprint 1 — Retrieval foundation (2026-09-13 → 2026-09-15)

**Goal.** Wire real retrieval end to end, ship the first eval
baseline, put the app on a public URL.

| Story | Title | Status | Evidence |
|---|---|---|---|
| GW-37 | Rate limiting middleware (Upstash Redis), fail-closed in prod | Done | sprint-log §"Sprint 1 prep — Shipped" |
| GW-09 | Both origins deployed; same-origin rewrite verified end-to-end | Done | Live at `capstone-web-ten.vercel.app` |
| GW-01 | Corpus ingestion (product records + prose guides) | Done | `packages/ingestion/`, ADR-0003, ADR-0004 |
| GW-02 | Hybrid retrieval + Sprint 1 baseline (dense + sparse + RRF) | Done | sprint-log §"Sprint 1 close-out"; ADR-0001 |
| GW-03 | Sprint 1 baseline table published | Done | sprint-log §"The Sprint 1 baseline table" |
| GW-04 | Eval harness skeleton (`evals/`) with golden dataset shape | Done | `evals/README.md` |

**Recorded during-sprint scope changes:** GW-37 added mid-Sprint-1-prep
as a Sprint-0 defect correction; GW-01 amended for attribute
extraction (2026-09-15) after ADR-0004 landed.

---

## Sprint 2 — Safety, routing and compliance (2026-09-15 → 2026-09-16)

**Goal.** Build the walls that define what the system will and
will not say. Intent routing, safety gate, escalation content,
false-refusal measurement, red-team surface, Article 50
disclosure.

| Story | Title | Status | Evidence |
|---|---|---|---|
| GW-10 | Intent router — 6-class descriptive classifier, rules-first + LLM fallback | Done — 38/40 = 95% | sprint-log §"GW-10 close-out"; ADR-0010 |
| GW-11 | Safety gate — deterministic, three tag families (clinical, welfare-emergency, out-of-scope) | Done | sprint-log §"GW-11 close-out"; ADR-0011 |
| GW-12 | Escalation content — welfare copy, vet-referral copy, staff-referral copy | Done | sprint-log §"GW-12 close-out" |
| GW-13 | False-refusal measurement — paired metric with correct-abstention | Done | sprint-log §"GW-13 close-out" |
| GW-14 | Red-team tier-3 wiring — eight adversarial scenarios | Done | sprint-log §"GW-14 close-out" |
| GW-15 | Article 50 disclosure surface + capability profile | Done | sprint-log §"GW-15 close-out"; ADR-0012; `/api/about` |
| GW-17 | Tag audit + shape-tag retrofit on early cases | Done — partial | sprint-log §"GW-17 close-out — partial" |
| GW-16 | Conversation memory (multi-turn) | Done — partial | sprint-log §"GW-16 conversation memory"; ADR-0017. Memory infra + context rewrite shipped Sprint 4; multi-turn golden dataset still deferred (post-capstone) |

**Also landed in Sprint 2 (out of the numbered stories):** sparse
retrieval fix + hybrid rematch (documented as "Sparse fix + hybrid
rematch close-out"); preflight for stale source IDs. Both were
defect-shaped fixes, not scoped stories, so they don't consume a
board slot.

---

## Sprint 3 — Tool layer (2026-09-16 → 2026-09-18)

**Goal.** The system stops being a retrieval pipeline and starts
being an assistant that *does things* — checks stock, offers
substitutes, verifies delivery zones, fails sanely on upstream
degradation, records every tool call.

| Story | Title | Status | Evidence |
|---|---|---|---|
| Story 1 | Deterministic chunk IDs (Sprint 2 → 3 promotion) | Done | sprint-log §"Story 1 close-out"; ADR-0013 |
| GW-18 | Tool port + function-calling loop (bounded iterations, structured errors, trace hooks) | Done | ADR-0014; `packages/core/src/tool-loop.ts` |
| GW-25 | Trace logging — persist every tool invocation | Done | sprint-log §"Story 3 close-out — GW-25"; ADR-0015 |
| GW-20 | Stock lookup tool — three-state semantics (available/unavailable/pending), later four-state after SME correction | Done | sprint-log §"Story 4 formally closed"; ADR-0016 |
| GW-19 | Substitute ranking — offers equivalent NFCS holds when GW-20 returns unavailable/orderable | Done — 2/2 smoke pass | sprint-log §"GW-19 shipped"; ADR-0005 |
| GW-21 | Delivery-zone check tool — postcode → in / edge / out per delivery guide | Done — 2/2 smoke pass | sprint-log §"GW-21 shipped" |
| GW-23 | Per-dependency circuit breaker with graceful degradation | Done — 1/1 forced-failure test pass | sprint-log §"GW-23 shipped"; `packages/core/src/circuit-breaker.ts` |
| GW-24 | Model tiering with runtime cost capture | Roadmap | Skipped at Sprint 3 close-out; router already on `gpt-4o-mini`, synthesizer downstream. See sprint-log §"Sprint 3 closes — GW-24 skipped" |
| GW-22 | Tool-use disclosure in UI (per-answer "checked stock / delivery zone" surface) | Roadmap | Article 50 disclosure lives in `/api/about` (GW-15); per-answer UX is enhancement, not compliance |
| GW-26 | Staff console — write path for staff to correct answers | Roadmap | Prerequisites for supervised deploy, not needed for graded demo |

**Story-numbering note.** Sprint 3's planning table uses ordinal
"Story 1..14" alongside the GW-XX identifiers. Story 1 was
deterministic chunk IDs (a Sprint-2 promotion with no GW number
originally); Stories 2–10 map to GW-18/25/20/19/22/21/24/23/26 in
priority order. The sprint-log records the exact mapping and the
reconciliation.

---

## Sprint 4 — Assistant surface (2026-09-18 → ongoing)

**Goal.** Turn the working pipeline into an assistant a customer
would actually use: synthesizer, chat UI, tool-driven answer
copy, streaming, shop-facing surfaces.

| Story | Title | Status | Evidence |
|---|---|---|---|
| S4-01 | Tier-1 route-based dispatch — planner + tool-output plumbing | Done | sprint-log §"Tier-1 route-based dispatch" (2026-09-18) |
| S4-02 | Synthesis MVP — answer copy from tool findings (gpt-4o) | Done | sprint-log §"Synthesis MVP" (2026-09-18) |
| S4-03 | Chat UI shell — `apps/web` replaces scaffold | Done | sprint-log §"Chat UI shell" (2026-09-21) |
| S4-04 | Shop-info tool — contact, hours, address, ordering, subscription delivery | Done | sprint-log §"Shop-info tool" (2026-09-21) |
| S4-05 | Product deep-links — chat closes the loop to purchase | Done | sprint-log §"Product deep-links" (2026-09-21) |
| S4-06 | Subscription delivery flag — surface recurring option for feed/bedding/haylage | Done | sprint-log §"Subscription delivery" (2026-09-21) |
| S4-07 | SSE streaming — answer forms token-by-token | Done | commit `4010d97` |
| S4-08 | Progressive tool disclosure — visible pipeline during pending phase | Done | commit `6ffedee` |
| S4-09 | Product cards — title + price + View CTA | Done | commit `5f66e28` |
| S4-10 | NFCS brand pass — palette, logo, editorial serif | Done | sprint-log; recent commits `14c3b62`, `5f66e28`, `a425064` |
| S4-11 | Design-and-testing document consolidation | Done | commit `ca41add`; `docs/design-and-testing.md` |
| S4-12 | Project board consolidation (this document) | In progress | This commit |
| S4-13 | Cost model spreadsheet | Roadmap — capstone-shaped | Uses estimated figures in design doc §4.3 per GW-24 skip note |
| S4-14 | Two sprint-demo recordings (retrospective) | Todo — capstone-shaped | Rubric-required |
| S4-15 | Final 15–20 min submission recording | Todo — capstone-shaped | Rubric-required; screen share + ID visible |
| S4-16 | Repo shared with `quantic-grader` | Todo — capstone-shaped | GitHub Settings → Collaborators |

The "capstone-shaped" tag distinguishes rubric deliverables
(recordings, board share, submission packaging) from product
work. They sit on the board because the rubric assesses them,
not because they change what the system does.

---

## Post-capstone roadmap

Recognised work, scoped and named, sequenced for after
submission. Recording here so the capstone reads as "scope was
chosen" rather than "scope was reached". The sprint-log entry
titled "Post-capstone roadmap — moved, not cut (2026-09-18)"
carries the full rationale for each item; summaries below.

### Sprint-4-shaped features (product work)

| Item | One-line reason for deferral |
|---|---|
| GW-26 staff console | Supervised-deploy prerequisite; demo runs on curated golden set |
| GW-22 per-answer tool-use disclosure | UX enhancement; Article 50 compliance already met by `/api/about` |
| Complement graph (~50 pairs) | Hand-authored, ADR-0005 Sprint-4 sub-story; first-pass returns `unrelated` |
| Learned substitute/complement (co-view/co-purchase) | Needs real traffic at scale |
| Price-tier ranking axis | Special-case rule for materially different price bands; first-pass surfaces prices but doesn't sort by tier gap |
| Path A query-side attribute extraction | Only justified if Path B "no anchor" fall-through rate becomes meaningful |
| GW-24 model tiering with runtime cost capture | Router already on `gpt-4o-mini`; synthesis-tier fallback needs GW-23 request-boundary integration |

### Retrieval-quality follow-ons

| Item | One-line reason for deferral |
|---|---|
| Reranker spike (learned) | Sprint-4 candidate per ADR-0005 and RRF-scale finding in ADR-0016 §3 |
| ADR-0009 synonym dictionary (colour codes, trade nicknames) | Case 007 (`purple horsehage`) is live motivating case; regressed under GW-20 handle-match to safe direction (`orderable`) |
| Saddle-fit and girth-fit guides | Content authoring; closes ADR-0003 fit gap and moves three fit cases off `[]` |
| "What we don't stock" guide | Canonical negative-claim content per Batch-3 Sprint-1 finding |

### Multi-turn / conversational features

| Item | One-line reason for deferral |
|---|---|
| Multi-turn eval dataset | GW-16 infra shipped Sprint 4 (ADR-0017); golden dataset still needed to measure the rewrite path — different case-file shape (conversation state, follow-up handling) than the existing single-turn set |

### Ingestion and operations

| Item | One-line reason for deferral |
|---|---|
| `products` table cleanup | Migration 001's empty `products` table has no writer; ADR-0016 §1 committed to chunks-as-catalogue. Cheap, not demo-critical |
| Lead-time capture for `orderable` state | Currently opaque to the customer answer; Sprint-4 candidate in ADR-0016 |
| `price_lookup` tool | Only if synthesis discipline for chunk prices proves loose; no evidence today |
| Trace retention rotation | `traces` table has no cleanup policy; real operational concern post-launch |
| Python harness preflight | Nice-to-have; harness surfaces missing env clearly today |

---

## Board arithmetic

**Original scope:** 36 stories at Sprint 0 freeze.
**Mid-sprint addition:** +1 (GW-37 rate limiting; Sprint-0
defect correction, recorded in sprint-log).
**Effective board:** 37 stories.

**Done at time of writing:** 26 product stories across Sprints 0–3,
plus 11 assistant-surface stories in Sprint 4. Every story either
carries a "Done" evidence pointer above or a documented deferral
to the roadmap.

**Roadmap:** 15+ items, each named with a one-line reason for
deferral and a link to the deciding sprint-log entry.

Rubric-shaped items (recordings, share-with-grader) are tracked
in Sprint 4 alongside product work so nothing rubric-assessed
falls off the board.

---

## Notes on board format

**Why a markdown document rather than a Trello or GitHub Projects
board.** A live board's state at any historical commit cannot be
reproduced. This document is versioned with the code, so a grader
looking at the submission commit sees exactly the board state the
submission claims. It is also readable inline in a GitHub URL
without a login, which no live board is.

A live GitHub Project (or Trello) can be added on top of this
without competing with it — that board would be the working
surface; this document is the assessment artifact. If added,
its link belongs at the top of this file.
