# Groundwork

A grounded answer engine for specialist equine retail. Answers product, fit
and logistics questions from a cited knowledge base, calls deterministic
tools rather than guessing facts, and routes welfare or clinical questions
to a vet instead of answering them.

This is an MSc Software Engineering capstone. It is graded on documented
engineering decisions as much as on working code.

## Deployed URL

- Web (public): <https://capstone-web-ten.vercel.app> — same-origin rewrite
  sends `/api/*` to the API. Verify with:
  `curl https://capstone-web-ten.vercel.app/api/health`.
- API (direct): <https://groundwork-api.vercel.app/api/health> — same JSON
  as above, useful for isolating API vs rewrite in incident triage.

The web URL retains the earlier `capstone-web` name because Vercel's Hobby
plan doesn't allow adding new `*.vercel.app` aliases after the fact. The
Vercel project itself is renamed to `groundwork-web`; only the auto-minted
public alias still carries the older name.

## Corpus and scope (AI Engineering Project brief)

The AI Engineering Project brief calls for a RAG application over a
"corpus of company policies & procedures." This project answers that
brief with a **customer-facing policy corpus** for a specialist equine
retailer rather than the more common employee-facing HR set (PTO,
expense, remote-work). Same shape of grounded-Q&A problem; different
audience.

The corpus (in `data/`, ~35 pages total) covers the policies a
prospective customer actually needs to know before ordering:

| File | Policy topic |
|---|---|
| `data/guides/delivery.md` | Delivery zones, postcode eligibility, cut-offs |
| `data/guides/opening-hours.md` | Shop hours, bank-holiday rota, out-of-hours contact |
| `data/guides/rug-sizing.md` | Sizing / fit guidance (customer self-service) |
| `data/nfcs-shop-info.yaml` | Contact routes, ordering channels, subscription eligibility |
| `data/nfcs-out-of-scope.yaml` | Brands / categories the shop won't stock (policy: what we say no to) |
| `data/nfcs-pending.yaml` | Products temporarily out of stock (policy: what we say "not right now" to) |
| `data/delivery-districts.yaml` | Delivery-district → zone mapping (rule table) |
| `data/catalogue/products.csv` | Product catalogue (398 products, 1,454 variants) |

These are policies the way a shop reasons about its own operations:
what we sell, where we deliver, when we're open, what we won't touch,
and where welfare questions must be escalated. Two of them
(`nfcs-out-of-scope.yaml`, `nfcs-pending.yaml`) are literally policy
lists — the shop's explicit rules about which products it will refuse
to stock and why. The safety gate (see `docs/adr/0011-safety-gate.md`)
enforces one more policy: welfare/clinical questions escalate to a
vet, never to the assistant.

