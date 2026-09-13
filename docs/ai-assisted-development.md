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
