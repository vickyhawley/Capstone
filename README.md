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

## Project board

`TODO` — link to the 36-story board.

## CI status

![CI](https://github.com/TODO/groundwork/actions/workflows/ci.yml/badge.svg)
![Evals](https://github.com/TODO/groundwork/actions/workflows/evals.yml/badge.svg)
![Red team](https://github.com/TODO/groundwork/actions/workflows/redteam.yml/badge.svg)

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
