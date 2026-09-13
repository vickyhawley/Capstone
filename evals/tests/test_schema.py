from __future__ import annotations

from pathlib import Path

import pytest

from groundwork_evals.schema import DatasetError, EvalCase, load_dataset


def test_load_dataset_reads_all_fixture_cases(tmp_path: Path) -> None:
    dataset = tmp_path / "d.jsonl"
    dataset.write_text(
        '{"id":"a","intent":"product","user_input":"q","expected_behavior":"answer","provenance":"x"}\n'
        '{"id":"b","intent":"out-of-scope","user_input":"q","expected_behavior":"abstain","provenance":"x"}\n'
    )
    cases = load_dataset(dataset)
    assert [c.id for c in cases] == ["a", "b"]
    assert isinstance(cases[0], EvalCase)


def test_load_dataset_skips_comment_and_blank_lines(tmp_path: Path) -> None:
    dataset = tmp_path / "d.jsonl"
    dataset.write_text(
        "// header comment\n"
        "\n"
        '{"id":"a","intent":"product","user_input":"q","expected_behavior":"answer","provenance":"x"}\n'
    )
    cases = load_dataset(dataset)
    assert len(cases) == 1


def test_load_dataset_rejects_invalid_json(tmp_path: Path) -> None:
    dataset = tmp_path / "d.jsonl"
    dataset.write_text("not json\n")
    with pytest.raises(DatasetError, match="invalid JSON"):
        load_dataset(dataset)


def test_load_dataset_rejects_schema_mismatch(tmp_path: Path) -> None:
    dataset = tmp_path / "d.jsonl"
    dataset.write_text('{"id":"a","intent":"nonsense","user_input":"q","expected_behavior":"answer","provenance":"x"}\n')
    with pytest.raises(DatasetError, match="schema validation failed"):
        load_dataset(dataset)


def test_load_dataset_rejects_duplicate_ids(tmp_path: Path) -> None:
    dataset = tmp_path / "d.jsonl"
    dataset.write_text(
        '{"id":"a","intent":"product","user_input":"q","expected_behavior":"answer","provenance":"x"}\n'
        '{"id":"a","intent":"product","user_input":"q2","expected_behavior":"answer","provenance":"x"}\n'
    )
    with pytest.raises(DatasetError, match="duplicate case id"):
        load_dataset(dataset)


def test_load_dataset_missing_file(tmp_path: Path) -> None:
    with pytest.raises(DatasetError, match="not found"):
        load_dataset(tmp_path / "nope.jsonl")


def test_load_dataset_empty_file(tmp_path: Path) -> None:
    dataset = tmp_path / "d.jsonl"
    dataset.write_text("\n\n// only comments\n")
    with pytest.raises(DatasetError, match="no cases"):
        load_dataset(dataset)


def test_load_fixtures_file() -> None:
    """The actual fixtures file in the repo must parse cleanly."""
    fixtures = Path(__file__).parent.parent / "datasets" / "fixtures" / "harness-smoke.jsonl"
    cases = load_dataset(fixtures)
    assert len(cases) == 3
    assert {c.expected_behavior for c in cases} == {"answer", "escalate", "abstain"}