The eval harness (65 cases in `evals/datasets/sprint-1/cases.jsonl`,
real customer questions from the shop's social-DM export, PII-stripped)
targets these policy surfaces plus the retrieval-grounded product
Q&A they compose with.

## Project board

See [`docs/project-board.md`](docs/project-board.md) for the full
Kanban-style view of all 37 stories across four sprints, with status
and evidence pointers. The document is versioned with the code so the
board state at any commit is reproducible.

The `docs/design-and-testing.md` document is the assessed design and
testing artifact (architecture decisions, patterns used, deployment
options with cost implications, and testing methodology).

## CI status

![CI](https://github.com/vickyhawley/Capstone/actions/workflows/ci.yml/badge.svg)
![Evals](https://github.com/vickyhawley/Capstone/actions/workflows/evals.yml/badge.svg)
![Red team](https://github.com/vickyhawley/Capstone/actions/workflows/redteam.yml/badge.svg)

## Quickstart

Prerequisites: Node 24 (`nvm use`), pnpm 9, a Supabase project (for
migrations only — not required to run the shell).

```bash
pnpm install
cp .env.example .env.local        # fill in as you wire adapters
pnpm dev                          # runs web on 5173 and api on 8787
```

Individual apps:

```bash
pnpm dev:web    # apps/web (Vite, http://localhost:5173)
pnpm dev:api    # apps/api (Hono, http://localhost:8787)
```

Verification during dev:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm check:core-purity
```

## Reproducibility

The brief asks about fixed seeds "for deterministic chunking or evaluation
sampling." This project doesn't need seed setup because:

- **Chunking is content-hash deterministic**, not random. See
  [ADR-0013 (`docs/adr/0013-deterministic-chunk-ids.md`)](docs/adr/0013-deterministic-chunk-ids.md):
  every chunk ID is `hash(document_id, ordinal, content)`. Re-ingesting
  the same document produces byte-identical chunk IDs across runs.
- **Eval sampling is exhaustive**, not sampled. The runner iterates
  every case in the dataset; no random sub-selection.
- **Embedding calls are the one non-deterministic step** — OpenAI's
  `text-embedding-3-small` isn't temperature-controlled. Retrieval
  results can drift slightly across runs on the same query. This is
  named as a known limitation in `docs/design-and-testing.md`. The
  eval harness tolerates it because the metrics (groundedness,
  recall@k) measure set overlap, not exact ordering.

For anyone re-running the eval harness against the deployed API:

```bash
cd evals
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
groundwork-evals \
  --dataset datasets/sprint-1/cases.jsonl \
  --thresholds thresholds/sprint-2.json \
  --sprint capstone \
  --api-url https://groundwork-api.vercel.app
```

Results land in `evals/results/sprint-capstone/<timestamp>.json` with
the full breakdown (per-metric aggregates, per-provenance slices,
per-case latency, threshold breaches).

## Architecture

Ports and adapters. `packages/core` holds domain logic and port interfaces
and **must not import any framework, SDK or HTTP client** — CI enforces
this. Adapters in `packages/adapters` implement the ports. This constraint
is load-bearing: it's what makes the eval harness able to inject fakes, and
it's a claim made in the assessed design document.

Request path: safety gate → intent router → retrieval → synthesis with
citation binding. Any stage can short-circuit the chain. Clinical questions
are stopped before generation, so a refused turn incurs no generation cost.

## Non-negotiable rules

- Scope is frozen at 36 stories in the project board. Never add features.
  Flag gaps for the human to decide on.
- Every factual claim in an answer binds to a retrieved source ID. Claims
  without a source are dropped, never invented.
- Deterministic facts (stock, sizing, delivery zones) come from tools. The
  model never answers them from its own knowledge.
- Refusal is a feature. When changing safety behaviour, check both the
  correct-abstention and false-refusal metrics — improving one at the cost
  of the other is a regression.
- No secrets in the repo. No real customer data, ever. All product and
  content data is synthetic.
- Anything crossing a port boundary gets a docstring: what it does, what it
  assumes.

## Definition of Done

A story isn't done until: merged via PR, tests passing, a new eval case
added where behaviour changed, CI green, deployed and verified on the public
URL, code documented, and any arguable decision captured as an ADR in
`docs/adr/`.

## Testing

Three tiers. Tier 1 (every commit, milliseconds): schema validity, JSON
parsing, label sets, no PII in output, well-formed tool args. Tier 2 (every
PR): golden dataset through the full pipeline, gated on groundedness,
retrieval relevance and tool-call accuracy. Tier 3 (prompt or model
changes): red-team set covering prompt injection, boundary probing,
insecure output handling, excessive agency.

Eval results are committed to `evals/results/` per sprint. The improvement
curve across sprints is assessed evidence — don't overwrite history.

## Working style

Plan before building. Prefer boring dependencies; every one lands in
`THIRD-PARTY.md` and needs a justification. When a decision is non-obvious,
write it down where a grader will find it.

## Deploy path (week one)

Two Vercel projects, one repo. Web project rewrites `/api/*` to the API
project, so the browser talks to a single origin and no CORS is needed.

Each app owns its own `.vercel/` link, created by running `vercel link`
from **inside that app's directory**. Deploys are then invoked with
`--cwd` so the command runs from the repo root without changing directory
and without swapping link files.

```bash
# 1. Install the CLI (once)
npm i -g vercel

# 2. Link each project (once per clone)
(cd apps/api && vercel link)    # existing project: groundwork-api
(cd apps/web && vercel link)    # existing project: groundwork-web

# 3. Deploy — always from the repo root, targeting the app with --cwd
vercel --prod --cwd apps/api
vercel --prod --cwd apps/web
```

The subshell parentheses in step 2 mean your terminal stays at the repo
root after linking; step 3 keeps you there too. No `cd` needed for
day-to-day deploys.

**Verify** with the smoke script:

```bash
pnpm smoke
```

Fails loudly if either origin is unhealthy or the web-origin response
diverges from the API's — see `scripts/smoke.mjs` for the exact checks.

## Repository map

```
apps/
  web/            React 19 + Vite shell
  api/            Hono service on Vercel Functions
packages/
  core/           Domain + port interfaces. Zero runtime deps. CI-enforced.
  adapters/       Port implementations. Stubs until wired in later sprints.
docs/
  adr/            Architecture Decision Records
  sprint-log.md   One entry per sprint: what shipped, what didn't, why
supabase/
  migrations/     SQL migrations, numbered
.github/workflows/
  ci.yml          Typecheck, lint, tests, core-purity. ≤ 90s.
  evals.yml       Golden-dataset gate. Real content lands in Sprint 1.
  redteam.yml     Manual + prompt-change gated. Real content lands later.
```
