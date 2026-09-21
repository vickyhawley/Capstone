# Design and testing

This document consolidates the design, architecture, deployment and
testing decisions behind Groundwork — the AI answer engine built as
the assessed artifact for this MSc Software Engineering capstone.
It is written to answer the four questions the capstone rubric asks
of a design-and-testing document:

1. What are the significant design and architectural decisions, and
   why were they taken?
2. What software and architectural patterns are used?
3. What deployment options were considered, and what are the cost
   implications?
4. What software testing was carried out, and by what methods?

The document is deliberately self-contained. Individual decisions
are captured in more detail as Architecture Decision Records under
`docs/adr/`, and cross-referenced by number below.

---

## 1. System overview

Groundwork is a grounded answer engine for a specialist equine
retailer (New Forest Country Store, "NFCS"). A customer asks a
question in natural language — "do you sell HorseHage Timothy?",
"can I get feed delivered to SO41?", "what saddle would suit a
narrow thoroughbred?" — and Groundwork returns an answer that is:

- **Cited**: every factual claim binds to a retrieved source ID
  (product record, prose guide, tool return). Claims without a
  source are dropped, not invented.
- **Grounded in tools, not memory, for facts that change**: stock,
  delivery zones, opening hours and product specs come from tools
  the model must call, not from the model's own knowledge.
- **Refused when unsafe**: welfare and clinical questions are
  short-circuited before generation and routed to a vet.

The request pipeline is `safety gate → intent router → retrieval
and tools → synthesis with citation binding`. Any stage can
short-circuit the chain; a refused turn incurs zero generation
cost.

The web app is a single-page React shell that streams answers
token-by-token from the API over Server-Sent Events. Tool calls
surface progressively in the UI ("Checking stock…") so the user
sees the pipeline working rather than a spinner.

---

## 2. Design and architectural decisions

The decisions below are the ones that shape the whole system, not
just one feature. Each links to the ADR that carries the full
argument and the alternatives that were rejected.

### 2.1 Ports and adapters as the top-level architecture

`packages/core` contains the domain logic and port interfaces and
must not import any framework, SDK or HTTP client. A CI check
(`pnpm check:core-purity`) fails the build if a runtime dependency
leaks in. Adapters in `packages/adapters` implement the ports;
the API and web apps compose adapters together at their
composition roots.

**Why.** Three concrete payoffs, all realised in this project:

- The eval harness injects fake adapters (`stub-retriever`,
  `stub-synthesizer`, `stub-tool-registry`) and drives the full
  pipeline through pure functions, so the golden dataset runs
  in milliseconds without touching OpenAI or Supabase.
- Swapping the vector store, LLM provider or trace backend is a
  one-file change plus a config swap, not a codebase migration.
- The domain vocabulary (Intent, Route, Finding, Citation) lives
  in one place and is authoritative — ADRs reference it and the
  UI reflects it, so grader and code speak the same nouns.

The constraint is load-bearing enough that it is enforced by a
scripted lint, not left to reviewer discipline.

### 2.2 Retrieval — hybrid dense + sparse with reciprocal-rank fusion

Groundwork's retrieval layer combines a pgvector dense retriever
(cosine similarity on OpenAI embeddings) with a Postgres full-text
sparse retriever (`ts_rank_cd` over stemmed lexemes), fused with
reciprocal-rank fusion (RRF) rather than a learned reranker.

