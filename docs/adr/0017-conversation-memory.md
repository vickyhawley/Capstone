# ADR-0017 — Conversation memory: server-side JSONB history + context-aware query rewrite

- **Status:** Proposed (2026-09-21, Sprint 4 — GW-16).
- **Deciders:** Vix Hawley (author), supervisor (approver).
- **Supersedes:** the Sprint 2 / Sprint 3 deferrals of GW-16 (recorded
  in sprint-log). Those deferrals named "needs multi-turn dataset"
  as the blocker; this ADR ships the memory infrastructure without
  the dataset, and records the dataset explicitly as a
  post-capstone follow-up.

## Context

Groundwork's API has been stateless per turn from Sprint 0 to
Sprint 4. Every `POST /api/answer` carried only the current query;
the router and synthesizer had no access to prior turns. This
worked for single-turn evaluation and matched the eval harness's
single-turn dataset — but it visibly breaks the customer UX the
moment a follow-up question uses a pronoun or comparative that
depends on the previous turn.

Concrete example observed 2026-09-21 in the deployed web app:

1. Customer: "Do you sell hemp bedding?"
   → Router classifies `product`, tool loop hits stock lookup,
   synthesizer answers with the Aubiose product card.
2. Customer: "do you have anything else similar"
   → Router classifies `out-of-scope`, safety gate abstains,
   customer sees "That's not something I can help with here."

The refusal is *technically correct given the router's inputs* —
the query text alone doesn't reference any product, delivery zone,
or shop-info topic. But it's a false refusal in customer terms:
they're asking a legitimate product question that any human shop
assistant would understand from context.

## Decision

Ship server-side conversation memory (GW-16) as a single-table
JSONB history plus a context-aware query rewrite step upstream of
the router. Five decisions below; each is chosen deliberately over
alternatives that are named and rejected.

### Decision 1 — State lives server-side, not client-carried

**Chosen:** a new `conversations` table in Supabase. The API loads
history at request start and appends turns at request end. The
client stores only the server-issued `conversation_id`.

**Rejected: client-carried history.** The client would send an
array of prior turns with every request; the server would stay
stateless. Simpler to build (~half the code), but three specific
problems:

- Client-side tampering. A hostile client could inject arbitrary
  "prior turns" claiming the shop already promised free delivery.
  Server-side state means the pipeline sees only turns the API
  actually produced.
- No cross-device continuation (theoretical; NFCS customers don't
  need this today, but it is table stakes for the shape).
- Traces cannot durably link back to a conversation without a
  server-owned id, which limits eval-side analysis of multi-turn
  regressions.

The extra Supabase read + write per turn is small (one row per
conversation, single index) and shares the SUPABASE creds already
in place for the trace sink. Cost delta is negligible next to the
LLM cost per turn.

### Decision 2 — Single-table shape, history as JSONB array

**Chosen:** one row per conversation. `history` is a JSONB array
of `{turn_id, role, text, created_at}`. Loading a conversation is
a single row read; appending a turn is a read-modify-write UPDATE.

**Rejected: two tables (conversations + conversation_turns) joined
on conversation_id.** More normalised, more queryable — but for
our access patterns (always "give me the whole conversation") the
join buys nothing and adds one write per turn. The precedent set
by ADR-0015 §Decision 1 (traces as a flat table with JSONB
`attributes`) applies directly: shape matches how the data is
read, not how it could theoretically be sliced.

### Decision 3 — Query rewrite happens BEFORE the router, not INSIDE it

**Chosen:** a new module `packages/adapters/src/router/context-
rewriter.ts` runs one LLM call (gpt-4o-mini) that rewrites the
current query using the last 4 turns of history. The output is a
self-contained query that the existing 6-class descriptive router
(ADR-0010) classifies as it always has. Router's public shape is
unchanged.

**Rejected: extend the router to take history and reason over it
directly.** The router is currently descriptive-only (ADR-0010
§"descriptive-only"), rules-first with an LLM fallback for the
long tail. Baking context awareness into it would either (a)
force every rule to know about history — brittle — or (b) push
every request through the LLM tail, losing the rules-first
latency win.

The rewrite step is opt-in: it fires only when history is
non-empty (turn 2+). For turn 1 the pipeline is identical to
pre-GW-16 behaviour, so no regression risk.

