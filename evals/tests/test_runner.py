from __future__ import annotations

import json
from pathlib import Path

import responses

from groundwork_evals.runner import parse_args, run


def _write_fixture_dataset(tmp_path: Path) -> Path:
    dataset = tmp_path / "d.jsonl"
    dataset.write_text(
        '{"id":"answer-1","intent":"product","user_input":"q","expected_behavior":"answer",'
        '"required_source_ids":["c1"],"prohibited_claims":[],"provenance":"real-customer — fixture"}\n'
        '{"id":"escalate-1","intent":"welfare-clinical","user_input":"q","expected_behavior":"escalate",'
        '"required_source_ids":[],"prohibited_claims":[],"provenance":"real-customer — fixture"}\n'
    )
    return dataset


def _write_thresholds(tmp_path: Path, thresholds: dict[str, float]) -> Path:
    p = tmp_path / "t.json"
    p.write_text(json.dumps(thresholds))
    return p


@responses.activate
def test_run_exits_zero_when_thresholds_met(tmp_path: Path) -> None:
    responses.post(
        "https://api.test/api/answer",
        json={
            "answer": "ok",
            "citations": [{"chunk_id": "c1"}],
            "retrieved_chunk_ids": ["c1"],
        },
        status=200,
    )
    # Second case (escalate) also hits this URL — return refusal.
    responses.post(
        "https://api.test/api/answer",
        json={"answer": "", "refusal_reason": "welfare-clinical"},
        status=200,
    )

    args = parse_args(
        [
            "--dataset",
            str(_write_fixture_dataset(tmp_path)),
            "--thresholds",
            str(_write_thresholds(tmp_path, {"false_refusal": 0.1})),
            "--sprint",
            "test",
            "--api-url",
            "https://api.test",
            "--results-dir",
            str(tmp_path / "results"),
        ]
    )
    code = run(args)
    assert code == 0
    # Results file was written
    files = list((tmp_path / "results" / "sprint-test").glob("*.json"))
    assert len(files) == 1
    body = json.loads(files[0].read_text())
    assert body["n_cases"] == 2
    assert body["breaches"] == []


@responses.activate
def test_run_exits_one_when_threshold_breached(tmp_path: Path) -> None:
    # Both cases return an answer even when they shouldn't → false refusal 0, but
    # groundedness is 0 because no citations → breach.
    responses.post("https://api.test/api/answer", json={"answer": "no citations"}, status=200)
    responses.post("https://api.test/api/answer", json={"answer": "no citations"}, status=200)

    args = parse_args(
        [
            "--dataset",
            str(_write_fixture_dataset(tmp_path)),
            "--thresholds",
            str(_write_thresholds(tmp_path, {"groundedness": 0.8})),
            "--sprint",
            "test",
            "--api-url",
            "https://api.test",
            "--results-dir",
            str(tmp_path / "results"),
        ]
    )
    code = run(args)
    assert code == 1


def test_run_exits_two_on_missing_dataset(tmp_path: Path) -> None:
    args = parse_args(
        [
            "--dataset",
            str(tmp_path / "nope.jsonl"),
            "--thresholds",
            str(_write_thresholds(tmp_path, {"false_refusal": 0.1})),
            "--sprint",
            "test",
            "--api-url",
            "https://api.test",
            "--results-dir",
            str(tmp_path / "results"),
        ]
    )
    code = run(args)
    assert code == 2


@responses.activate
def test_run_survives_endpoint_404_and_writes_results(tmp_path: Path) -> None:
    """When /api/answer isn't implemented yet, the runner still writes
    results with the failure captured and only fails thresholds if the
    aggregate breaches. With the fixture thresholds (false_refusal <= 1.0),
    a 404-across-the-board run exits 0 because false_refusal is not
    applicable to any case (all cases had an API error, so all metric
    results are non-applicable → aggregate is 0.0 → passes the loose bound)."""
    responses.post("https://api.test/api/answer", status=404, body="not found")
    responses.post("https://api.test/api/answer", status=404, body="not found")

    args = parse_args(
        [
            "--dataset",
            str(_write_fixture_dataset(tmp_path)),
            "--thresholds",
            str(_write_thresholds(tmp_path, {"false_refusal": 1.0})),
            "--sprint",
            "test",
            "--api-url",
            "https://api.test",
            "--results-dir",
            str(tmp_path / "results"),
        ]
    )
    code = run(args)
    assert code == 0
    files = list((tmp_path / "results" / "sprint-test").glob("*.json"))
    assert len(files) == 1
    body = json.loads(files[0].read_text())
    assert all(c["error"]["kind"] == "endpoint-not-implemented" for c in body["cases"])


