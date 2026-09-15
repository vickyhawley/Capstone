# AI-assisted development

The capstone brief asks for an honest account of where AI tooling was used
in the build, what it did, and what was reviewed or rewritten by hand.
This file is the running record.

## Ground rules

- AI-generated code counts as a draft, not the delivered artefact. The
  reviewer is a human (me), and code is read line-by-line before it lands.
- Prompts that produce non-trivial code are worth preserving. Where a
  prompt shaped an architectural choice, link it from the relevant ADR.
- Model output is never trusted for facts — versions, APIs, quotas — those
  are verified against primary docs and pinned in `THIRD-PARTY.md`.
- Refusal, safety and eval behaviour is authored, not generated. AI may
  draft test fixtures but never label them.

## Sessions

### Sprint 0 — scaffold

- Tool: Claude Code (Opus 4.7).
- Scope: repository scaffold, port interfaces, CI shape, ADR-0001 draft.
- Reviewed and edited by hand: yes.
- Notable: the reranker port was added as a no-op after human review of
  the initial plan flagged Cohere Rerank as an unproven assumption.

### Sprint 1 prep — 2026-09-13 — GW-09 deploy

Structured entry: what was asserted, what was true, and how the gap
was found. The framing is not "AI made mistakes." All four defaults
below would have been reasonable initial guesses for a human engineer
with recent Vercel/Hono/Upstash experience — each was drawn from
typical library usage, not from the actual deployment target. The
observation is structural: internal consistency ("all tests pass,
typecheck clean, lint clean") is not the same as external correctness
("works where it must run"). AI is particularly good at producing
internally-consistent code, which makes the gap easy to miss.

**Meta-observation.** Sprint 0's scaffolded API had 18 unit tests, a
clean typecheck, clean lint, and an architectural rule (core purity)
enforced by a custom script — all green locally. The first production
deploy required four separate corrections, each surfaced by a
different Vercel error and each one deploy round-trip apart. None of
the corrections were caught by any local check because they all lived
in the seam between library defaults and Vercel's specific runtime
conventions. Local dev used a Node server (`@hono/node-server` via
`tsx`) and injected env vars in unit tests; production is Vercel's
managed Node Functions with its own handler signature and its own
environment-variable injection convention.

#### Failure 1 — Node version

- **Asserted** — `package.json` `engines`: `>=24.0.0 <25.0.0`;
  `.nvmrc`: `24`. Drawn from "use a recent Node" heuristic without
  checking Vercel's supported runtime list.
- **True** — Vercel Node Functions currently max at 22.x. There is
  no Node 24 option.
- **Found by** — `vercel --prod` returned `Error: Found invalid
  Node.js Version: "24.x". Please set Node.js Version to 22.x`.
- **Locally detectable?** — No. `pnpm install` emitted a soft engine
  warning (local Node happened to be 22.15.0 already), nothing
  failed. The `engines` field is a build-time contract Vercel
  enforces and local tooling ignores.

#### Failure 2 — Runtime pin

- **Asserted** — `apps/api/vercel.json`:
  `"runtime": "@vercel/node@5.0.0"`. Chosen at scaffold time to be
  explicit about the function runtime version.
- **True** — Whatever this string resolved to, it bundled ESM source
  into an output containing CJS `exports` calls. `package.json` has
  `"type": "module"`, so Node refused to load the output.
- **Found by** — Function crashed at load with `ReferenceError:
  exports is not defined in ES module scope`. The error named the
  compiled file and the `package.json` line responsible for the
  refusal.
- **Locally detectable?** — No. Local dev uses `@hono/node-server`
  via `tsx`; `@vercel/node` never runs locally.

#### Failure 3 — Handler signature

- **Asserted** — `apps/api/api/[[...route]].ts`:
  `export default handle(app)` where `handle` is imported from
  `hono/vercel`. This is the pattern in Hono's own Vercel examples.
- **True** — The modern Vercel Node Functions runtime treats default
  exports as `(req, res) => void` (Node-style) and drops any returned
  `Response`. The `hono/vercel` `handle()` helper returns a function
  that produces a `Response`, so framework and runtime talk past each
  other. The function accepts each request but never sends a
  response; Vercel kills it at the 60-second timeout.
- **Found by** — First live request returned `x-vercel-error:
  FUNCTION_INVOCATION_TIMEOUT` after exactly 60 s. The function log
  then surfaced the diagnostic: `default export returned a Response.
  The default-export signature is (req, res) => void — returns are
  ignored. You likely meant the Web fetch-style API.`
- **Locally detectable?** — No, for the same reason as (2). The
  failure mode (60 s hang, no error, no thrown exception) is the
  worst kind for debugging — the function looks alive right up to
  the timeout.

#### Failure 4 — Environment variable names

- **Asserted** — `apps/api/src/rate-limit.ts` read
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Drawn
  from the `@upstash/redis` client documentation, which uses those
  names.
- **True** — Vercel's Upstash Marketplace integration normalises
  storage env vars across providers (Vercel KV, Upstash Redis,
  others) and injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Same
  underlying Upstash Redis instance, different env var names.
- **Found by** — After the integration was added and the function
  redeployed, `assertLimiterOrFail` fired at boot with the message
  "Rate limiter not configured. Set UPSTASH_REDIS_REST_URL and
  UPSTASH_REDIS_REST_TOKEN in production." The message was correct
  about the code's expectations and wrong about what Vercel provides.
- **Locally detectable?** — Not from unit tests, which inject
  synthetic env objects. Could have been detected by reading
  Vercel's Marketplace integration docs (which name the `KV_*`
  prefix) at scaffold time. That reading did not happen.

