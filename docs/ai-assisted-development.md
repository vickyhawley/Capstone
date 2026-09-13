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
