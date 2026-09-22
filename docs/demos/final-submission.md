# Demo script — Groundwork capstone (15 min, solo)

Target length: **15 minutes** (MSSE Capstone Handbook 15–20 min).
Presenter: **solo** (all beats voiced by one person). ID on camera at
the start per Handbook requirement.

The script is written as **Screen** (what to have visible) + **Voice**
(what to say). Timing is a guide, not a metronome — the streaming
answers will vary a bit run to run.

---

## Prep checklist (do this before hitting record)

- [ ] Government ID within reach + camera set up for the intro.
- [ ] Chrome / Firefox with these tabs open in order:
  1. <https://capstone-web-ten.vercel.app> — the deployed chat, empty state.
  2. Same URL in a second tab (backup for the multi-turn beat).
  3. GitHub repo <https://github.com/vickyhawley/Capstone> — README visible.
  4. `docs/adr/0016-stock-lookup-three-state.md` open on GitHub.
  5. `docs/sprint-log.md` open on GitHub, scrolled to the "GW-16 conversation memory" entry.
  6. GitHub Actions tab of the repo, a recent successful CI run open.
  7. Local terminal, `cd evals`, venv activated, ready to type the eval command.
- [ ] Vercel deploy is **green** for both `groundwork-web` and `groundwork-api` (check <https://vercel.com/dashboard>). Curl `/api/health` once to warm the function.
- [ ] Suppress notifications (Do Not Disturb), close Slack/email.
- [ ] Zoom in the browser to ~125% so the chat is readable in the recording.
- [ ] Font size in terminal ≥ 16pt.

---

## 0:00–0:45 — Intro

**Screen:** camera view, ID visible for 3 seconds, then browser at the deployed URL.

**Voice:**
> "I'm Vix Hawley, and this is my MSSE capstone: **Groundwork** — a
> grounded answer engine for a real specialist equine retailer, New
> Forest Country Store. The brief was to build a RAG-based
> LLM application answering questions over a corpus of company
> policies and procedures. I built a customer-facing policy corpus —
> delivery zones, stock policies, opening hours, and what the shop
> will and won't sell — rather than the usual employee-HR set.
> Deployed live at capstone-web-ten.vercel.app, TypeScript monorepo,
> Hono API on Vercel, Supabase for retrieval and traces, OpenAI for
> classification and synthesis. Fifteen minutes: I'll show the chat,
> the architecture, the evaluation harness, CI/CD, and the honest
> gaps."

---

## 0:45–4:30 — Live demo (4 queries)

**Screen:** the deployed chat, empty state.

### Query 1: product, orderable + subscription-eligible (0:45–1:30)

**Type:** `do you sell hemp bedding`

**Voice while it streams:**
> "First query. Notice three things as this streams. One — the
> 'tool-start' event: the router classified this as product intent
> and dispatched the stock-lookup tool, which does a hybrid
> retrieval — dense pgvector plus sparse ts_rank — over the product
> catalogue. Two — the answer streams token by token because
> synthesis is a real streaming LLM call, not a fake progress bar.
> Three — the product link and price appear because the tool
> returned a matched product with metadata. Hemp bedding is
> subscription-eligible, so the answer offers a recurring
> delivery — that's policy from the shop-info YAML, not
> hallucination."

### Query 2: multi-turn context resolution (1:30–2:30)

**Screen:** same chat, don't hit "New conversation."

**Type:** `do you have anything else similar`

**Voice while it streams:**
> "This is the multi-turn beat. The query on its own is completely
> ambiguous — 'similar' to what? The router would classify this as
> out-of-scope. But before the router sees it, a context-rewriter
> step runs against the last two turns of history stored server-side,
> and rewrites the query to something self-contained like 'do you
> sell anything similar to hemp bedding.' That rewritten query is
> what the router sees. Conversation memory is stored in Supabase
> keyed by a server-issued UUID — the client never mints its own.
> This is ADR-0017."

### Query 3: welfare/clinical refusal (2:30–3:30)

**Screen:** click **New conversation** to reset. Then type.

**Type:** `my horse has colic what should i give her`

**Voice while it streams:**
> "This is what the safety gate is for. A customer asks a clinical
> question. The router classifies it as welfare-clinical, and the
> safety gate short-circuits the whole pipeline — no retrieval, no
> synthesis, no LLM anywhere near the answer. The response is
> deterministic escalation copy pointing them to a vet. This is
> non-negotiable for a real retail deployment: an equine retailer
> is not qualified to give clinical advice, and neither is a
> language model. ADR-0011 covers the rule set."

### Query 4: logistics with postcode (3:30–4:30)

**Screen:** click **New conversation**. Then type.

**Type:** `do you deliver to SO41`

**Voice while it streams:**
> "Fourth query. Different tool this time — the delivery-zone tool,
> backed by a YAML mapping of postcode districts to delivery zones.
> Deterministic lookup, not an LLM call — because the model has no
> business making shipping-cost claims. Notice the answer never
> refuses even when the postcode is out-of-radius; it defers to
> staff. 'Never refuse a customer' was a rule I got from the shop
> owner in the discovery interviews."

---

## 4:30–5:30 — Evidence panel walk-through

**Screen:** the last answered turn. Open the evidence panel if it isn't already.

**Voice:**
> "The evidence panel isn't decoration — it's the honest surface
> for how the answer was built. Every answer has:
> **citations** (which chunks the response is grounded on),
> **retrieved_chunk_ids** (what the tools pulled back, broader than
> what was cited), and **rewritten_query** (populated on turn 2+
> when the rewriter changed the text). The Python eval harness
> reads exactly these fields — the same signals graders check are
> the same signals my automated tests check. If citations were
> empty, my own groundedness metric would score me at zero. That
> forcing function drove the design."

---

## 5:30–8:00 — Architecture tour

**Screen:** switch to GitHub, `packages/core/src/ports/` directory listing.

**Voice:**
> "Architecture is hexagonal — ports and adapters. `packages/core`
> is pure domain logic — no framework, no HTTP client, no SDK
> imports. CI enforces that with a `check:core-purity` script that
> fails a PR if anyone imports Hono or OpenAI into core. There are
> eleven ports here: retriever, router, safety-gate, planner,
> tool-registry, synthesizer, trace-sink, conversation-store,
> and a few others."

**Screen:** click into `packages/core/src/ports/synthesizer.ts`, then
`packages/adapters/src/synthesis/openai-synthesizer.ts`.

**Voice:**
> "The synthesizer is a good example. The port defines a
> single-method interface: given a query, router decision, and tool
> results, produce an answer. The adapter is the OpenAI
> implementation — 300 lines, wraps the API call in a circuit
> breaker, has an explicit fallback for empty content and malformed
> responses. The test file next to it uses a stub OpenAI client so
> it runs in milliseconds. This pattern repeats for every port. The
> synthesizer prompt itself never interpolates user input into the
> system role — that's a hard-learned rule about prompt injection
> hygiene."

**Screen:** switch to `packages/core/src/safety/rules-gate.ts` (or wherever the gate is).

**Voice:**
> "The safety gate is deterministic — rules, not another model.
> Intent maps to behaviour by table lookup. That's what makes the
> welfare-refusal from the demo above cheap, predictable, and
> reviewable by a non-engineer. ADR-0011 argued for this and I've
> not regretted it."

---

## 8:00–10:00 — ADR walkthrough (ADR-0016, three-state stock lookup)

**Screen:** GitHub, `docs/adr/0016-stock-lookup-three-state.md`.

**Voice:**
> "One ADR to walk through, out of seventeen. Three-state stock
> lookup. When a customer asks 'do you sell X,' most systems would
> return yes-or-no. But retail has a third state — 'we don't stock
> that brand for a specific reason, but here's what we do stock
> instead.' Naming the third state as 'orderable-with-substitute'
> lets the tool return structured intent to the synthesizer, which
> writes better copy than a binary would. The ADR names the
> rejected alternatives — two states, four states, a probability
> score — and why they're worse for the specific domain."

**Voice (scroll to alternatives section):**
> "This is what an ADR is for. Not to justify the decision, but to
> preserve the rejected options so future me — or a code reviewer
> six months from now — can see the trade space that was
> considered. Seventeen of these, one per load-bearing choice."

---

## 10:00–12:00 — Evaluation harness live

**Screen:** terminal, `cd evals`, venv activated.

**Type:**
```bash
groundwork-evals \
  --dataset datasets/sprint-1/cases.jsonl \
  --thresholds thresholds/sprint-2.json \
  --sprint capstone-demo \
  --api-url https://groundwork-api.vercel.app
```

**Voice while it runs (~45 seconds):**
> "The eval harness is a separate Python package that talks to the
> deployed API over HTTP — same interface as any customer. It runs
> sixty-five real customer questions from the shop's social-DM
> export, PII-stripped, typos preserved. Ten different metrics:
> groundedness, retrieval relevance, recall at k, correct
> abstention, false refusal, intent classification accuracy,
> product-query extraction accuracy, delivery-zone correctness,
> no-prohibited-claims, and latency. Threshold gates configured
> per sprint — if any of them break, the harness exits non-zero
> and CI fails."

**Voice as it prints the latency + summary lines:**
> "There's the latency summary — p50 and p95, computed over every
> case including error paths, so the number is what a real user
> would experience. And the groundedness score is only real
> because the API now surfaces citations — which I shipped in the
> same PR as this demo prep, honestly."

---

## 12:00–13:30 — CI/CD

**Screen:** GitHub Actions tab of the repo. Show the four workflows.

**Voice:**
> "Four CI workflows. `ci.yml` runs on every PR — typecheck, lint,
> and the workspace test suite. Four hundred and twenty-two tests
> across five packages, plus a hundred and seventeen Python eval-
> harness tests. It's the merge gate. `evals.yml` runs the harness
> against the staging deploy nightly and on demand — because
> external LLM calls cost money and I don't want to burn budget on
> every PR. `redteam.yml` runs the adversarial subset separately
> with stricter thresholds. `smoke.yml` runs against the deployed
> URL post-deploy so a broken deployment surfaces within seconds."

**Screen:** click into a recent ci.yml run.

**Voice:**
> "The green tick is the merge gate. Nothing lands in main without
> this being green. That includes doc changes — the check-core-
> purity script also runs here."

---

## 13:30–14:30 — Honest gaps

**Screen:** GitHub, `docs/sprint-log.md`, scrolled to "GW-16 conversation memory" close-out entry.

**Voice:**
> "Every sprint-log entry has an 'honest gaps' section. This one
> names three: the multi-turn eval dataset is still deferred
> because writing conversation-shaped cases takes real customer-
> interview time I didn't have; rewriter failures are silent to
> the customer, which is good for uptime but hides regressions;
> and there's a composition-root gap where new deps in
> `defaultAnswerDeps()` don't get automatic wiring in `server.ts`
> — which caught me in production during this exact sprint. Named
> and fixed. Naming the gaps is a discipline: it forces me to
> triage what's a real risk versus what I can defer."

**Screen:** scroll to `docs/project-board.md` briefly.

**Voice:**
> "The project board tracks all thirty-seven stories, done and
> deferred. Roadmap items are named with the reason they didn't
> land, so a future contributor — or a grader — can see the shape
> of what's next."

---

## 14:30–15:00 — Wrap

**Screen:** back to the deployed chat home page.

**Voice:**
> "To summarise: seventeen ADRs, four sprints, sixty-five eval
> cases, ten metrics, four CI workflows, hexagonal architecture
> with eleven ports, deployed live on Vercel with tracing to
> Supabase, and a chat that answers grounded questions with
> citations, refuses what it shouldn't answer, remembers previous
> turns, and defers to staff when it should. Everything's linked
> from the repo README. Thanks for watching."

---

## Cut-down plan (if you overrun)

If the eval run takes longer than 90 seconds or the streaming
demo is slower than expected, cut these in order:

1. **Query 4 (delivery)** — the shop-info tool already got its
   moment via subscription eligibility in Query 1.
2. **ADR walkthrough** — mention "seventeen ADRs, one for every
   load-bearing choice" and skip the deep dive. Saves 90s.
3. **CI/CD screen tour** — just say "four workflows, ci is the
   merge gate, evals runs nightly." Saves 45s.

Do NOT cut: the multi-turn beat (Query 2), the welfare refusal
(Query 3), the evidence-panel walkthrough, or the honest-gaps
section. Those are your differentiators.

---

## What to have on-screen at the end

The deployed URL. Simple. It's the answer to "does it work?"
