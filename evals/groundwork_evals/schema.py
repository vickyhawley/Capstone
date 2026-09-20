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
Behavior = ExpectedBehavior  # alias — the API returns the same 3-value set
EscalationTarget = Literal["vet", "staff-service", "staff-order"]

# Four states (ADR-0016 §2, after the 2026-09-17 SME correction). The
# `three-state-stock` case tag pre-dates the fourth state and is kept
# stable per §1's "Never rename a case ID" rule — the tag name is a
# historical label for the case category; the field values below are
# the current source of truth on shape.
StockStatus = Literal["exact", "orderable", "pending", "unavailable"]

# GW-21 (2026-09-18) — two states per data/guides/delivery.md. There
# is no `confident_no`: the guide's "never refuse; route to staff"
# rule collapses out-of-radius and unknown-postcode into one honest
# state.
DeliveryZoneStatus = Literal["within_radius", "defer_to_staff"]


class EvalCase(BaseModel):
    """A single labelled case in an eval dataset.

    `tags` is an open-ended list for cross-cutting case categories
    that don't map to a single intent — e.g. `three-state-stock`
    (in-catalogue vs orderable vs pending vs unavailable) or
    `source-contradiction` (corpus contains disagreeing information).
    Captured but not sliced by the runner today; see
    evals/datasets/README.md §3.

    Product-intent fields (ADR-0016, added Sprint 3 Story 4):
    - `expected_stock_status` — one of four states. Consumed by the
      Story 4 smoke and by the metric that verifies the tool's
      decision. Optional so non-product cases and any product case
      whose shape is ambiguous (e.g. pending SME follow-up) can
      leave it null. Populated for every case whose shape is
      unambiguous.
    - `expected_product_query` — the entity the router is expected
      to extract for this case's user_input. Consumed by
      `product_query_extraction_accuracy` (ADR-0010 amendment 3 /
      ADR-0016 §4). Optional for the same reasons.
    """

    id: str
    intent: Intent
    user_input: str
    expected_behavior: ExpectedBehavior
    required_source_ids: list[str] = Field(default_factory=list)
    prohibited_claims: list[str] = Field(default_factory=list)
    provenance: str
    tags: list[str] = Field(default_factory=list)
    expected_stock_status: StockStatus | None = None
    expected_product_query: str | None = None
    # GW-19 field (ADR-0005 addendum 2026-09-18) — populated for cases
    # tagged `substitute-offered` or `price-tier-substitute` when the
    # SME can name a specific handle the shop's real answer would
    # recommend. Null when the case is unlabelled pending SME follow-
    # up; the substitute smoke skips those. Consumed by
    # `substitute_offered_correct`.
    expected_substitute_handle: str | None = None
    # GW-21 fields (2026-09-18) — populated for `logistics`-intent
    # cases whose expected shape is a delivery-zone check. Both
    # travel together: `expected_postcode` is what the tool is called
    # with; `expected_delivery_zone` is what it should return.
    # Consumed by `delivery_zone_correct`. Null on non-delivery cases.
    expected_postcode: str | None = None
    expected_delivery_zone: DeliveryZoneStatus | None = None

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

    Router fields (added Sprint 2, GW-10, per ADR-0010):
    - `intent` is the router's classification. Optional so pre-router
      Sprint 1 responses still validate; the Sprint 2 API always
      populates it.
    - `adversarial_suspected` is true iff a safety-signal rule fired
      on the query. Orthogonal to intent — a message can be
      `intent='fit', adversarial_suspected=True` when a legitimate
      query carries an injection payload (ADR-0010 amendment 1).
    - `adversarial_pattern` names the rule that fired, when
      applicable.

    Safety-gate fields (added Sprint 2, GW-11, per ADR-0011):
    - `behavior` is the safety gate's dispatch decision. Same 3-value
      set as `EvalCase.expected_behavior`. Optional so pre-gate
      responses still validate.
    - `escalation_target` is populated iff `behavior == 'escalate'`.
      Names the target audience for the escalation copy (GW-12).

    Router extraction field (added Sprint 3, GW-20, per ADR-0010
    amendment 3 and ADR-0016 §4):
    - `product_query` is the entity string the router extracted from
      the user's message for `intent == 'product'` cases. Optional
      — absent when the query is non-product, compound, or ambiguous,
      per the ADR-0010 amendment. Consumed by
      `product_query_extraction_accuracy`.
    """

    answer: str = ""
    citations: list[Citation] = Field(default_factory=list)
    retrieved_chunk_ids: list[str] = Field(default_factory=list)
    refusal_reason: str | None = None
    trace_id: str | None = None

    intent: Intent | None = None
    adversarial_suspected: bool = False
    adversarial_pattern: str | None = None

    behavior: Behavior | None = None
    escalation_target: EscalationTarget | None = None

    product_query: str | None = None
    # GW-19 field (ADR-0005 addendum 2026-09-18) — populated by the
    # tool loop when it dispatches `product.substitute_lookup`. Empty
    # list when no substitutes were returned (e.g. the tool short-
    # circuited on `stockStatus: 'exact'`) or when the tool didn't
    # run for this turn. Consumed by `substitute_offered_correct`.
    substitute_handles: list[str] = Field(default_factory=list)
    # GW-21 field (2026-09-18) — populated by the tool loop when it
    # dispatches `logistics.delivery_zone`. Consumed by
    # `delivery_zone_correct`.
    delivery_zone_status: DeliveryZoneStatus | None = None

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
