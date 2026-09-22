# AI tooling

The AI Engineering Project brief asks for a brief description of the
AI code tools used and how — what worked well, what didn't. The full
running record is in
**[`docs/ai-assisted-development.md`](docs/ai-assisted-development.md)**,
which logs every session where AI tooling contributed non-trivial
code, prompt shape, or an architectural choice. This file is the
grader-facing summary.

## Tools used

- **Claude Code (Opus 4.7)** — primary code-generation tool.
  Used across all four sprints for scaffolding, ports/adapters
  implementation, ADR drafting, test authoring, and debugging.
  Ran in the terminal against the local checkout; every diff
  reviewed by hand before commit.
- **Cursor (occasional)** — editor-side inline completions during
  focused refactors. Small scope; not used for architectural work.
- **OpenAI API (in the app itself)** — the running application uses
  `gpt-4o-mini` for intent classification, context rewriting, and
  answer synthesis, and `text-embedding-3-small` for retrieval.
  These are runtime dependencies, not build-time tools.

## What worked well

- **ADR-first workflow.** Writing the ADR (or at least the ADR
  skeleton — decision, alternatives, tradeoffs) before the code
  forced trade-off thinking earlier. Claude was good at
  brainstorming rejected alternatives to name in the ADR, which
  matters because "why not the obvious other choice" is often the
  most useful thing an ADR captures.
- **Port + stub-adapter scaffolding.** Ports/adapters is a repetitive
  pattern (port definition, stub adapter, real adapter, tests for
  each). AI handled the boilerplate cleanly and left me to focus on
  the port contract shape and the real adapter's non-obvious paths.
- **Test-first for tool-loop and safety-gate behaviour.** Where
  behaviour was easy to enumerate (e.g. the safety-gate's 6
  intent-to-behaviour rules), Claude generated exhaustive test
  matrices that would have been tedious to write by hand. All
  reviewed against the ADR to catch subtle rule mis-mapping.
- **Sprint log discipline.** Getting the AI to draft the "honest
  gaps" section forced me to actually enumerate them, rather than
  quietly hoping nobody would notice. Several times the drafted
  list caught something I'd forgotten to mention.

## What didn't work

- **Composition-root wiring.** The AI happily built ports, adapters,
  and per-adapter tests, and just as happily left a gap at
  `apps/api/src/server.ts` where the lazy-dep proxy shim needed
  updating whenever `defaultAnswerDeps()` gained a new dep. Caught
  the class of bug twice; the second time (GW-16 conversation
  memory) it shipped to production for a few minutes before the
  first live test surfaced it. Sprint-log entry names it as a
  "diff, don't just test" gap. Lesson: unit tests can't catch
  composition-root regressions; add smoke tests that boot the real
  dep graph.
- **Prompt hygiene drift.** Early synthesizer drafts interpolated
  user input into the system prompt via template literals. Caught
  in review before shipping. Rule: user input goes in the `user`
  role message, never in the `system` role. AI now knows this
  because the CLAUDE.md file names it, but if you don't call it
  out up front it will drift back.
- **Over-eager error handling.** Claude will default to wrapping
  every I/O call in try/catch that silently swallows the error.
  This looks safe and is actually the opposite — you lose the
  signal that something is broken. Replaced most of these with
  the explicit CircuitBreaker + structured `ToolResult.ok = false`
  pattern.
- **Fabricated version numbers.** Early ADR drafts cited pgvector
  and Hono versions that were plausible but wrong. Now every
  dependency version is verified against upstream docs and pinned
  in `THIRD-PARTY.md` before it lands in an ADR.

## Rules I applied

Kept in `~/.claude/CLAUDE.md` (personal) and referenced in
`docs/ai-assisted-development.md` (project):

1. AI output is a draft, never the delivered artefact. Every line
   read before commit.
2. Refusal, safety, and eval behaviour is authored by hand. AI can
   draft test fixtures but never label them.
3. Facts (versions, APIs, quotas) are verified against primary
   sources, not model output.
4. Composition-root wiring gets a manual smoke test, not just
   unit-test coverage.
