"""Dataset and response schemas.

The dataset shape is JSONL; each line is one `EvalCase`. The API is
expected to accept `{query, conversation_id?}` at `POST /api/answer` and
return an `ApiResponse`-shaped body. The endpoint doesn't exist yet
(Sprint 1) — the harness handles a 404 gracefully so it can run against
a not-yet-implemented API and report cleanly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

Intent = Literal[
    "product",
    "fit",
    "logistics",
    "welfare-clinical",
    "out-of-scope",
    "service-referral",
]
ExpectedBehavior = Literal["answer", "abstain", "escalate"]


class EvalCase(BaseModel):
    """A single labelled case in an eval dataset.

    `tags` is an open-ended list for cross-cutting case categories
    that don't map to a single intent — e.g. `three-state-stock`
    (in-catalogue vs orderable vs unavailable) or `source-contradiction`
    (corpus contains disagreeing information). Captured but not
    sliced by the runner today; see evals/datasets/README.md §3.
    """

    id: str
    intent: Intent
    user_input: str
    expected_behavior: ExpectedBehavior
    required_source_ids: list[str] = Field(default_factory=list)
    prohibited_claims: list[str] = Field(default_factory=list)
    provenance: str
    tags: list[str] = Field(default_factory=list)

    model_config = {"extra": "forbid"}


class Citation(BaseModel):
    """A citation attached to an assistant answer."""

    chunk_id: str
    document_id: str | None = None

    model_config = {"extra": "ignore"}


class ApiResponse(BaseModel):
    """Shape the API is expected to return from POST /api/answer.

    `refusal_reason` non-null means the assistant declined to answer.
    `retrieved_chunk_ids` is the top-k retrieval result (before rerank if
    any) — needed for recall@k and retrieval_relevance metrics.
    """

    answer: str = ""
    citations: list[Citation] = Field(default_factory=list)
    retrieved_chunk_ids: list[str] = Field(default_factory=list)
    refusal_reason: str | None = None
    trace_id: str | None = None

    model_config = {"extra": "ignore"}


class DatasetError(Exception):
    """Raised when a JSONL dataset can't be loaded or validated."""


def load_dataset(path: Path) -> list[EvalCase]:
    """Read a JSONL file and validate each line against `EvalCase`.

    Raises `DatasetError` with a specific line number on any failure so
    the operator can find the bad case immediately.
    """
    if not path.exists():
        raise DatasetError(f"Dataset not found: {path}")

    cases: list[EvalCase] = []
    seen_ids: set[str] = set()
    with path.open("r", encoding="utf-8") as f:
        for lineno, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as e:
                raise DatasetError(f"{path}:{lineno}: invalid JSON — {e.msg}") from e
            try:
                case = EvalCase(**payload)
            except ValidationError as e:
                raise DatasetError(f"{path}:{lineno}: schema validation failed — {e}") from e
            if case.id in seen_ids:
                raise DatasetError(f"{path}:{lineno}: duplicate case id '{case.id}'")
            seen_ids.add(case.id)
            cases.append(case)

    if not cases:
        raise DatasetError(f"{path}: no cases in dataset")
    return cases
