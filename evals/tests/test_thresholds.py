"""Tests for the threshold loader and breach detector, including
per-provenance slicing added for GW-14."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from groundwork_evals.metrics import Aggregate
from groundwork_evals.runner import normalize_provenance
from groundwork_evals.thresholds import (
    KNOWN_PROVENANCES,
    Breach,
    find_breaches,
    load_thresholds,
)


# ---------- normalize_provenance ----------


def test_normalize_provenance_maps_all_dataset_values():
    # These are the actual raw values in the Sprint 1 golden dataset.
    cases = [
        ("real-customer-enquiry — NFCS social DM export", "real-customer"),
        ("constructed-boundary-probe — grid-fill", "constructed-boundary-probe"),
        ("constructed-adversarial — prompt injection attack class", "constructed-adversarial"),
    ]
    for raw, expected in cases:
        assert normalize_provenance(raw) == expected


def test_normalize_provenance_bare_class_names():
    for known in KNOWN_PROVENANCES:
        assert normalize_provenance(known) == known


def test_normalize_provenance_rejects_unknown_prefix():
    with pytest.raises(ValueError, match="does not start with a known class"):
        normalize_provenance("mystery-source — some detail")


def test_normalize_provenance_does_not_partial_match_middle_of_word():
    # A hypothetical value like `real-customerish` should NOT map to
    # `real-customer` — the normalizer requires the prefix to end at
    # a hyphen or the end of string, not mid-word.
    with pytest.raises(ValueError):
        normalize_provenance("real-customerish something")


# ---------- load_thresholds — flat shape (backward compat) ----------


def _write(tmp_path: Path, obj: object) -> Path:
    p = tmp_path / "t.json"
    p.write_text(json.dumps(obj))
    return p


def test_load_thresholds_flat_shape(tmp_path: Path):
    p = _write(tmp_path, {"intent_classification_accuracy": 0.85, "false_refusal": 0.1})
    cfg = load_thresholds(p)
    assert cfg.overall == {"intent_classification_accuracy": 0.85, "false_refusal": 0.1}
    assert cfg.by_provenance == {}


def test_load_thresholds_rejects_unknown_metric(tmp_path: Path):
    p = _write(tmp_path, {"totally_fake_metric": 0.5})
    with pytest.raises(ValueError, match="unknown metric"):
        load_thresholds(p)


# ---------- load_thresholds — nested by_provenance ----------


def test_load_thresholds_nested_shape(tmp_path: Path):
    p = _write(
        tmp_path,
        {
            "intent_classification_accuracy": 0.85,
            "by_provenance": {
                "constructed-adversarial": {
                    "intent_classification_accuracy": 1.00,
                    "false_refusal": 0.00,
                }
            },
        },
    )
    cfg = load_thresholds(p)
    assert cfg.overall == {"intent_classification_accuracy": 0.85}
    assert cfg.by_provenance == {
        "constructed-adversarial": {
            "intent_classification_accuracy": 1.00,
            "false_refusal": 0.00,
        }
    }


def test_load_thresholds_rejects_unknown_provenance(tmp_path: Path):
    p = _write(tmp_path, {"by_provenance": {"mystery-slice": {}}})
    with pytest.raises(ValueError, match="unknown provenance"):
        load_thresholds(p)


def test_load_thresholds_rejects_non_object_by_provenance(tmp_path: Path):
    p = _write(tmp_path, {"by_provenance": [1, 2, 3]})
    with pytest.raises(ValueError, match="'by_provenance' must be an object"):
        load_thresholds(p)


def test_load_thresholds_rejects_bool_threshold(tmp_path: Path):
    # `True` is a subclass of `int` in Python — must reject
    # explicitly so a stray `true` in JSON doesn't silently become 1.0.
    p = _write(tmp_path, {"intent_classification_accuracy": True})
    with pytest.raises(ValueError, match="must be numeric"):
        load_thresholds(p)


# ---------- find_breaches — provenance stamping ----------


def _agg(metric: str, score: float, higher_is_better: bool = True) -> Aggregate:
    return Aggregate(
        metric=metric,
        score=score,
        n_applicable=10,
        n_total=10,
        higher_is_better=higher_is_better,
    )


def test_find_breaches_stamps_provenance_when_provided():
    aggs = {"intent_classification_accuracy": _agg("intent_classification_accuracy", 0.5)}
    breaches = find_breaches(
        aggs,
        {"intent_classification_accuracy": 0.9},
        provenance="constructed-adversarial",
    )
    assert len(breaches) == 1
    assert breaches[0].provenance == "constructed-adversarial"


def test_find_breaches_no_provenance_for_overall():
    aggs = {"intent_classification_accuracy": _agg("intent_classification_accuracy", 0.5)}
    breaches = find_breaches(aggs, {"intent_classification_accuracy": 0.9})
    assert len(breaches) == 1
    assert breaches[0].provenance is None


def test_find_breaches_direction_matters():
    # `false_refusal` is higher_is_better=False. A high score breaches
    # when the threshold is low.
    aggs = {"false_refusal": _agg("false_refusal", 0.2, higher_is_better=False)}
    breaches = find_breaches(aggs, {"false_refusal": 0.1})
    assert len(breaches) == 1
    assert breaches[0].higher_is_better is False


def test_breach_carries_all_fields():
    b = Breach(
        metric="x", score=0.5, threshold=0.9, higher_is_better=True, provenance="foo"
    )
    assert b.metric == "x"
    assert b.provenance == "foo"