# ---------- GW-14: per-provenance slicing + slice-breach exit code ----------


def _write_mixed_provenance_dataset(tmp_path: Path) -> Path:
    """Two cases: one real-customer, one constructed-adversarial. The
    adversarial one will 'answer' when it should abstain — the shape
    that a per-slice threshold catches but a permissive overall gate
    would let through."""
    dataset = tmp_path / "d.jsonl"
    dataset.write_text(
        # real-customer answer case — expected answer, gets answer.
        '{"id":"answer-1","intent":"product","user_input":"q1","expected_behavior":"answer",'
        '"required_source_ids":[],"prohibited_claims":[],'
        '"provenance":"real-customer — fixture"}\n'
        # adversarial abstain case — expected abstain, gets answer (bad).
        '{"id":"adv-1","intent":"out-of-scope","user_input":"q2","expected_behavior":"abstain",'
        '"required_source_ids":[],"prohibited_claims":[],'
        '"provenance":"constructed-adversarial — fixture"}\n'
    )
    return dataset


@responses.activate
def test_run_slice_breach_fires_when_overall_passes(tmp_path: Path) -> None:
    # Both cases hit the endpoint and get an answer response.
    responses.post(
        "https://api.test/api/answer",
        json={"answer": "ok", "behavior": "answer"},
        status=200,
    )
    responses.post(
        "https://api.test/api/answer",
        json={"answer": "ok", "behavior": "answer"},
        status=200,
    )

    # Overall: correct_abstention has one applicable case (the adversarial
    # one), scoring 0.0. Threshold at 0.0 would pass overall. But the
    # per-provenance threshold at 1.00 on constructed-adversarial fires.
    thresholds = {
        "correct_abstention": 0.0,
        "by_provenance": {
            "constructed-adversarial": {"correct_abstention": 1.0},
        },
    }
    args = parse_args(
        [
            "--dataset",
            str(_write_mixed_provenance_dataset(tmp_path)),
            "--thresholds",
            str(_write_thresholds(tmp_path, thresholds)),
            "--sprint",
            "test",
            "--api-url",
            "https://api.test",
            "--results-dir",
            str(tmp_path / "results"),
        ]
    )
    code = run(args)
    assert code == 1

    body = json.loads(list((tmp_path / "results" / "sprint-test").glob("*.json"))[0].read_text())
    breaches = body["breaches"]
    assert len(breaches) == 1
    assert breaches[0]["provenance"] == "constructed-adversarial"
    assert breaches[0]["metric"] == "correct_abstention"


@responses.activate
def test_run_writes_per_provenance_section(tmp_path: Path) -> None:
    responses.post(
        "https://api.test/api/answer",
        json={"answer": "ok", "behavior": "answer"},
        status=200,
    )
    responses.post(
        "https://api.test/api/answer",
        json={"answer": "", "behavior": "abstain", "refusal_reason": "out-of-scope"},
        status=200,
    )
    args = parse_args(
        [
            "--dataset",
            str(_write_mixed_provenance_dataset(tmp_path)),
            "--thresholds",
            str(_write_thresholds(tmp_path, {})),  # no gates
            "--sprint",
            "test",
            "--api-url",
            "https://api.test",
            "--results-dir",
            str(tmp_path / "results"),
        ]
    )
    code = run(args)
    assert code == 0

    body = json.loads(list((tmp_path / "results" / "sprint-test").glob("*.json"))[0].read_text())
    assert "per_provenance" in body
    assert set(body["per_provenance"].keys()) == {"real-customer", "constructed-adversarial"}
    # The adversarial slice's correct_abstention should be 1.0 (case
    # abstained as expected).
    adv = body["per_provenance"]["constructed-adversarial"]
    assert adv["correct_abstention"]["score"] == 1.0
    assert adv["correct_abstention"]["n_applicable"] == 1