**Rejected: rewrite inside the synthesizer.** Too late — by then
the router has already classified as `out-of-scope`, the safety
gate has already abstained, and the synthesizer isn't invoked.

### Decision 4 — Best-effort persistence; a store failure never blocks the answer

**Chosen:** the request handler catches append failures with a
log-and-continue. The customer still gets their answer; the
conversation_id in the response still refers to the loaded
conversation. On the next turn the client retries with the same
id, and the store either succeeds (recovering) or drops the
missed turn from history (degrading, but not blocking).

**Rejected: fail the request on persistence failure.** Multi-turn
memory is a UX enhancement, not a correctness gate. A Supabase
blip that costs one turn's history is much less bad than a blip
that costs the whole answer. This matches ADR-0015's best-effort
trace contract.

### Decision 5 — Rewrite failures degrade to the original query

**Chosen:** on any error in the rewrite step (OpenAI 5xx, breaker
open, timeout, malformed response), the pipeline uses the
original query unchanged. The router's fallback behaviour is
already "descriptive-only classification of what's in front of
it" — if the rewrite couldn't add context, the router either
handles it fine (long, self-contained turn) or lands in the same
false-refusal state as pre-GW-16. Not worse than baseline.

**Rejected: retry the rewrite with exponential backoff.** Adds
latency to the customer-visible path for a hedged gain. The
existing openai breaker already handles cascading LLM failures
at the whole-request boundary (GW-23) — layering per-step retry
on top would double-count degradation signals.

## Consequences

### Wins

- Multi-turn follow-ups work. The specific case that motivated
  this ADR ("do you have anything else similar" after "hemp
  bedding") now routes correctly.
- Trace records link to `conversation_id`. Post-hoc analysis of
  a customer's whole session becomes a single query. Enables
  future post-capstone work on multi-turn eval slices.
- Router stays single-responsibility. ADR-0010's descriptive-only
  contract is not disturbed.
- Circuit breaker + graceful-escalate machinery reused. No new
  degradation surfaces.

### Costs and follow-ups

- **~200 tokens/turn on gpt-4o-mini** for the rewrite step (only
  fires turn 2+). Well below the synthesizer's per-turn cost.
- **Multi-turn eval dataset is still deferred.** GW-16's original
  companion story ("multi-turn eval dataset") remains a post-
  capstone item — this ADR ships the feature but not the metric
  that would catch regressions in it. Documented in
  project-board.md's roadmap. First-line defence: single-turn
  golden set continues to prevent regression on turn-1 behaviour.
- **Concurrency: last-write-wins on same-conversation appends.**
  A hostile or buggy client sending two overlapping requests to
  the same conversation_id can lose a turn. Mitigated by the web
  app's `pending` gate (one in-flight request per Chat instance);
  documented in the port contract for other consumers.
- **Retention policy not built.** Migration 005 has no rotation;
  conversations accumulate. Post-capstone follow-up (same policy
  discussion as traces retention — recorded there).
- **Rewrite is model-shaped, not rule-shaped.** The rewrite
  quality depends on gpt-4o-mini following the instruction. Prompt
  is versioned in `context-rewriter.ts`. If the rewrite fires when
  it shouldn't (a self-contained query gets "helpfully"
  paraphrased), the router's classification may drift. First-line
  defence: `response.rewritten_query` is surfaced on the response
  body so evals and the evidence panel show when a rewrite
  actually changed the text.

### Not addressed

- **History-aware safety-gate rules.** The safety gate today
  inspects only the current turn. A customer ramping up to a
  clinical question over multiple turns wouldn't be caught until
  the current turn crossed a threshold on its own. Naming this
  as a Sprint-4+ hardening story: history is available at the
  gate now (via the same `history` field on the pipeline), the
  rules just don't consult it yet.
- **Conversation summarisation.** Cap is `HISTORY_MESSAGES_MAX =
  10` and history is passed verbatim. Long conversations will
  eventually blow the synthesizer's token budget. Not a demo
  risk (typical shop conversations are 2-4 turns).

## Related decisions

- ADR-0010: intent router — the descriptive-only contract this
  ADR preserves.
- ADR-0015: trace persistence — the JSONB-shape and best-effort
  precedent this ADR follows.
- ADR-0014: tool-layer function-calling loop — the pipeline stage
  this ADR runs history through unchanged.
- Project-board: roadmap items for multi-turn eval dataset,
  retention rotation, and history-aware safety gate.
