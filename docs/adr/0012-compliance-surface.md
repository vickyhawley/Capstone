# ADR-0012 — Compliance surface: Article 50 disclosure + capability profile

- **Status:** Proposed (2026-09-16, Sprint 2 — GW-15).
- **Deciders:** Vix Hawley (author), supervisor (approver).
- **Related stories:** GW-15 (this ADR).
- **Related ADRs:** ADR-0010 (intent router — its `INTENTS` label
  set is what the capability profile enumerates), ADR-0011 (safety
  gate — its `EscalationTarget` set is what the capability profile
  claims about escalation).
- **Related external:** EU AI Act Article 50 (transparency obligations
  for AI system providers where the interaction is not otherwise
  obvious to the user).

## Context

Two compliance-shaped requirements sit adjacent to the Sprint 2
boundary work and need a landing place:

1. **Article 50 disclosure.** The user must be told they are
   interacting with an AI, in a form appropriate to the interaction.
   For a text-only chat with an equestrian shop, the failure mode
   is a customer assuming they're chatting with staff and treating
   the response as a person's undertaking (e.g. taking a
   welfare-clinical answer as veterinary advice from the shop).
2. **Capability profile.** A specific statement of what this
   assistant is designed to do and what it deliberately refuses to
   do. Grader-facing and auditor-facing artefact. Its content must
   *match* what the system actually does — a profile that says
   "answers clinical questions" while the safety gate escalates them
   would be worse than no profile at all, because it would mis-set
   customer expectations that the gate would then contradict.

Sprint 2 has no chat UI yet (the web app is a scaffold shell —
health check + streaming smoke test only). So the disclosure has
no user surface to embed in *today*. This ADR is written knowing
that constraint: the artefacts have to be ready before the UI
lands, not ship dependent on it.

## What this ADR decides

1. **Content lives as typed constants in `packages/core/src/compliance/`,**
   not as markdown docs. Same pattern as GW-12's behaviour copy:
   pure module, type-safe, one source of truth. Documentation about
   *why* the copy says what it says lives here (in the ADR); the
   copy itself lives in the code so any consumer imports it rather
   than round-tripping through file reads.

2. **A single `/api/about` endpoint exposes both.** Machine-readable
   JSON. No auth, no rate limiting — it's public information the
   platform team, auditors, and the eventual UI all need. Not
   attached to `/api/answer` per-request because it doesn't change
   per turn and inflating every response with kilobytes of unchanging
   text is expensive.

3. **The capability profile enumerates against the `INTENTS` label
   set** (from ADR-0010 / `packages/core/src/ports/router.ts`). Each
   intent gets a one-sentence description of "what this bot does
   with a query of this intent." A test asserts every `INTENTS`
   value has a corresponding profile entry — so adding an intent
   without updating the profile fails a test, not a customer
   interaction.

4. **The "matched to system behaviour" rule is enforced by test,
   not by discipline.** Where testable — the intent list, the
   escalation targets — a unit test compares the profile against
   the runtime constant. Where not testable — tone, plain-English
   wording — the ADR names it as a review checkpoint.

5. **The disclosure text uses "an AI assistant" not "a person" or
   "a bot" or "our assistant".** Rationale: "AI assistant" is the
   term used in EU AI Act guidance and Ofcom's AI-content
   transparency guidance. "Bot" reads as dismissive; "our assistant"
   is ambiguous with a staff member. Any other phrasing needs a
   documented reason.

## What this ADR does not decide

- UI rendering of the disclosure. That is a UI-layer story
  (Sprint 3+ when a chat UI exists). The disclosure text has to
  appear before the first turn or in a persistent surface visible
  during interaction, but *how* is downstream of the UI's shape.
- Multi-language disclosure. The Sprint 1 golden dataset is
  English-only; the capability profile follows. Sprint 3+ if
  the shop asks for Welsh or another language.
- Auditor-facing evidence bundles. Beyond exposing `/api/about`,
  no evidence-collection surface exists. If the shop is audited,
  the exports come from git history, ADRs, and the eval results.

## Artefact shape

### `Disclosure`

A single string, one paragraph. States:

- The user is talking to an AI assistant, not shop staff.
- What the AI is based on (published NFCS policies and product
  catalogue — the corpus the retrieval layer indexes).
- What it will and will not do (see capability profile for detail).
- How to reach a person if needed.

The length target is one paragraph readable in under 10 seconds.
Longer disclosures are ignored; shorter ones don't cover the
required content.

### `CapabilityProfile`

Structured object:

```ts
{
  canDo: readonly string[];       // e.g. "answer questions about products we stock"
  cannotDo: readonly string[];    // e.g. "give clinical advice about your horse"
  escalatesTo: readonly {
    target: EscalationTarget;     // 'vet' | 'staff-service' | 'staff-order'
    for: string;                  // "welfare and clinical questions"
  }[];
  intents: readonly {
    name: Intent;                 // one of the six INTENTS values
    describes: string;            // one-sentence description
  }[];
}
```

Every `INTENTS` value must appear in `intents`. Every
`EscalationTarget` value must appear in `escalatesTo`. Both
enforced by test.

### `/api/about` endpoint

`GET /api/about` returns:

```json
{
  "disclosure": "You're chatting with an AI assistant...",
  "capability_profile": {
    "can_do": [...],
    "cannot_do": [...],
    "escalates_to": [...],
    "intents": [...]
  }
}
```

Snake_case at the API boundary, matching the existing Python-side
`ApiResponse` convention. Serves as-is from the constants; no
runtime computation.

## Placement in the pipeline

```
GET /api/about
  │
  ▼
  Returns { disclosure, capability_profile }  ← constants, no computation.

POST /api/answer  (unchanged)
  │
  ▼
  Router → Safety gate → response
```

The two endpoints are unrelated. `/api/answer` does not include
disclosure content per-response for the reasons in Decision 2.

## Cases this does NOT enforce

Named explicitly so they aren't hidden as ambient compliance
weaknesses.

- **A user who never reads the disclosure.** The disclosure being
  available is a *necessary* condition for Article 50 compliance;
  it is not *sufficient*. Whether the UI shows the disclosure at a
  moment the user is likely to read it is a UI-layer concern.
- **A user who reads the disclosure, forgets, then reads a
  welfare-clinical escalation as a person's undertaking.** The
  escalation copy itself (GW-12, ADR-0011) is written to route to
  a vet, not to make a clinical claim. The pair (disclosure +
  escalation copy) is the intended defence in depth.
- **Drift between the capability profile and system behaviour over
  time.** The `intents` and `escalatesTo` sections are locked to
  runtime constants by test. The `canDo`/`cannotDo` free-text
  sections are not. A future ADR that changes what the system does
  (e.g. adds a new escalation shape) has to update the profile
  too; this is a review discipline, not a mechanical guarantee.

## Reproducibility note

The disclosure text and capability profile in this sprint are
first drafts. Tone and phrasing may need adjustment when the shop
reviews. The mechanism (constants + endpoint + tests) is what this
story ships; the exact words are expected to change at least once
before any real customer sees them.
