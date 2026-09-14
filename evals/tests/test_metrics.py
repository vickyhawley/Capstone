from __future__ import annotations

from groundwork_evals.metrics import (
    aggregate,
    correct_abstention,
    false_refusal,
    groundedness,
    recall_at_k,
    retrieval_relevance,
)
from groundwork_evals.schema import ApiResponse, Citation, EvalCase


def _answer_case(**overrides) -> EvalCase:
    base = dict(
        id="c1",
        intent="product",
        user_input="q",
        expected_behavior="answer",
        required_source_ids=["chunk-1", "chunk-2"],
        prohibited_claims=[],
        provenance="test",
    )
    base.update(overrides)
    return EvalCase(**base)


def _escalate_case(**overrides) -> EvalCase:
    base = dict(
        id="c2",
        intent="welfare-clinical",
        user_input="q",
        expected_behavior="escalate",
        required_source_ids=[],
        prohibited_claims=[],
        provenance="test",
    )
    base.update(overrides)
    return EvalCase(**base)


# ---------- groundedness ----------


def test_groundedness_scores_citation_overlap():
    case = _answer_case()
    resp = ApiResponse(
        answer="ok",
        citations=[Citation(chunk_id="chunk-1"), Citation(chunk_id="chunk-2")],
    )
    r = groundedness(case, resp)
    assert r.score == 1.0
    assert r.applicable is True


def test_groundedness_partial_overlap():
    case = _answer_case()
    resp = ApiResponse(
        answer="ok",
        citations=[Citation(chunk_id="chunk-1"), Citation(chunk_id="off-topic")],
    )
    r = groundedness(case, resp)
    assert r.score == 0.5


def test_groundedness_answered_without_citations_scores_zero():
    r = groundedness(_answer_case(), ApiResponse(answer="Some answer", citations=[]))
    assert r.score == 0.0
    assert "without any citations" in r.reason


def test_groundedness_refusal_scores_zero():
    r = groundedness(_answer_case(), ApiResponse(answer="", refusal_reason="clinical"))
    assert r.score == 0.0


def test_groundedness_prohibited_claim_present_scores_zero():
    case = _answer_case(prohibited_claims=["diagnose"])
    resp = ApiResponse(answer="You should diagnose the lameness", citations=[Citation(chunk_id="chunk-1")])
    r = groundedness(case, resp)
    assert r.score == 0.0
    assert "prohibited claim" in r.reason


def test_groundedness_prohibited_claim_uses_word_boundary_not_substring():
    # "mg" is a common dosing unit in clinical answers we want to catch.
    # It must NOT trip on the "mg" inside "smug", "smugly", "amgen", etc.
    case = _answer_case(prohibited_claims=["mg"])
    resp = ApiResponse(
        answer="he looked smug about the fit",
        citations=[Citation(chunk_id="chunk-1")],
    )
    r = groundedness(case, resp)
    # No boundary match — the case should score on citations, not fail.
    assert r.score > 0.0

    # A genuine dosing mention still trips it.
    resp_bad = ApiResponse(
        answer="give 5 mg of the anti-inflammatory",
        citations=[Citation(chunk_id="chunk-1")],
    )
    r_bad = groundedness(case, resp_bad)
    assert r_bad.score == 0.0
    assert "prohibited claim" in r_bad.reason


def test_groundedness_prohibited_claim_matches_case_insensitively():
    case = _answer_case(prohibited_claims=["diagnose"])
    resp = ApiResponse(
        answer="I would Diagnose this as laminitis",
        citations=[Citation(chunk_id="chunk-1")],
    )
    r = groundedness(case, resp)
    assert r.score == 0.0


def test_groundedness_not_applicable_for_escalate():
    r = groundedness(_escalate_case(), ApiResponse(refusal_reason="clinical"))
    assert r.applicable is False


# ---------- retrieval_relevance ----------


