# ADR-0014 — Tool layer: function-calling loop, bounded iterations, three-tier "must call tool"

- **Status:** Proposed (2026-09-16, Sprint 3 planning — this ADR
  precedes the GW-18 implementation. Same discipline as ADR-0010
  preceded GW-10.)
- **Deciders:** Vix Hawley (author), supervisor (approver).
- **Related stories:** GW-18 (this ADR — tool port + function-
  calling loop), GW-20/21/22 (individual tools plugged into the
  loop), GW-24 (model tiering — planner vs synthesis), GW-25
  (trace logging — the loop's dispatch hooks are where traces are
  emitted), GW-26 (circuit breaker + degradation ladder — wraps
  the loop's execution).
- **Related ADRs:** ADR-0002 (iteration bound must be reachable
  before wall-clock timeout — the loop's termination contract),
  ADR-0010 (intent router — the loop's entry decision is
  intent-driven), ADR-0011 (safety gate — the loop only runs
  when the gate emits `answer`), ADR-0013 (deterministic chunk
  IDs — precondition, so any chunk IDs the tool loop stores in
  traces are durable).
- **Related README:** the "deterministic facts (stock, sizing,
  delivery zones) come from tools. The model never answers them
  from its own knowledge" rule (§Non-negotiable rules) is the
  load-bearing claim this ADR builds infrastructure to keep.

## Context

Sprint 2 shipped the boundary layer — router, safety gate,
escalation copy, disclosure. On `answer`-behaviour turns, the API
still returns empty (`answer: ""`) because there is no retrieval
+ synthesis path yet. Sprint 3's tool layer is that path.

The pieces already exist as stubs:

- `packages/core/src/ports/tool-registry.ts` — `ToolDefinition`,
  `ToolInvocation`, `ToolResult` types. Since Sprint 0. `invoke`
  has been throwing `NotImplementedError`.
- `apps/api/src/limits.ts` — `MAX_ITERATIONS = 8`,
  `TIME_BUDGET_MS = 25_000`. ADR-0002 sized both.
- `packages/core/src/ports/trace-sink.ts` — `TraceSink` port
  ready for GW-25 to persist to.

GW-18 is the piece that makes them work together: an actual
function-calling loop that (a) asks the model to plan, (b) invokes
tools it names, (c) feeds results back, (d) terminates cleanly at
the iteration bound or a "no more tools needed" signal, whichever
comes first — and always before the wall-clock timeout.

## What this ADR decides

1. **A single per-turn loop with a bounded-iterations termination
   contract** matching ADR-0002. Iteration bound (`MAX_ITERATIONS
   = 8`) is the primary termination signal. Time budget
   (`TIME_BUDGET_MS = 25_000`) is the backstop for a stuck
   iteration. The loop never enters iteration N+1 if it has < N ×
   (avg-iteration-cost) time budget remaining — the check is
   before-entry, so no torn boundary.

2. **Structured errors returned to the model, not exceptions
   thrown.** A tool failure becomes a `ToolResult { ok: false,
   error, retryable }` fed back into the loop as the model's next
   context. The model can then recover, retry, or escalate. The
   loop only *itself* throws on infrastructure failure (LLM API
   down, trace sink write failed) — never on tool-level failure.

3. **Tracing is native, not retrofit.** Every tool invocation
   emits a trace row *before* the tool runs (with args) and
   another *after* (with result + duration). GW-25 persists these.
   Retrofitting tracing later means either instrumenting every
   tool or wrapping every invocation site, both of which are
   avoidable if tracing hooks are baked into the loop from day
   one.

4. **"Must call a tool for stock / sizing / delivery-zone claims"
   is enforced in three tiers, not by prompt discipline alone.**
   Tier 1 (structural): route-based dispatch on router intent
   plus entity extraction, where the tool result is the response's
   only substrate. Tier 2 (structural fallback): tool runs before
   the model turn for cases the route can't reduce; model gets
   the result as context. Tier 3 (monitoring): a
   `tool_backed_claim` metric flags cases where the response
   contains a stock / price / delivery claim without a matching
   tool call in the trace. Prompt discipline is the residual
   layer, not the primary defence. Full structural enforcement
   is not achievable — this ADR states that plainly and names
   what to measure.

## What this ADR does not decide

- **The specific tools.** GW-20 (stock lookup), GW-21 (fit/sizing),
  GW-22 (delivery-zone) each get their own definition of args +
  return shape. This ADR is the port and the loop.
- **Model tiering.** GW-24 owns the planner-vs-synthesis model
  split. This ADR assumes the loop calls "the model" — which
  model is a downstream concern.
- **Circuit breaker / degradation ladder.** GW-26 wraps this loop
  and handles cascading tool failures. This ADR defines what a
  clean tool-level failure looks like; GW-26 defines what happens
  when many tool-level failures happen at once.
- **The synthesis prompt.** Once the loop terminates with a set
  of tool results + retrieved chunks, a downstream synthesis
  step (not this ADR) composes the customer-facing answer.

## The loop

### Shape

```
route_result = safety_gate(router.route(query))
if route_result.kind != 'answer': return early with copy
                                   (per ADR-0011)

# Enter the tool loop
context = { query, router_decision, retrieved_chunks: [], tool_results: [] }
for iteration in 0 .. MAX_ITERATIONS:
  if remaining_budget_ms < iteration_cost_estimate(iteration):
    log 'iteration bound reached before budget exhausted' and break
  
  plan = planner_model.plan(context)   # returns either tool_call OR done
  if plan.kind == 'done':
    break
  
  trace.emit('tool.invocation.start', { name, args, iteration })
  result = tool_registry.invoke(plan.tool_call, signal)
  trace.emit('tool.invocation.end', { name, result, duration_ms })
  context.tool_results.append(result)

# Synthesis is a separate step, not part of this loop.
answer = synthesizer.compose(context)
```

The loop's job is *only* to gather tool results. Answer synthesis
is a separate downstream step. This split keeps each piece
testable in isolation: the loop is testable with a stub planner
and stub tools; synthesis is testable with a fixed context.

### Termination

Three termination signals, evaluated in this order every
iteration:

1. **Iteration bound reached** (`iteration == MAX_ITERATIONS`).
   Clean boundary. Loop returns with whatever tool results it
   has; synthesis composes from those. Trace records
   `terminated: 'iteration-bound'`.
2. **Budget-aware early exit** (`remaining_budget_ms <
   iteration_cost_estimate`). Clean boundary. Same as above but
   trace records `terminated: 'budget-aware'`. This is the
   ADR-0002 promise made concrete — the loop doesn't try to fit
   in an iteration it can't afford.
3. **Planner says done** (`plan.kind == 'done'`). Clean
   boundary. Trace records `terminated: 'planner-done'`.

The AbortSignal from `TIME_BUDGET_MS` is a **backstop for a
single iteration hanging**, not the loop's primary termination.
If an iteration itself hangs past its estimated cost, the signal
fires mid-step and the loop returns with what it has and
`terminated: 'timeout-backstop'`. This is the "torn boundary"
ADR-0002 warned about; it should be rare because the pre-entry
budget check prevents starting an iteration that won't fit.

`iteration_cost_estimate(iteration)` is a running average of past
iteration durations, with a floor (e.g. 2s) for the first
iteration. Not perfect but good enough — the point is to prevent
starting iteration 8 when 3 seconds remain, not to model the
planner precisely.

### Error handling

Every `tool_registry.invoke` returns `ToolResult`, which is
either `{ ok: true, value }` or `{ ok: false, error, retryable }`.
The loop:

- **`ok: true`** → append to `context.tool_results`, continue.
- **`ok: false, retryable: true`** → append to `context.tool_results`
  (so the model knows what failed), continue. Model can decide to
  retry (its next `plan` may re-invoke) or work around.
- **`ok: false, retryable: false`** → append, continue. Model
  cannot retry usefully; it must adjust the plan or escalate.

The loop never itself decides to retry. Retry semantics are
model-driven — same reason as ADR-0011's "safety gate signals,
synthesis enforces": the layer that has the context to make the
right retry decision is the layer that gets it, not a generic
retry-N-times wrapper.

Infrastructure failures (LLM API 5xx, trace sink write failed,
network partition) are exceptions and DO throw. GW-26 catches
them at the request boundary and returns a graceful degradation
response. This ADR draws the line: tool-level failures are model
context; infra failures are exceptions.

## The hard part — "must call a tool" enforcement

The README's non-negotiable rule: *"Deterministic facts (stock,
sizing, delivery zones) come from tools. The model never answers
them from its own knowledge."* This ADR is where that rule
becomes implementable — or fails to.

