"""Tests for scripts/strip_messages.py.

The script handles raw customer PII, so the safety-critical paths
(path-refusal, name/postcode/phone/email redaction) get explicit
coverage. Coverage isn't exhaustive — regex-based redaction has
long-tail failures by design — but every claim in the redaction
docstring has a passing test.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import strip_messages as sm  # noqa: E402


# ---------- path safety ----------


def test_is_inside_repo_true_for_repo_file(tmp_path: Path) -> None:
    repo_file = sm.REPO_ROOT / "README.md"
    assert sm.is_inside_repo(repo_file) is True


def test_is_inside_repo_false_for_tmp_file(tmp_path: Path) -> None:
    external = tmp_path / "messages.txt"
    external.write_text("hi")
    assert sm.is_inside_repo(external) is False


def test_main_refuses_input_inside_repo(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    inside = sm.REPO_ROOT / "README.md"  # exists, inside repo
    rc = sm.main([str(inside)])
    assert rc == 3
    err = capsys.readouterr().err
    assert "REFUSED" in err
    assert "inside the repo" in err


def test_main_refuses_output_inside_repo(tmp_path: Path, capsys) -> None:
    external_input = tmp_path / "in.txt"
    external_input.write_text("do you deliver?\n")
    output_inside = sm.REPO_ROOT / "should-not-write-here.jsonl"
    rc = sm.main([str(external_input), str(output_inside)])
    assert rc == 3
    err = capsys.readouterr().err
    assert "REFUSED" in err


# ---------- question detection ----------


def test_question_candidate_detects_question_mark() -> None:
    # A "?" always qualifies, even without an interrogative first word.
    assert sm.is_question_candidate("delivery to Chelsea please?") is True
    # Also qualifies without punctuation if the first word is interrogative
    # — the filter is deliberately permissive (SME curates the output).
    assert sm.is_question_candidate("do you deliver") is True
    # Statements without either signal are dropped.
    assert sm.is_question_candidate("delivery is fine, thanks") is False


def test_question_candidate_detects_interrogative_start() -> None:
    assert sm.is_question_candidate("do you stock this") is True
    assert sm.is_question_candidate("how much for the saddle") is True
    assert sm.is_question_candidate("thanks for your help") is False


def test_question_candidate_ignores_empty() -> None:
    assert sm.is_question_candidate("") is False
    assert sm.is_question_candidate("   ") is False


# ---------- typed redactions ----------


def test_strips_email() -> None:
    text = "email me at customer@example.co.uk for details"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[EMAIL]" in stripped
    assert "customer@example" not in stripped
    assert "EMAIL" in redactions


def test_strips_uk_postcode() -> None:
    text = "do you deliver to SW1A 1AA?"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[POSTCODE]" in stripped
    assert "SW1A" not in stripped
    assert "POSTCODE" in redactions


def test_strips_phone_variants() -> None:
    for phone in ("+44 20 7946 0958", "020 7946 0958", "07700 900123"):
        text = f"call me on {phone} please"
        stripped, redactions, _, _ = sm.strip_message(
            text, set(sm.DEFAULT_ALLOWLIST)
        )
        assert "[PHONE]" in stripped, f"failed for {phone!r}"
        assert "PHONE" in redactions


def test_strips_what3words() -> None:
    text = "we're at ///filled.count.soap by the barn"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[W3W]" in stripped
    assert "filled.count.soap" not in stripped
    assert "W3W" in redactions


def test_strips_sort_code_and_account() -> None:
    text = "pay to 12-34-56 account 87654321 thanks"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[SORT_CODE]" in stripped
    assert "[ACCOUNT_NUMBER]" in stripped
    assert "SORT_CODE" in redactions
    assert "ACCOUNT_NUMBER" in redactions


def test_strips_gate_code() -> None:
    text = "the yard gate code is 4590"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[GATE_CODE]" in stripped
    assert "4590" not in stripped
    assert "GATE_CODE" in redactions


def test_strips_social_handle() -> None:
    text = "message me on ig @rider_life"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[HANDLE]" in stripped
    assert "@rider_life" not in stripped
    assert "HANDLE" in redactions


# ---------- name redaction (structural patterns only) ----------


def test_redacts_sign_off_name() -> None:
    text = "do you deliver on saturdays?\n\nThanks,\nSarah"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[NAME]" in stripped
    assert "Sarah" not in stripped
    assert "NAME" in redactions


def test_redacts_self_intro_name() -> None:
    text = "hi, my name is Jenny Smith. do you stock treeless saddles?"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[NAME]" in stripped
    assert "Jenny" not in stripped


def test_redacts_greeting_name() -> None:
    text = "Hi Bob, do you have any 4' turnout rugs left?"
    stripped, redactions, _, _ = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert "[NAME]" in stripped
    assert "Bob" not in stripped


# ---------- capitalised-token flagging ----------


def test_flags_uncovered_capital_but_not_brand() -> None:
    text = "does the Wintec fit my horse Barnaby?"
    _, _, review, flagged = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert review is True
    assert "Barnaby" in flagged
    assert "Wintec" not in flagged  # brand allowlisted


def test_sentence_initial_capital_not_flagged() -> None:
    text = "Do you deliver on saturdays?"
    _, _, review, flagged = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert flagged == []
    assert review is False


def test_no_flag_when_all_caps_covered() -> None:
    text = "does the Wintec fit better than the Bates for a cob?"
    _, _, review, flagged = sm.strip_message(text, set(sm.DEFAULT_ALLOWLIST))
    assert review is False
    assert flagged == []


# ---------- end-to-end: main() writes JSONL, path outside repo ----------


def test_main_end_to_end_produces_candidates(tmp_path: Path, capsys) -> None:
    raw = (
        "Jane Smith\n"
        "Sunday at 3:47 PM\n"
        "do you deliver to SW1A 1AA?\n"
        "\n"
        "how much is the wintec 500 dressage?\n"
        "\n"
        "Thanks,\nJane"
    )
    input_path = tmp_path / "messages.txt"
    input_path.write_text(raw)
    output_path = tmp_path / "out.jsonl"

    rc = sm.main([str(input_path), str(output_path)])
    assert rc == 0
    assert output_path.exists()

    lines = [
        line for line in output_path.read_text().splitlines() if line
    ]
    # Two question-shaped messages; the "Thanks, Jane" sign-off block
    # isn't a question and should be filtered out.
    assert len(lines) == 2

    import json

    parsed = [json.loads(line) for line in lines]
    joined = " ".join(p["text"] for p in parsed)
    assert "[POSTCODE]" in joined
    assert "SW1A" not in joined

    err = capsys.readouterr().err
    assert "question candidates out: 2" in err