#### What actually caught each

All four were found the same way: attempt a deploy, read the error.
Zero unit tests, zero typecheck runs, zero lint runs surfaced any of
them. The only local check that would have caught anything is a
smoke test against the live URL — added in the same session as the
fixes and now living at `scripts/smoke.mjs`, running post-deploy in
CI via `.github/workflows/smoke.yml`.

#### Pattern

Two structural consequences worth naming:

1. **Tests are internally consistent with the code they exist to
   verify.** If the code assumes an env var name, the tests inject
   that name, and both are wrong together — no test can flag the
   mismatch because they share the assumption.
2. **The failure mode is batched.** Because the local checks all
   pass, there is no gradient between "commit" and "deploy attempt"
   telling you which of your assumptions might be off. Every deploy
   becomes a big-bang integration test, and Vercel returns errors
   serially — you only see the next failure after fixing the current
   one.

#### Counter-moves

Three habits, in order of value:

1. **Deploy the thin shell first, before elaborating.** GW-09 was
   scheduled for the end of Sprint 0 for exactly this reason.
   Slipping it to Sprint 1 prep meant Sprint 0's tests were writing
   to a fiction. Had `/api/health` deployed on day 1 with a stub
   body, each subsequent addition (rate limiter, adapters,
   endpoints) would have been a small diff whose target-drift could
   be found in isolation.
2. **Smoke-test against the live target.** Now enforced by
   `scripts/smoke.mjs` (asserts 200, `rateLimit.configured: true`,
   web-origin payload equals API-origin payload) and its scheduled
   workflow.
3. **When scaffolding against a specific platform, read the
   platform's integration docs before the library's usage docs.**
   The failures above all drew defaults from `hono/vercel` /
   `@upstash/redis` docs; Vercel's own docs on Node Functions
   handler signatures, supported Node versions, and Marketplace env
   var conventions were not read. Library docs assume a generic
   target; platform docs describe the actual one.

### Sprint 1 — 2026-09-15 — GW-01 embedding gap

The strongest instance of the Sprint 0 lesson yet, and the same
structural shape one layer deeper. There, plausible library
defaults produced code that failed against the real deployment
target. Here, a pipeline reported success while producing nothing
usable — every gate was green, and every embedding was NULL.

The single generalisation worth writing down: **a component is only
verified by something downstream that consumes its output for real.
Tests that exercise a pipeline's own reporting verify the reporting,
not the pipeline.** Same lesson as Sprint 0, one abstraction level
in.

#### Failure — chunk embeddings never generated

- **Asserted** — GW-01's amended acceptance criteria listed
  *"retrieval relevance measured with and without extracted
  attributes on the golden set."* The ingest pipeline in
  `packages/ingestion/src/ingest-cli.ts` was assembled to satisfy
  that: chunker → attribute extractor → persist. Every test passed;
  the ingest run reported "297 attributes stored across 120
  products", the ADR-0004 addendum was written, the story was
  closed as `030dd0b`.
- **True** — The pipeline called OpenAI for **attribute extraction
  only**. The embedder was never wired in. Migration 001's
  `chunks.embedding vector(1536)` column and its HNSW index both
  existed on the table (which is what the schema tests checked) but
  the column was NULL on every one of the 417 chunks. Retrieval
  relevance on the golden set was structurally impossible: dense
  retrieval had nothing to search.
- **Found by** — GW-02's first experiment run. `pnpm retrieve`
  reported dense at 0.0% recall on all 18 populated-source cases
  and no errors. Debugging revealed the dense RPC's
  `WHERE embedding IS NOT NULL` clause was filtering out every
  chunk, because there were 417 chunks and 417 NULLs.
- **Locally detectable?** — No, and this is the part worth
  understanding. Nothing in the following was inconsistent:
  - **39 tests passed.** They exercised the chunker's composition,
    the extractor's source-span validation, the persistence
    layer's insert path, the CLI's env-var handling. None of them
    consumed the `embedding` column for read.
  - **Typecheck, lint, core-purity all clean.** They check what
    the code says, not what it does at runtime against Supabase.
  - **The ingest report claimed "297 attributes stored".** The
    report was a confident count of what the extractor *did* —
    correct. Nothing in the reporter's design checked what the
    extractor *should also have done* (call the embedder). The
    reporter is loyal to the code, not to the acceptance criteria.
  - **The `metadata` was correct.** The extracted-attributes JSON
    landed in `chunks.metadata` exactly as designed. That's what
    the coverage tool (`pnpm coverage`) measured. The chunk text
    was correct. The `document` join was correct.

  A downstream consumer that actually needed to read the embedding
  was the first thing that noticed. Every earlier gate was
  internally consistent with a pipeline whose specification differed
  from what GW-01's acceptance criteria required.