**Structural enforcement is possible for a subset. It is not
achievable via prompt alone.** Named plainly so no downstream
document overclaims.

### Tier 1 — route-based structural enforcement (strongest)

For queries where the router's intent + a lightweight entity
extraction resolves to a specific tool call, dispatch bypasses
the general planner loop. The model doesn't get to *choose*
whether to call the tool — the route commits.

Concretely, when the router emits:

- `intent: product, product_handle: X` (extracted from the
  query) → stock lookup on handle X runs deterministically;
  synthesis takes the tool result as its only substrate for
  "do we stock X" claims.
- `intent: logistics, postcode: Y` (extracted) → delivery-zone
  check on Y runs deterministically; synthesis takes the tool
  result as its only substrate for "do we deliver to Y" claims.

Entity extraction is a small addition to the router (GW-10's
LLM classifier already produces a rationale; extraction is one
more field). The extraction is trusted only when high-confidence
— low-confidence falls to Tier 2.

**What this covers:** the golden set's product-intent + stock
questions (cases 001, 003, 004, 005, 007, 008, 010, 021, 022,
023, 041, 042, 044, 045, 046) and logistics-intent + delivery-
postcode questions (031). ~15 of 49 cases.

**What this does NOT cover:** questions where the entity is
ambiguous or absent, compound questions ("do you deliver AND
what's the price"), fit questions where the "which product?"
part is what the model has to plan for.

### Tier 2 — tool-first for cases the route can't reduce

For cases in scope but not reducible to a single tool call, the
model still can't invent facts because the tool runs BEFORE the
model turn. The loop's first step for these cases is a mandatory
tool call driven by intent (retrieval for product/fit/logistics
intents). The model gets the retrieval result as its opening
context. It can then decide to call further tools, but it can't
answer without any tool having run.

The distinction from Tier 1: Tier 1 makes the answer's substrate
*only* the tool result; Tier 2 makes the substrate *include* a
tool result. Tier 2 is weaker because the model can still
paraphrase from its own priors if the retrieval result doesn't
directly cover the question — but it cannot make a factual
claim about stock/price/delivery from thin air, because
retrieval or the deterministic tool has established the ground.

**What this covers:** the residual answer-behaviour cases —
compound questions, general fit guidance, product questions
where entity extraction failed.

**What this does NOT cover:** the model synthesising a stock
claim from a retrieval result that didn't include stock data.
That's a synthesis-layer discipline (the prompt tells the model
what claims it can make from what data); this ADR can't enforce
it at the loop layer.