**Why.** Sparse alone misses paraphrase ("hard feed for a
finicky eater"); dense alone misses SKU-specific queries
("HorseHage Timothy 20kg"). RRF is parameter-light, has no
training cost, degrades gracefully when one leg is weak, and
was measurable against a golden set from Sprint 1 onwards.
Full argument and rejected alternatives (learned rerankers,
BM25-only, pure dense): [ADR-0001](adr/0001-hybrid-retrieval.md).

### 2.3 Tool layer — function-calling loop with a hard iteration bound

The synthesizer runs inside a bounded function-calling loop. It
sees a system prompt, the router's intent, and a tool registry
declaring available tools (stock lookup, substitute lookup,
delivery-zone, shop-info). It may call zero or more tools before
producing its final answer. Iteration count and wall-clock timeout
are both bounded, and the wall-clock timeout is set such that the
iteration bound is reachable within it — the loop can never claim
"I ran out of iterations" while still having a large wall-clock
budget remaining.

**Why the bounded loop over a single-shot prompt.** Some
customer questions genuinely need two tools ("do you have
Timothy in stock, and can you deliver to SO41"). A single-shot
"stuff every possible tool result into the prompt" pattern
would balloon token cost and force the model to filter noise;
letting the model decide keeps the prompt focused. The
iteration bound stops runaway loops from a confused planner.

**Why iteration and timeout are jointly sized.** Debugging a
loop that quietly hits a wall-clock timeout mid-turn is far
harder than debugging one that hits a named iteration ceiling
with a legible error. Full argument: [ADR-0002](adr/0002-iteration-vs-timeout.md)
and [ADR-0014](adr/0014-tool-layer-function-calling-loop.md).

### 2.4 Safety gate — deterministic, intent-driven, three tag rules

The safety gate runs before the router and can short-circuit
the entire pipeline. It is deterministic — no LLM call — and
operates on three tag families: clinical, welfare-emergency
and out-of-scope. A matched tag drives a behaviour (refuse,
escalate to vet, hand off to human), not an answer.

**Why deterministic and not an LLM classifier.** The failure
mode we care about most (a customer describing a clinical
emergency getting a helpful-sounding answer instead of "call
your vet") must be impossible to regress under prompt changes.
Rules-based gating is auditable, testable line-by-line, and
runs at zero cost per turn. False refusals are tracked as a
first-class metric alongside correct abstention — improving
one at the cost of the other is a regression, not progress.
Full argument: [ADR-0011](adr/0011-safety-gate.md).

### 2.5 Intent router — descriptive-only, rules first, LLM fallback

The router assigns each turn one of a small set of intents
(product, stock, delivery, shop-info, welfare, other). Rules
handle the high-confidence cases (regex match on stock queries,
postcode present, greeting-only turn); an LLM classifier handles
the rest. The router is *descriptive* — it labels the intent, it
does not decide what to do about it. That decision is the safety
gate's job (§2.4) and the tool loop's job (§2.3).

**Why the separation.** Bundling "what did they mean" with "what
should we do" produced a router that grew opinions and became
brittle every time a new tool landed. Splitting them means the
router's contract is stable (six labels, one confidence score),
and every new tool or safety rule slots into the layer that owns
that concern. Full argument: [ADR-0010](adr/0010-intent-router.md).

### 2.6 Deterministic tool answers with three-state semantics

Stock, substitute and delivery-zone tools return one of three
states, never two: `available`, `unavailable`, or `pending`
(the tool cannot determine an answer right now — network flap,
upstream partial outage). The synthesizer treats `pending`
distinctly: it says "let me get back to you" rather than
"unavailable", which would be a factually wrong answer.

**Why three states.** Collapsing "unavailable" and "pending"
into one bit gives the model a way to state falsehoods
confidently when the tool is degraded. Three states costs one
enum entry and prevents an entire class of ungrounded answers.
Full argument: [ADR-0016](adr/0016-stock-lookup-three-state.md).

### 2.7 Trace persistence — append-only, JSONB attributes

Every turn writes a trace record: turn ID, router decision,
tool calls with arguments and returns, synthesizer prompt hash,
answer, citations, and latency breakdown. Traces go to an
append-only `traces` table in Supabase, with unstructured
attributes as JSONB so the shape can evolve without a
migration per new field.

**Why append-only.** Traces are the primary evidence for eval
regressions and incident post-mortems. An update-in-place table
loses the fact that a decision *changed* between two runs;
append-only preserves it. Duplicate handling is narrow: same
turn ID overwrites (safe re-runs), same (turn ID, retry) always
appends. Full argument: [ADR-0015](adr/0015-trace-persistence.md).

### 2.8 Corpus composition — two document types, distinct handling

The retrieval corpus contains two document types: product records
(structured attributes: name, SKU, price, tags, description) and
prose guides (bit and bridle sizing, rug fit, delivery FAQ). They
are chunked, embedded and indexed separately, with attribute
extraction at ingest for products and paragraph-level chunking
for prose.

**Why two types, not one.** Product answers need attribute
grounding (a size, a price, a tag). Prose answers need paragraph
grounding (a sentence, a bulleted list). Coercing both into one
chunking scheme meant the synthesizer either invented product
attributes from prose fragments (over-eager) or refused product
questions when only the guide was retrieved (over-cautious).
Full argument: [ADR-0003](adr/0003-corpus-composition.md) and
[ADR-0004](adr/0004-attribute-extraction.md).

### 2.9 Deterministic chunk IDs

Chunk IDs are `hash(document_id, ordinal, content)` — not
UUIDs. Regenerating the corpus from the same source produces
the same chunk IDs, so trace records that cite a chunk stay
valid across ingestion runs unless the content actually changed.

**Why.** Eval regressions attribute cleanly to the chunk that
moved. Without deterministic IDs, a re-embedding run invalidates
every cited chunk and makes it impossible to tell "the retrieval
got worse" from "the chunks got renumbered".
Full argument: [ADR-0013](adr/0013-deterministic-chunk-ids.md).

### 2.10 Compliance surface — Article 50 disclosure + capability profile

The system exposes a machine-readable capability profile (what
the assistant will and will not do, what data it uses) and a
plain-language disclosure surface for the customer-facing UI,
covering EU AI Act Article 50 requirements around AI-generated
content and interaction transparency. The disclosure is not
hidden behind a modal — it is the first thing a new session
sees. Full argument: [ADR-0012](adr/0012-compliance-surface.md).

---

## 3. Software and architectural patterns used

The patterns below appear across the codebase and are worth
naming explicitly because they are the ones a reviewer with a
software-architecture lens will look for.

### 3.1 Ports and adapters (hexagonal architecture)

`packages/core` defines ports; `packages/adapters` implements
them; apps wire them together at composition roots. The
`check:core-purity` script is a build-time enforcement of the
"dependencies point inward" rule. See §2.1.

### 3.2 Composition root

Each app (`apps/api`, `apps/web`) has a single point where
adapters are instantiated and injected into use-case handlers.
The web app's composition root lives in `apps/web/src/App.tsx`;
the API's in `apps/api/src/server.ts`. Nothing else in the app
instantiates an adapter directly — a rule reviewers can
mechanically check.

### 3.3 Adapter pattern

Every external dependency (OpenAI, Supabase, catalogue store,
trace sink) is wrapped in an adapter that implements a
domain-owned port interface. The adapter translates domain
vocabulary to the external service's vocabulary and back. Swaps
between providers, or between real and stub implementations,
happen at the composition root.

### 3.4 Circuit breaker

Per-dependency circuit breakers wrap the OpenAI and Supabase
clients. Repeated failures open the breaker for a cooldown
window rather than continuing to hammer a degraded upstream.
Implementation: `packages/core/src/circuit-breaker.ts`, with a
test suite covering the state machine (closed → open → half-open
→ closed) and the interaction with error-as-data return shapes
(the memory linked as [[model_supabase_error_as_data]] captures
the specific gotcha where a naive wrapping under-counts errors).

### 3.5 Reciprocal-rank fusion

The retriever combines dense and sparse rankings using RRF:
`score(doc) = Σ 1/(k + rank(doc, ranker))`. Implementation:
`packages/adapters/src/retriever/fusion.ts`. See §2.2 and
[ADR-0001](adr/0001-hybrid-retrieval.md).

### 3.6 Bounded function-calling loop

The synthesizer runs inside `packages/core/src/tool-loop.ts` — a
loop that gives the model a tool registry, calls tools it
requests, feeds the results back, and exits either when the
model returns a final answer or when the iteration bound is
reached. See §2.3 and [ADR-0014](adr/0014-tool-layer-function-calling-loop.md).

### 3.7 Three-state semantics for tool results

Available / unavailable / pending, not a boolean. Appears in
every tool that queries a mutable upstream. See §2.6 and
[ADR-0016](adr/0016-stock-lookup-three-state.md).

### 3.8 Server-Sent Events for streaming responses

The API streams tokens over `text/event-stream` on the default
Node.js runtime. Progressive tool disclosure ("Checking stock…",
then "Found 3 matches, drafting answer…") rides the same stream
as content events, so the UI can render pipeline progress
without a separate WebSocket or polling channel.

### 3.9 Same-origin rewrite for CORS elimination

The web project's `vercel.json` rewrites `/api/*` to the API
project's origin. The browser only ever talks to one origin,
so no CORS preflight, no third-party cookie friction, and no
per-environment origin allow-list to maintain.

### 3.10 Deterministic content-addressed IDs

Chunk IDs are content hashes. Order fixtures use a fixed seed.
Regenerating produces byte-identical output, so evals and
traces stay comparable across runs. See §2.9 and §5.

### 3.11 Three-tier testing pyramid

Tier 1 fast structural checks on every commit, Tier 2 pipeline
evals on every PR, Tier 3 red-team scenarios on prompt or model
changes. See §5.

---

## 4. Deployment options and cost implications

### 4.1 Options considered

Three plausible deployment shapes were considered:

**Option A: Two Vercel projects, one repository (chosen).**
Web project (Vite React) and API project (Hono on Vercel
Functions) deploy from `apps/web` and `apps/api` respectively.
Same-origin rewrite handles the browser-to-API path. Both
projects run on the Vercel Hobby plan free tier.

**Option B: Single Vercel Next.js app.** Web and API routes
would live in the same Next.js project. Rejected because the
capstone design brief explicitly separates concerns behind
port boundaries — collapsing them into one framework project
would blur that separation for a small deployment convenience.
The two-project shape also lets the API be exercised
independently (`curl https://groundwork-api.vercel.app/api/health`),
which is useful for incident triage and demo recording.

**Option C: Self-hosted (Fly.io / Railway / a Kubernetes
cluster).** Rejected on cost, complexity, and rubric fit. The
system is a capstone artifact, not a production service with
paying users. Every hour spent on cluster ops is an hour not
spent on the assessed engineering evidence.

### 4.2 Chosen configuration

- **Web**: `groundwork-web` on Vercel, deployed from `apps/web`.
  Public alias `capstone-web-ten.vercel.app` (retained because
  Hobby-plan projects cannot mint new `*.vercel.app` aliases
  after rename).
- **API**: `groundwork-api` on Vercel Functions, deployed from
  `apps/api`. Node.js runtime under Fluid Compute (default).
- **Database and vector store**: Supabase free tier (Postgres
  with pgvector extension). Used for the retrieval corpus and
  the trace sink.
- **LLM provider**: OpenAI direct (embeddings for indexing,
  GPT-4o for synthesis). Wrapped behind the `LanguageModel`
  port so a swap to another provider — or to Vercel's AI
  Gateway for observability and fallback — is a composition-
  root change.
- **CI/CD**: GitHub Actions running four workflows —
  `ci.yml` (typecheck + lint + tests + core-purity, ≤5 min
  budget), `evals.yml` (golden-dataset gate on PRs), `redteam.yml`
  (prompt/model-change gated), `smoke.yml` (post-deploy health).

### 4.3 Cost implications

Costs fall into three buckets. Precise figures are estimates
from published pricing at the time of writing (2026-09) and
would need a live-traffic re-baseline before productionising.

**Hosting** — £0 while within Vercel Hobby limits (100 GB
bandwidth/month, 100 GB-hours of function execution, deploys
unlimited). Groundwork's traffic in demo and eval scenarios
is well inside these bounds. Upgrading to Pro (~£20/month per
member) would be triggered by moving off `*.vercel.app` to a
custom domain with analytics or by needing team seats — not
by hitting compute limits.

**Database** — £0 on Supabase free tier (500 MB Postgres,
1 GB file storage, 50k monthly active users, 2 GB egress).
The corpus fits comfortably; traces would need a rotation
policy at scale.

**LLM inference** — the material cost driver. Two components:

- *Embeddings at ingest*: OpenAI `text-embedding-3-small` at
  approximately $0.02 per 1M tokens. Ingesting the NFCS
  catalogue plus guides is a few thousand chunks; a full
  re-index is well under $1.
- *Synthesis per turn*: OpenAI `gpt-4o` at approximately $2.50
  per 1M input tokens and $10 per 1M output tokens. A typical
  Groundwork turn is ~1.5k input tokens (system prompt +
  retrieved chunks + tool results + conversation) and ~200
  output tokens, so ~$0.006 per turn on the model itself.
  Refused turns cost nothing (the safety gate short-circuits
  before synthesis).

At a hypothetical 100 turns/day (a realistic ceiling for a
single-shop assistant, given traffic patterns discovered in
the [[project_nfcs_customer_signals]] discovery), unit
economics are roughly £0.50/day or £15/month in inference.
Well inside the "does not need a paid tier" envelope, and
the design keeps the option open to route traffic through
Vercel AI Gateway for spend caps and provider fallback
without touching domain code.

**Cost controls actually built in**:

- Safety-gated refusals are zero-cost — the OpenAI call never
  fires for a clinical or out-of-scope turn.
- The tool loop is iteration-bounded, so a confused planner
  cannot run away with a customer's session.
- Rate limiting per client is implemented at the API layer
  (`apps/api/src/rate-limit.ts`) to cap the blast radius of
  either an abusive client or a bug in the web app.
- Circuit breakers on OpenAI and Supabase clip cascade cost
  during upstream failures.

### 4.4 Deployment operations

- **Deploys**: `vercel --prod --cwd apps/api` and
  `vercel --prod --cwd apps/web` from the repo root. Each
  app owns its own `.vercel/` link file.
- **Environment variables**: managed with `vercel env pull`
  into `.env.local`, never committed. `.env.example` documents
  the required keys.
- **Verification**: `pnpm smoke` hits both origins and asserts
  the web-through-rewrite response matches the API-direct
  response. Runs post-deploy in `smoke.yml`.
- **Rollback**: Vercel's instant rollback via the dashboard
  or `vercel rollback`. Previous deployments remain addressable
  as immutable preview URLs indefinitely.

---

## 5. Software testing carried out

Testing runs at three tiers with increasing scope and cost.
The pyramid shape is deliberate: Tier 1 catches regressions
in seconds on every commit; Tier 2 catches semantic
regressions on every PR; Tier 3 catches adversarial
regressions when prompts or models change.

### 5.1 Tier 1 — structural unit tests

**Runs on**: every commit, via `ci.yml`. Total budget: 5
minutes for typecheck + lint + tests + core-purity check.
Actual runtime is well under the budget.

**Test count** (from the current sprint-log): 524 tests
across:

- **core**: 77 tests. Pure unit tests on domain logic and port
  contracts — circuit breaker state machine, tool loop
  behaviour under iteration cap, error taxonomy, embedding
  utility.
- **adapters**: 227 tests. Adapter behaviour against fakes
  and — for the retriever — an in-memory pgvector stub.
  Includes the tool registry (stock, substitute, delivery,
  shop-info) and the synthesizer's summarisation behaviour.
- **api**: 51 tests. HTTP-level integration tests through
  Hono, covering the answer endpoint, streaming answer
  endpoint, rate limits and about endpoint.
- **web**: 4 tests. Component-level tests on the message
  rendering surface (the UI is thin — most logic lives in
  core and adapters).
- **ingestion**: 53 tests. Pipeline tests for corpus ingest,
  chunking and attribute extraction.
- **Python (evals)**: 112 tests. Metric implementations
  (grounding score, retrieval relevance, tool-call accuracy),
  eval harness plumbing, and fixture validation.

**Methods used**: table-driven tests for enumerated behaviour
(safety tag families, three-state tool results), state-machine
tests for the circuit breaker, property-style tests for
deterministic-ID stability, and contract tests for every port
so an adapter swap cannot silently change semantics.

**Framework**: Vitest for TypeScript, pytest for Python.

### 5.2 Tier 2 — golden-dataset pipeline evaluation

**Runs on**: every PR, via `evals.yml`. Also on demand from
the eval harness in `evals/`.

**What it does**: runs a curated golden dataset (customer
questions with expected intent, expected retrieved chunks,
expected tool calls, expected answer shape) through the full
pipeline using real adapters against fixture data. Metrics
computed and gated:

- **Groundedness**: proportion of factual claims in the
  answer that bind to a retrieved chunk or tool return.
  Threshold rises across sprints as retrieval improves.
- **Retrieval relevance**: precision@k on the golden
  expected-chunks set.
- **Tool-call accuracy**: did the model call the right tool
  with the right arguments for questions that require a
  tool?
- **Correct-abstention rate**: for the clinical/welfare
  subset, did the safety gate refuse cleanly?
- **False-refusal rate**: for the benign subset, did any
  refusals fire that should not have?

Correct-abstention and false-refusal move together — a change
to safety rules is only an improvement if both move in the
right direction. Regressions on either fail the gate.

Results are committed to `evals/results/` per sprint. The
improvement curve across sprints is itself assessed evidence
— history is not overwritten.

### 5.3 Tier 3 — red-team scenarios

**Runs on**: prompt or model changes, via `redteam.yml`
(manual + change-gated). Not on every PR; expensive and
noisy for unrelated changes.

**What it covers**: the LLM-application failure modes from
the OWASP LLM Top 10 that are actually reachable in this
architecture — prompt injection (customer message tries to
override system prompt), boundary probing (customer asks the
assistant to describe its rules or leak its prompt), insecure
output handling (customer tries to get the assistant to emit
executable content), excessive agency (customer tries to
manipulate a tool call — "cancel my last order").

Each scenario is a fixture with an adversarial input and a
labelled expected behaviour ("refuses", "answers narrowly
without complying", "escalates to human"). Failures are
inspected by hand — red team is not a pass/fail number, it
is a set of scenarios you must be able to explain the outcome
of.

### 5.4 Post-deploy smoke test

**Runs on**: every production deploy, via `smoke.yml`.

The smoke test hits `/api/health` on both origins (direct API
and via the web rewrite) and asserts:

- Both return HTTP 200.
- Both return identical JSON.
- Health response includes the deployed commit SHA — a
  divergence between web-through-rewrite and API-direct is
  the earliest signal that a deploy landed on one project but
  not the other.

The web-vs-api parity check is what caught the specific
class of bug where a rewrite target got mispointed at an
older API deployment — a subtle regression that unit tests
cannot see because they never cross the rewrite boundary.

### 5.5 Testing methods, summarised

| Method | Where it runs | What it catches |
|---|---|---|
| Type-checking (TypeScript strict) | Every commit | Type-level contract violations |
| Static lint (ESLint + core-purity script) | Every commit | Style and architecture-rule violations |
| Unit tests (Vitest / pytest) | Every commit | Logic regressions in a single module |
| Contract tests (per port) | Every commit | An adapter swap changing semantics |
| Integration tests (HTTP-level) | Every commit | Wiring regressions between adapters |
| Golden-dataset eval | Every PR | Semantic regressions in retrieval, tools, or grounding |
| Red-team scenarios | Prompt/model change | Adversarial regressions and safety-gate holes |
| Post-deploy smoke | Every prod deploy | Environment and rewrite regressions |
| Architecture-purity script | Every commit | Domain layer accreting framework dependencies |

Coverage numbers are deliberately not headline metrics.
Coverage as a target rewards shallow tests; the golden-set
gate and the red-team scenarios are the metrics that reward
the tests that actually change behaviour.

---

## 6. Data handling

### 6.1 Synthetic order data, not real NFCS records

Groundwork does not consume the real order history from the New
Forest Country Store production hub. All order and client fixtures
under `data/synthetic/` are generated by `scripts/generate_orders.py`
over the real product catalogue with entirely fabricated customers.

**Why synthetic.** The production hub's client records carry phone
numbers, horse names, birthdays, staff notes and delivery
photographs. NFCS operates in a single town's catchment (Ringwood
and the western New Forest); the customer set is small enough that
even aggressive anonymisation leaves records re-identifiable by
combinations of order date, distance from the shop, staple basket
composition, and delivery district. There is no anonymisation
scheme that survives that level of joint identifiability at
single-town scale, so the safe move is to not consume the data at
all.

**What the synthetic set preserves.**

- `clientKey` as normalised phone-first identity, matching how the
  production hub keys unified online/phone traffic.
- Repeat consumable purchases on rough cycles (feed, bedding,
  haylage) versus one-off hardware and clothing.
- The `local-delivery-only` product tag, driving the constraint
  that bulky goods to a client outside the 20-mile free-delivery
  radius become collection-only. This is a real NFCS business
  rule, already encoded in the catalogue tagging.
- Client archetypes (regular, occasional, at-risk, one-off) that
  mirror the production hub's own segmentation, so fixtures for a
  future "their usual" suggestion tool are already realistic.
- Postcode districts that actually appear in customer messages.

**What the synthetic set does not preserve.**

- Real names, phone numbers, addresses, or dates. Phone numbers use
  Ofcom's reserved drama range (07700 900000 – 07700 900999),
  guaranteed unassigned, so a leaked fixture cannot spam a real
  person. Emails use the `example.invalid` TLD (RFC 2606).
- Any per-customer signal that would identify a real person —
  horse names, veterinary notes, gift recipients, or house numbers.
- The actual volume, seasonality, or absolute revenue of NFCS.
  Totals in the fixture set are shape-preserving, not accurate.

**Reproducibility.** The generator is deterministic (fixed seed).
Regenerating produces the same file byte-for-byte, so eval cases
that reference a specific `order_id` or `client_key` stay valid
across sprint runs. Bump the seed constant only when the shape of
the data needs to change; document the reason in the commit that
changes it.

### 6.2 Secrets handling

- Environment variables live in `.env.local` (git-ignored) or
  in Vercel's environment-variable store. Never in the repo.
- `.env.example` documents required keys with placeholder values
  so a new checkout knows what to configure without exposing any
  real value.
- OpenAI keys are project-scoped, not personal keys.
- Supabase uses service-role keys server-side only; the browser
  sees only the anon key and is constrained by row-level security
  policies.

### 6.3 What the customer sees

The disclosure surface (see §2.10) declares:

- That the customer is talking to an AI assistant, not a human.
- What data the assistant uses to answer (product catalogue,
  guide content, no personal history).
- What the assistant will not do (clinical advice, welfare
  triage) and where to go instead.

The disclosure is visible at session start, not tucked into a
modal or a footer.