#### Meta-observation — reporting verifies reporting

The Sprint 0 lesson was *"internal consistency is not external
correctness"*. This is the same lesson, sharper: **a pipeline that
reports on its own outputs will not surface a gap between what it
does and what it was supposed to do**. The ingest report knew about
attribute extraction because the extractor ran; it knew nothing
about embeddings because nothing about embeddings was in the
pipeline the report described.

Two operational rules follow, and both apply to any pipeline the
project ships from now on:

1. **Acceptance criteria that name a downstream metric require a
   test that runs the metric against a real read.** GW-01's
   "retrieval relevance measured on the golden set" required an
   actual retrieval query hitting an actual Supabase read of the
   embedding column. Any check short of that verifies the
   reporting, not the pipeline.
2. **When a component is only used by another component that
   hasn't been built yet, the story that builds the consumer is
   the story that verifies the producer.** GW-02 (retrieval)
   is the first thing that read `chunks.embedding` for real; GW-02
   is what caught GW-01's gap. Story ordering that ships producers
   ahead of consumers must plan for producer-verification to slip
   into the consumer's story — because it will.

The Sprint 2 backlog now has an ingest-embedding fold-in as its
first item — folding embedding generation into `pnpm ingest` so a
fresh corpus refresh cannot ship with NULL embeddings again. The
consumer (retrieval) will verify the producer (ingest) on every
future run because it always has to read the column.

### Sprint 2 — 2026-09-15 — GW-10 router confidence falsified

Second instance of the same failure family. Recording it here
alongside GW-01 so the pattern is visible as a *class* of thing,
not just as two coincidences.

- **The assumption** — ADR-0010 specified `confidence` as an output
  of the router and assumed the safety gate (GW-11) could threshold
  on it for deferral of uncertain classifications. The LLM
  classifier's structured-output schema included a `confidence:
  number` field; the classifier was told to emit "your honest
  estimate 0..1 that the classification is correct." Nothing about
  this looked wrong until the field was measured.
- **The measurement** — the GW-10 pre-tuning baseline ran the
  classifier against all 40 golden cases. Every one returned a
  confidence value at or above 0.90. The LLM's contribution was
  uniformly 0.90 across all 34 cases it classified — including
  both of its two misclassifications. Rule-driven cases returned
  1.00 by construction. The four confidence bands collapsed into a
  single bucket [0.90, 1.00] at n=40. No threshold on this field
  distinguishes correct from incorrect predictions.
- **What the field actually was** — a number the LLM generated
  because the schema asked for one. Not a probability. Not
  calibrated. Not a signal. The model has no mechanism for
  "estimating its own correctness" on a classification it just
  emitted; asking it to produce that number produces a plausible
  digit, not an estimate.
- **Consequence** — GW-11 designs without confidence-gated
  deferral. Calibrated confidence (top-token log-probability,
  self-consistency across N samples, a calibration head) moves to
  the Sprint 3 candidate list. The `confidence` field stays in the
  RouterDecision interface with a code comment naming it as not
  load-bearing — removing it would churn every downstream reader
  for a Sprint 3 re-add.

#### Failure family

This is the same shape as GW-01's "297 attributes stored across
120 documents" report while every `chunks.embedding` was NULL:

- **GW-01** — the ingest report claimed a count the extractor
  actually computed. The count was correct. What was missing was
  a separate step (embedding) that no reporting field in the
  pipeline had a way to notice was absent.
- **GW-10** — the classifier emitted a confidence value the model
  actually generated. The value was returned. What was missing was
  any mechanism inside the model that would make the value
  correspond to something outside itself.

Both are **plausible outputs that carry no underlying signal**.
Both look right at the interface layer. Both fail only when a
downstream consumer treats the output as load-bearing and finds
that the number carries no information about the thing it seems
to describe.

The GW-01 lesson was *"reporting verifies reporting"*. The GW-10
lesson is stricter: *a model that generates a number when asked
for one is not the same thing as a model that measures*. Both
share the general shape: **an artefact of the pipeline's shape
is not the same as evidence about the pipeline's behaviour**.
The fix is the same in both cases — measure the field against
what it claims to describe before building anything on top of it.

#### Rule that follows

Any field a downstream consumer will threshold on gets a
calibration check before the consumer is written. For a numeric
field, that means: plot the field against ground-truth accuracy
across the dev set, and verify the correlation is monotone and
non-trivial. If accuracy is flat across the field's range, the
field carries no information and the consumer must not depend on
it. This applies as strongly to model-generated fields (`confidence`,
`likelihood`, `probability`) as to system-generated fields
(retrieval scores, rerank scores).

The check is cheap. Skipping it is what let GW-01 ship with NULL
embeddings and what would have let GW-11 ship with a confidence
threshold that gated nothing.