### Tier 3 — monitored residual

For everything Tier 1 + Tier 2 don't cover structurally, add a
new metric to the harness:

**`tool_backed_claim`.** For every response containing a
stock / price / delivery-zone claim (detected by keyword match
against a small list per claim class — "in stock", "£", "we
deliver to", etc.), verify a matching tool call is in the trace.
If not, score 0 (failure). Applicable iff the response text
contains a claim of the tracked shape.

This is *signal, not enforcement*. It catches when instruction-
following fails so we can iterate on the prompt or promote a
case class from Tier 3 to Tier 2. It doesn't prevent the failure.

**What to threshold at:** starts descriptive — measure baseline,
then gate at whatever level Sprint 3 delivers. Same discipline
as ADR-0011's `correct_behavior_dispatch` threshold sizing.

### The honest limits

- **Tier 1 requires reliable entity extraction.** If a customer
  says *"do you sell those cubes I used before"*, the entity
  extraction fails, the case falls to Tier 2, and the model has
  to work with retrieval only. Recorded here so Tier 1's
  coverage isn't overclaimed.
- **Tier 2 doesn't stop paraphrase-from-priors.** A retrieval
  result mentioning "20-mile radius" leaves the model free to
  invent "you're at 25 miles so no" — the retrieval result
  established the radius but doesn't establish the customer's
  distance. Synthesis prompt discipline (Sprint 3 downstream
  story) is the layer that constrains this.
- **Tier 3 detects but doesn't prevent.** A `tool_backed_claim`
  = 0 case has already failed by the time the metric fires. This
  is by design — structural enforcement covers what it can, and
  the residual is a signal for iteration, not a hard block.

## Placement in the pipeline

```
POST /api/answer
  │
  ▼
  Router (ADR-0010)  →  intent + adversarial signal + [entity extraction (Tier 1)]
  │
  ▼
  Safety gate (ADR-0011)  →  Behaviour
  │
  ├── behaviour = abstain     →  copy (GW-12), done
  ├── behaviour = escalate    →  copy (GW-12), done
  └── behaviour = answer
         │
         ▼
         Tool loop (THIS ADR)
           │
           ├── Tier 1 route matched  →  deterministic tool call,
           │                            skip planner, tool result IS answer substrate
           ├── Tier 1 route missed   →  Tier 2 tool-first, then planner loop
           │
           ▼
         Context { retrieved, tool_results, terminated_because }
         │
         ▼
         Synthesis (Sprint 3+ downstream story)
         │
         ▼
         Response { answer, citations, tool_backed_claims_verified: bool }
```

The loop sits between the safety gate and synthesis. It doesn't
own retrieval (retrieval is a tool in GW-20 / GW-22) and it
doesn't own answer composition (synthesis does).

## Evaluation

### API surface change (proposed)

`ApiResponse` gains a Sprint 3 field:

```py
tool_calls: list[ToolCall] = Field(default_factory=list)
```

Where `ToolCall` is `{ name, args, ok, duration_ms }`. Populated
by the trace hook; empty for Sprint 2-shape responses (before
GW-18 lands). Same optional-so-old-responses-validate pattern as
`behavior` / `intent` fields.

### New metric — `tool_backed_claim` (GW-18 ships alongside)

Per-case: 1.0 iff response.answer's stock/price/delivery claims
are backed by a matching tool call in `response.tool_calls`; 0.0
otherwise. Applicable iff response.answer contains a tracked
claim shape.

Not applicable to abstain / escalate cases (they don't make
factual claims). Not applicable to answer cases that don't
touch stock/price/delivery (e.g. general opening-hours question
answered from the policy guide alone).

### Threshold — descriptive first

Sprint 3 measures the baseline; the threshold is set once we
know the number. Same discipline as ADR-0010's approach for
`intent_classification_accuracy` — measure first, threshold
second, avoid setting a threshold that fits the number.

The out-of-band promise is: `tool_backed_claim` on any case
where a stock claim is made without a stock tool call is a
critical safety failure, not a soft threshold. Sprint 3 close-
out states the observed number and either sets a floor (=1.00)
or names why the floor isn't achievable yet.

## Cases explicitly not solved

Named so they aren't hidden.

- **Cross-tool synthesis discipline.** If retrieval returns
  policy chunk A ("free delivery within 20 miles") and delivery-
  zone tool returns "customer is at 18 miles", the model has to
  compose "yes, free delivery to your area" from both. Nothing
  in this ADR ensures the model doesn't drop the tool result and
  invent a different answer. Synthesis prompt discipline
  (downstream) is where that's addressed.
- **Retry-loops from a model that keeps invoking the same
  failed tool.** The loop's iteration bound catches this
  eventually (at MAX_ITERATIONS), but between iteration 1 and
  iteration 8, the model may waste 7 iterations retrying a tool
  that will never succeed. GW-26's circuit breaker addresses
  cascading failures across turns; within a single turn, the
  iteration bound is the only defence. Recorded here so it's
  not surprising when GW-26 designs against it.
- **Compound-intent messages that need multiple Tier 1
  routes.** *"Do you sell haynets and what's your delivery to
  SO22"* would need both a stock lookup AND a delivery-zone
  check. The router emits one intent; the entity extraction
  emits one entity. Tier 1's "one route matches" contract
  doesn't handle compound. These fall to Tier 2 and the model
  plans multiple tool calls. Losing Tier 1's strongest
  guarantee for compound queries is a design cost of the
  route-based approach — the alternative (route to a
  multi-tool orchestrator) is Sprint 4+ if the problem shows
  up in the golden set.
- **Model deciding not to call a tool it should have.** Tier 3
  metric catches this AFTER the answer is composed. Nothing
  in Tiers 1-2 prevents a Tier 2 case from ending with the
  model saying "we deliver to SO22" without having called the
  delivery-zone tool. Prompt discipline + Tier 3 monitoring
  is the only defence for this case class.

## Reproducibility note

This is a design ADR; the implementation is GW-18's story. The
build follows the same pattern as GW-10:

1. **Descriptive-only classifier port** (already exists —
   `ToolRegistry` in core).
2. **Stub adapter** so tests can run without a live LLM
   (equivalent of `StubRouter`).
3. **Rules-first hybrid where possible** — Tier 1's route-based
   dispatch is the "rules" here; Tier 2's planner loop is the
   "LLM" equivalent.
4. **Descriptive metric first, threshold second** —
   `tool_backed_claim` measures, then Sprint 3 close-out sets
   the floor.

The build should show the same discipline: measure the baseline
against the golden set, name the misses, don't tune to fit the
threshold. Same as GW-10's shipped-baseline-before-tuning
pattern.
