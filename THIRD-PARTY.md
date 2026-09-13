# Third-party dependencies

Every runtime dependency in the workspace lands here with a one-sentence
justification. New deps require a PR entry. The core-purity CI check
guarantees that `packages/core` never appears in this file.

Format:

```
### <package> <version>
- Used in: <app or package>
- Why: <one sentence>
- Alternatives considered: <one line>
```

## Scaffold dependencies

### hono ^4.6
- Used in: apps/api
- Why: framework-agnostic web handler that runs identically on Node, Bun,
  and Vercel Functions; uses Web-standard `Request`/`Response` so core
  never sees a framework object.
- Alternatives considered: Fastify (more mature on long-running Node but
  couples request/reply shape); Express (too much ceremony, poor Vercel
  Functions story).

### @hono/node-server ^1.13
- Used in: apps/api (local dev only)
- Why: serves the Hono app on a real Node port during local development.
  On Vercel the `hono/vercel` adapter is used instead.
- Alternatives considered: running under `vercel dev` — rejected to avoid
  requiring the Vercel CLI for basic local dev.

### @upstash/ratelimit ^2, @upstash/redis ^1
- Used in: apps/api (per-IP rate limiting middleware, GW-37)
- Why: unauthenticated public endpoint that will soon call paid LLM APIs;
  rate limiting has to exist before the first request costs money.
  Upstash's HTTP-based Redis works on Vercel Functions without a
  persistent connection and has a usable free tier.
- Alternatives considered: in-memory (broken across function instances);
  Cloudflare KV (locks us to Cloudflare); Vercel KV (retired, see
  session-context knowledge update).

### react ^19, react-dom ^19
- Used in: apps/web
- Why: assessment stack; React 19 is the current stable.
- Alternatives considered: Preact (smaller but poorer library support for
  Sprint 1+ needs).

### vite ^5, @vitejs/plugin-react ^4
- Used in: apps/web (build/dev)
- Why: fast dev server, first-class React support, Vercel adapter is
  zero-config. Pinned to Vite 5 to match Vitest 2's internal Vite version
  and avoid a type-identity mismatch on `Plugin`.
- Alternatives considered: Vite 6 + Vitest 3 (works but two churn points
  at once); Next.js (heavier than the shell requires, and we don't need
  SSR for the answer engine's UI).

## Dev-only tooling

### @biomejs/biome 1.9.4
- Used in: root
- Why: single fast linter+formatter binary; keeps CI under the 90-second
  budget once evals and typecheck run in parallel.
- Alternatives considered: ESLint + Prettier (slower, more config surface).

### vitest ^2
- Used in: all packages
- Why: native Vite/ESM support; the same runner works in `packages/core`
  without pulling in a framework.
- Alternatives considered: Jest (heavier, ESM story is still fiddly).

### typescript 5.7
- Used in: root
- Why: strict types across the workspace.

### tsx ^4
- Used in: apps/api (dev script)
- Why: run TS entry points without a build step during dev.

## Python (eval harness only — never imported by the app)

### requests ^2.32
- Used in: evals/
- Why: boring, well-understood HTTP client. Harness calls the deployed
  API over HTTP; async isn't needed for a small case set.

### pydantic ^2.9
- Used in: evals/
- Why: schema validation for dataset cases and API responses. A bad
  case in the JSONL should fail loudly with a line number, not corrupt
  a run silently.

### pytest ^8, responses ^0.25 (dev)
- Used in: evals/
- Why: the harness has its own tests. `responses` stubs the HTTP client
  in unit tests so tests don't need a running API.

## Deferred — added when the story that needs them lands

- `@supabase/supabase-js` — CatalogueRepository / TraceSink adapters
- LLM SDK (provider TBD) — LanguageModel adapter (see ADR-0001)
- pgvector client bindings — Retriever adapter
- Cohere / cross-encoder rerank client — only if Sprint 1 experiment
  justifies it (see ADR-0001)
