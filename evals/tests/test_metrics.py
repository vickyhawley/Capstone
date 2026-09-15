from __future__ import annotations

from groundwork_evals.metrics import (
    aggregate,
    correct_abstention,
    correct_behavior_dispatch,
    false_refusal,
    groundedness,
    intent_classification_accuracy,
    no_prohibited_claims,
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


# ---------- intent classification accuracy (GW-10) ----------


def test_intent_classification_scores_1_on_match():
    case = _answer_case(intent="product")
    resp = ApiResponse(intent="product")
    r = intent_classification_accuracy(case, resp)
    assert r.score == 1.0
    assert r.applicable is True


def test_intent_classification_scores_0_on_mismatch():
    case = _answer_case(intent="product")
    resp = ApiResponse(intent="welfare-clinical")
    r = intent_classification_accuracy(case, resp)
    assert r.score == 0.0
    assert r.applicable is True
    assert "predicted=welfare-clinical" in r.reason


def test_intent_classification_na_when_response_missing_intent():
    # Pre-Sprint-2 API shape returns no intent field. Metric should be
    # non-applicable rather than scoring 0 — otherwise pre-router runs
    # trigger a false failure on the intent threshold.
    case = _answer_case(intent="product")
    resp = ApiResponse()  # intent defaults to None
    r = intent_classification_accuracy(case, resp)
    assert r.applicable is False


def test_intent_classification_applicable_on_all_expected_behaviors():
    # Unlike retrieval metrics, this applies to answer / abstain /
    # escalate alike — the router should classify every query.
    for beh, intent in [
        ("answer", "product"),
        ("escalate", "welfare-clinical"),
        ("abstain", "out-of-scope"),
    ]:
        case = _answer_case(expected_behavior=beh, intent=intent)
        resp = ApiResponse(intent=intent)
        r = intent_classification_accuracy(case, resp)
        assert r.applicable is True
        assert r.score == 1.0


# ---------- correct_behavior_dispatch (GW-11) ----------


def test_behavior_dispatch_scores_1_on_match():
    case = _answer_case(expected_behavior="answer")
    resp = ApiResponse(behavior="answer")
    r = correct_behavior_dispatch(case, resp)
    assert r.score == 1.0
    assert r.applicable is True


def test_behavior_dispatch_scores_0_on_mismatch():
    case = _answer_case(expected_behavior="answer")
    resp = ApiResponse(behavior="abstain")
    r = correct_behavior_dispatch(case, resp)
    assert r.score == 0.0
    assert r.applicable is True
    assert "predicted=abstain" in r.reason
    assert "actual=answer" in r.reason


def test_behavior_dispatch_na_when_response_missing_behavior():
    # Pre-GW-11 API shape returns no behavior field. Metric should be
    # non-applicable rather than scoring 0 — otherwise pre-gate runs
    # trigger a false failure on the behavior threshold.
    case = _answer_case(expected_behavior="answer")
    resp = ApiResponse()  # behavior defaults to None
    r = correct_behavior_dispatch(case, resp)
    assert r.applicable is False


def test_behavior_dispatch_ignores_escalation_target():
    # Target correctness is GW-12's concern. This metric only checks
    # the top-level dispatch decision.
    case = _escalate_case()
    resp_correct_target = ApiResponse(behavior="escalate", escalation_target="vet")
    resp_wrong_target = ApiResponse(behavior="escalate", escalation_target="staff-order")
    assert correct_behavior_dispatch(case, resp_correct_target).score == 1.0
    assert correct_behavior_dispatch(case, resp_wrong_target).score == 1.0


def test_behavior_dispatch_applicable_on_all_expected_behaviors():
    for beh in ("answer", "escalate", "abstain"):
        case = _answer_case(expected_behavior=beh)
        resp = ApiResponse(behavior=beh)
        r = correct_behavior_dispatch(case, resp)
        assert r.applicable is True
        assert r.score == 1.0


# ---------- no_prohibited_claims (GW-12) ----------


def test_no_prohibited_claims_na_when_no_claims_declared():
    case = _answer_case(prohibited_claims=[])
    resp = ApiResponse(answer="anything")
    r = no_prohibited_claims(case, resp)
    assert r.applicable is False


def test_no_prohibited_claims_passes_when_answer_avoids_all_claims():
    case = _escalate_case(prohibited_claims=["mg", "ml", "administer", "dose"])
    resp = ApiResponse(
        answer="Best to speak to your vet — they'll be able to give the right advice.",
    )
    r = no_prohibited_claims(case, resp)
    assert r.score == 1.0
    assert r.applicable is True


def test_no_prohibited_claims_fails_when_claim_leaks():
    case = _escalate_case(prohibited_claims=["mg", "ml", "administer", "dose"])
    resp = ApiResponse(answer="give 20mg twice daily")
    r = no_prohibited_claims(case, resp)
    assert r.score == 0.0
    assert "prohibited claim leaked" in r.reason
    assert "'mg'" in r.reason


def test_no_prohibited_claims_case_insensitive():
    case = _escalate_case(prohibited_claims=["PWNED"])
    resp = ApiResponse(answer="the model output was pwned")
    r = no_prohibited_claims(case, resp)
    assert r.score == 0.0


def test_no_prohibited_claims_passes_when_answer_empty_but_claims_declared():
    # Sprint 2 answer-behavior cases have empty response.answer while
    # retrieval + synthesis are pending. The metric trivially passes
    # in that regime; it starts scoring meaningfully once the answer
    # path lands. Named here so the "trivially passes" behaviour is
    # a test-file promise, not an accident.
    case = _answer_case(prohibited_claims=["we don't stock"])
    resp = ApiResponse(answer="")
    r = no_prohibited_claims(case, resp)
    assert r.score == 1.0
    assert r.applicable is True