def test_retrieval_relevance_perfect_top_k():
    case = _answer_case(required_source_ids=["a", "b"])
    resp = ApiResponse(retrieved_chunk_ids=["a", "b", "c"])
    r = retrieval_relevance(case, resp, k=3)
    assert r.score == 1.0


def test_retrieval_relevance_missing():
    case = _answer_case(required_source_ids=["a"])
    resp = ApiResponse(retrieved_chunk_ids=["b", "c", "d"])
    r = retrieval_relevance(case, resp, k=3)
    assert r.score == 0.0


def test_retrieval_relevance_rank_penalises_deep_hits():
    case = _answer_case(required_source_ids=["a"])
    top_ranked = retrieval_relevance(case, ApiResponse(retrieved_chunk_ids=["a", "b", "c"]), k=3)
    deep_ranked = retrieval_relevance(case, ApiResponse(retrieved_chunk_ids=["b", "c", "a"]), k=3)
    assert top_ranked.score > deep_ranked.score > 0


def test_retrieval_relevance_not_applicable_when_no_required():
    r = retrieval_relevance(_answer_case(required_source_ids=[]), ApiResponse(retrieved_chunk_ids=["a"]))
    assert r.applicable is False


# ---------- recall_at_k ----------


def test_recall_at_k_hits_all():
    case = _answer_case(required_source_ids=["a", "b"])
    resp = ApiResponse(retrieved_chunk_ids=["a", "b", "c"])
    r = recall_at_k(case, resp, k=10)
    assert r.score == 1.0


def test_recall_at_k_partial():
    case = _answer_case(required_source_ids=["a", "b"])
    resp = ApiResponse(retrieved_chunk_ids=["a", "c"])
    r = recall_at_k(case, resp, k=10)
    assert r.score == 0.5


def test_recall_at_k_truncates_at_k():
    case = _answer_case(required_source_ids=["a"])
    resp = ApiResponse(retrieved_chunk_ids=["b", "c", "d", "e", "a"])
    r = recall_at_k(case, resp, k=3)
    assert r.score == 0.0


# ---------- correct_abstention ----------


def test_correct_abstention_on_refused_escalate():
    r = correct_abstention(_escalate_case(), ApiResponse(refusal_reason="clinical"))
    assert r.score == 1.0


def test_correct_abstention_on_answered_escalate():
    r = correct_abstention(_escalate_case(), ApiResponse(answer="Give bute", refusal_reason=None))
    assert r.score == 0.0


def test_correct_abstention_not_applicable_for_answer_case():
    r = correct_abstention(_answer_case(), ApiResponse(answer="ok"))
    assert r.applicable is False


# ---------- false_refusal ----------


def test_false_refusal_when_should_have_answered():
    r = false_refusal(_answer_case(), ApiResponse(refusal_reason="clinical"))
    assert r.score == 1.0


def test_false_refusal_when_answered_correctly():
    r = false_refusal(_answer_case(), ApiResponse(answer="ok"))
    assert r.score == 0.0


def test_false_refusal_not_applicable_for_escalate():
    r = false_refusal(_escalate_case(), ApiResponse(refusal_reason="clinical"))
    assert r.applicable is False


# ---------- aggregate ----------


def test_aggregate_ignores_non_applicable():
    from groundwork_evals.metrics import MetricResult

    per_case = {
        "groundedness": [
            MetricResult(1.0, "ok"),
            MetricResult(0.0, "n/a", applicable=False),
            MetricResult(0.5, "half"),
        ],
        "false_refusal": [MetricResult(0.0, "ok")],
        "retrieval_relevance": [MetricResult(0.8, "ok")],
        "recall_at_k": [MetricResult(1.0, "ok")],
        "correct_abstention": [MetricResult(0.0, "n/a", applicable=False)],
    }
    aggs = aggregate(per_case)
    assert aggs["groundedness"].score == 0.75
    assert aggs["groundedness"].n_applicable == 2
    assert aggs["groundedness"].n_total == 3
    assert aggs["correct_abstention"].n_applicable == 0
    assert aggs["false_refusal"].higher_is_better is False
