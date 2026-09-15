# Sprint 1 demo

Per the handbook's "each sprint ends with a recorded demonstration to
the Product Owner" requirement. Product Owner is the solo builder in
this project (Vix); demo is a record of the sprint's shipped state,
not a client pitch. Five minutes, screen recording, no polish.

## Video link

**Recorded video:** `<TBC — record and paste the URL here>`

The `<TBC>` placeholder is intentional: it's quotable, so a stale
demo shows up in review rather than passing silently. Populate
before Sprint 2 opens.

## Script (target: 5 minutes)

Read this while recording. Skip any point that's already
self-evident on screen.

### 1. What Sprint 1 was about (30 s)

*"Sprint 1 was corpus in, dataset written, retrieval running,
baseline measured. The goal was for the design document to have
real numbers to take into Sprint 2 rather than projected ones. This
is a record of the shipped state, not a client pitch."*

### 2. The deployed URL (30 s)

Open `https://capstone-web-ten.vercel.app/api/health` in a browser
(or run `pnpm smoke` from the terminal).

*"Public health endpoint. This is the front door — Vercel deploy,
same-origin rewrite from the web app to the API, rate limiter
configured. Not the interesting bit of the sprint, but it's what
lands publicly."*

### 3. The corpus (60 s)

Open the Supabase dashboard to the `chunks` table. Show:

- Row count (~417).
- `content_type = 'product'` count vs `content_type = 'guide'` count.
- Pick a product row — show the composed chunk text, the
  `metadata` JSONB with `extracted_attributes`, and the populated
  `embedding` vector.

*"398 product chunks plus three guide files chunked into sections.
Every chunk has a text column ts_rank searches over, a metadata
JSONB with extracted attributes from gpt-4o-mini, and a 1536-dim
embedding for pgvector cosine. The embedding column being
populated is the correction that closed GW-01 mid-sprint — see the
sprint log for the story."*

### 4. The golden dataset (45 s)

Open `evals/datasets/sprint-1/cases.jsonl` (or a terminal running
`.venv/bin/python -c "from pathlib import Path; from groundwork_evals.schema import load_dataset; print(len(load_dataset(Path('evals/datasets/sprint-1/cases.jsonl'))))"`).

Show:

- 40 cases load, schema validation passes.
- Grep for `three-state-stock`, `superseded-source`, `substitute-offered`
  to show the tag distribution surfaced from real DMs.

*"40 cases. Six intents including service-referral which was
promoted from tag to intent when case 24 exposed a gap. Cases
carry cross-cutting tags for patterns the retrieval side has to
handle — three-state stock, source contradictions, superseded
policy, substitutes, trade shorthand."*

### 5. A retrieval query running (90 s)

Terminal:

```
pnpm retrieve
```

Wait 5–10 s for output to reach the headline table. Show the
terminal echo.

*"Four configurations. Dense-only, sparse-only, hybrid with two
fusion strategies, all with the noop reranker as the control.
94.4% recall at 10 on dense; sparse at 5.6% because
plainto_tsquery uses AND-semantics and returns empty for most
customer queries; hybrid ties dense because sparse is
returning nothing to fuse. The hybrid comparison hasn't actually
happened yet — that's deferred to Sprint 2 after sparse is
fixed."*

### 6. The baseline report (60 s)

Open `evals/results/sprint-1/retrieval-baseline.md` in a viewer.

Scroll through:

- Headline table.
- The "Hybrid vs dense — the comparison did not happen this sprint"
  caveat immediately after.
- Per-provenance slice (real 94.1%, boundary 100%).
- Per-intent slice (product 100%, logistics 90%, fit 100% on the
  one case with a source).
- Flagged cases table — dense hits case 007 in top-10 but not top-5.

*"This is the first row of a table that will run across four
sprints. Sprint 2 appends. The numbers are honest — dense-only
ships for Sprint 1, everything else is deferred with a specific
Sprint 2 work item behind it."*

### 7. What Sprint 2 inherits (30 s)

Open `docs/sprint-log.md` to the "What Sprint 2 inherits" list.

*"Nine items, priority-ordered. Fold embeddings into ingest first —
that prevents a re-run of the GW-01 gap. Then fix sparse. Then
rerun the baseline with a real hybrid comparison. Reranker spike
after that."*

### 8. Wrap (15 s)

*"Sprint log at docs/sprint-log.md, sprint-1 close-out section.
ADR-0001 addendum has the retrieval decision. ADR-0004 addendum
has the extractor outcome. Everything committed and pushed to
main."*

Stop recording. Paste the URL into the video-link section above.

## Why this exists

Per the sprint handbook, each sprint ends with a recorded
demonstration. On a solo project this is not a stakeholder pitch —
it's a diarised evidence artefact. Watching the demo months later
should give a viewer a five-minute answer to "what worked at the
end of Sprint 1", and prove the shipped state was real rather than
described.

The placeholder-URL discipline is the same one used in the
opening-hours guide: leave a quotable `<TBC>` rather than a
plausible-looking value that could sit stale.
