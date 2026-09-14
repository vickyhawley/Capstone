#!/usr/bin/env python3
"""Strip PII from a raw customer-message export and produce candidate questions.

The tool refuses to read from or write to any path inside this repo — raw
customer messages contain PII and must never be committed, even after
redaction. Output is JSONL of question-shaped messages with each detected
PII substring replaced by a typed placeholder (`[NAME]`, `[PHONE]`,
`[POSTCODE]`, …) so the sentence shape survives for downstream case
authoring: "do you deliver to [POSTCODE]" is a usable test case; "do you
deliver to" is not.

Capitalised tokens that aren't in the brand/product allowlist are
*flagged for human review*, not auto-redacted. Horse names are proper
nouns in an animal context; so are brand names. A regex cannot
distinguish them, so this tool defers to the SME.

Usage:
    python evals/scripts/strip_messages.py <input.txt> [<output.jsonl>] \\
        [--allowlist path/to/brands.txt]

Exit codes:
    0 — success
    2 — input path missing or unreadable
    3 — input or output path resolves inside this repo (refused)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# scripts/strip_messages.py -> evals/scripts -> evals -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]


# ---------- Redaction patterns ----------
#
# Order matters: apply more-specific patterns first so a phone number
# embedded inside an address doesn't get half-redacted.

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "EMAIL",
        re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
    ),
    (
        "W3W",
        re.compile(r"///[a-z]+\.[a-z]+\.[a-z]+", re.IGNORECASE),
    ),
    (
        # UK postcode: e.g. SW1A 1AA, M1 1AE, EC1A 1BB. Space-optional.
        "POSTCODE",
        re.compile(
            r"\b[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}\b",
            re.IGNORECASE,
        ),
    ),
    (
        # UK phone in common shapes: +44 …, 0044 …, or leading 0.
        # Requires ≥10 digits total. Deliberately loose to catch messy input.
        "PHONE",
        re.compile(
            r"(?:(?:\+44|0044)[\s\-]?|\b0)\d(?:[\d\s\-()]{8,14})\d"
        ),
    ),
    (
        # UK sort code: nn-nn-nn or nn nn nn
        "SORT_CODE",
        re.compile(r"\b\d{2}[\s\-]\d{2}[\s\-]\d{2}\b"),
    ),
    (
        # UK account number: 8 consecutive digits, not part of a longer number.
        # Order: after phone/sort so we don't split those.
        "ACCOUNT_NUMBER",
        re.compile(r"(?<!\d)\d{8}(?!\d)"),
    ),
    (
        # Gate/access code framed by a keyword. The keyword and the number
        # may be separated by short filler ("gate code is 4590") so allow
        # up to ~15 non-digit chars between them.
        "GATE_CODE",
        re.compile(
            r"\b(?:gate|access|entry|door|key)\s*"
            r"(?:code|number|no\.?|pin|#)?[^\d\n]{0,15}\d{3,8}\b",
            re.IGNORECASE,
        ),
    ),
    (
        # Social handle: @username. Won't confuse with email because email
        # runs earlier.
        "HANDLE",
        re.compile(r"(?<![\w.])@[A-Za-z][\w.\-]{2,}\b"),
    ),
]

# UK street address heuristic. Requires a leading number and a street-type
# suffix so we don't hit random "10 Something Ltd" business names.
STREET_SUFFIXES = (
    r"street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|way|drive|dr\.?"
    r"|close|court|ct\.?|crescent|square|sq\.?|place|pl\.?|terrace|mews"
    r"|park|gardens?|grove|hill|walk|row"
)
ADDRESS_PATTERN = re.compile(
    rf"\b\d+[a-z]?\s+[A-Z][A-Za-z']+(?:\s+[A-Z][A-Za-z']+)*"
    rf"\s+(?:{STREET_SUFFIXES})\b",
    re.IGNORECASE,
)

# Name-pattern heuristics: three shapes we can catch by structure alone.
# Anything else is flagged for review, not redacted, because horse names
# and brand names look identical to a regex.
_NAME_TC = r"[A-Z][a-z]+(?:[- ][A-Z][a-z]+){0,2}"
NAME_SIGN_OFF = re.compile(
    rf"(?im)^(?:thanks?|cheers|regards|best(?:\s+wishes)?|love|from|-)"
    rf"[,\s\-]*({_NAME_TC})\s*$"
)
NAME_INTRO = re.compile(rf"\b(?:hi|hello|dear)\s+({_NAME_TC})\b", re.IGNORECASE)
NAME_SELF_INTRO = re.compile(
    rf"\b(?:my\s+name\s+is|i(?:'m|\s*am)|this\s+is)\s+({_NAME_TC})\b",
    re.IGNORECASE,
)


# ---------- Message parsing ----------
#
# Assume input is either a raw dump (one message per line/block) or a
# Messenger copy-paste (sender-line / timestamp-line / message-line groups
# separated by blank lines). We split on blank lines and, within each
# block, drop leading lines that look like sender-name or timestamp
# metadata.

TIMESTAMP_LINE = re.compile(
    r"^\s*(?:"
    r"\d{1,2}:\d{2}(?:\s*[APap]\.?[Mm]\.?)?"
    r"|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?(?:\s+at\s+.*)?"
    r"|Yesterday(?:\s+at\s+.*)?"
    r"|Today(?:\s+at\s+.*)?"
    r"|\d{1,2}\s+\w+(?:\s+\d{2,4})?(?:\s+at\s+.*)?"
    r"|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*"
    r"\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+at\s+.*)?"
    r"|seen\s+\d{1,2}:\d{2}.*"
    r")\s*$",
    re.IGNORECASE,
)

QUESTION_STARTS = frozenset({
    "do", "does", "did", "is", "are", "was", "were", "am",
    "can", "could", "would", "will", "shall", "should",
    "when", "where", "how", "what", "why", "which", "who", "whose",
    "have", "has", "had", "any", "anyone",
})


def is_question_candidate(text: str) -> bool:
    """Return True if a message looks question-shaped.

    Any message with a `?` counts. Otherwise, the first word must be an
    interrogative — this catches "do you stock…" without punctuation.
    Deliberately permissive: false positives get filtered by the SME;
    false negatives silently discard useful cases.
    """
    stripped = text.strip()
    if not stripped:
        return False
    if "?" in stripped:
        return True
    first_word = stripped.split(maxsplit=1)[0].lower().rstrip(".,!:;\"'")
    return first_word in QUESTION_STARTS


# ---------- Brand allowlist ----------
#
# Seeded with equestrian brands that appear commonly in UK saddlery
# traffic, plus a small set of general English capitalised tokens that
# don't need review. Not exhaustive by design — the SME extends via the
# --allowlist file as they see missed brands.

DEFAULT_ALLOWLIST = frozenset({
    # Saddles
    "Wintec", "Bates", "Pessoa", "Prestige", "Albion", "Kieffer",
    "Passier", "Antares", "Devoucoux", "Stubben", "Kentaur", "Fairfax",
    "Ideal", "Amerigo", "Erreplus", "Voltaire", "CWD",
    # Rugs / clothing
    "Weatherbeeta", "Rambo", "Amigo", "Horseware", "LeMieux",
    "Pikeur", "Kingsland", "Cavallo", "Toggi", "Shires", "Ariat",
    "Musto", "Roeckl", "Mountain", "Horse", "Equetech", "Aubrion",
    # Tack / bits
    "Sprenger", "Neue", "Schule", "Trust", "Bombers", "Cottage",
    "Craft", "Kavalkade",
    # Feeds / supplements — many are compound; allow head-words
    "Dodson", "Horrell", "Baileys", "Spillers", "Allen", "Page",
    "Blue", "Chip", "Global", "Herbs", "Equine", "America", "Saracen",
    # Meds / therapies (allow the head-word so discussion doesn't trip
    # review — the welfare-clinical routing is the safety layer, not
    # the redactor)
    "Bute", "Danilon",
    # Calendar / geography that shouldn't need review
    "England", "UK", "Britain", "British", "London", "Christmas",
    "Easter", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    "Saturday", "Sunday",
    # First-person and common openers we don't want to redact-flag
    "I", "I'm", "I'd", "I'll", "I've", "OK", "Ok", "Okay",
})


def load_allowlist(path: Path | None) -> set[str]:
    """Return the default allowlist merged with any user-supplied file.

    File format: one token per line, `#` starts a comment, blank lines
    ignored. Missing file is an error only if `path` was passed.
    """
    allow = set(DEFAULT_ALLOWLIST)
    if path is None:
        return allow
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            token = raw.strip()
            if token and not token.startswith("#"):
                allow.add(token)
    return allow


# ---------- Stripping ----------


def strip_message(
    text: str, allowlist: set[str]
) -> tuple[str, list[str], bool, list[str]]:
    """Apply all redactions to `text` and flag remaining capitals.

    Returns:
        stripped_text: input with typed placeholders substituted in place
            of matched PII patterns.
        redaction_types: distinct placeholder labels applied, ordered by
            first application.
        review_needed: True if any capitalised token outside the allowlist
            remains after redaction (usually a personal or horse name).
        flagged_tokens: the specific tokens that triggered review.
    """
    redactions: list[str] = []

    for label, pattern in PATTERNS:
        if pattern.search(text):
            text = pattern.sub(f"[{label}]", text)
            redactions.append(label)

    if ADDRESS_PATTERN.search(text):
        text = ADDRESS_PATTERN.sub("[ADDRESS]", text)
        redactions.append("ADDRESS")

    for name_pat in (NAME_SIGN_OFF, NAME_INTRO, NAME_SELF_INTRO):
        if name_pat.search(text):
            text = name_pat.sub(
                lambda m: m.group(0).replace(m.group(1), "[NAME]"),
                text,
            )
            redactions.append("NAME")

    flagged = flag_uncovered_caps(text, allowlist)

    # Dedupe redactions, preserve first-seen order.
    seen: set[str] = set()
    redactions_dedup: list[str] = []
    for r in redactions:
        if r not in seen:
            seen.add(r)
            redactions_dedup.append(r)

    return text, redactions_dedup, len(flagged) > 0, flagged


_CAP_TOKEN = re.compile(r"\b[A-Z][A-Za-z'\-]*\b")


def flag_uncovered_caps(text: str, allowlist: set[str]) -> list[str]:
    """Return capitalised tokens outside the allowlist, ignoring
    sentence-initial position and placeholder brackets.

    Sentence-initial capitals ("Do you…", "The one you…") are almost
    always grammar rather than proper nouns, so we skip them. Anything
    else that begins with a capital and isn't a known brand is a
    candidate personal-or-horse name.
    """
    flagged: list[str] = []
    seen: set[str] = set()
    # Split on sentence terminators plus newlines so "first token of a
    # sentence" is well-defined.
    for chunk in re.split(r"[.!?]\s+|\n+", text):
        chunk = chunk.strip()
        if not chunk:
            continue
        for i, match in enumerate(_CAP_TOKEN.finditer(chunk)):
            token = match.group(0)
            if i == 0:
                continue  # sentence-initial capital
            if token in allowlist:
                continue
            if token in seen:
                continue
            seen.add(token)
            flagged.append(token)
    return flagged


# ---------- Path safety ----------


def is_inside_repo(path: Path, repo_root: Path = REPO_ROOT) -> bool:
    """True iff `path` resolves inside `repo_root`.

    Uses `.resolve()` so a symlink into the repo is still caught.
    """
    try:
        path.resolve().relative_to(repo_root)
        return True
    except ValueError:
        return False


def default_output_path(input_path: Path) -> Path:
    """Return `<input>.candidates.jsonl` next to the input file."""
    return input_path.with_name(input_path.name + ".candidates.jsonl")


# ---------- CLI ----------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0] if __doc__ else "",
    )
    p.add_argument(
        "input",
        type=Path,
        help="Raw message export (text). Must be outside the repo.",
    )
    p.add_argument(
        "output",
        nargs="?",
        type=Path,
        default=None,
        help="Output JSONL path. Defaults to a sibling of the input.",
    )
    p.add_argument(
        "--allowlist",
        type=Path,
        default=None,
        help="Extra brand/product names (one per line, # comments).",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    input_path = args.input.resolve()

    if not input_path.exists():
        print(f"input not found: {input_path}", file=sys.stderr)
        return 2

    if is_inside_repo(input_path):
        print(
            f"REFUSED: input path resolves inside the repo working tree.\n"
            f"  input: {input_path}\n"
            f"  repo:  {REPO_ROOT}\n"
            f"Raw customer messages contain PII and must never be committed.\n"
            f"Move the file outside this directory tree and re-run.",
            file=sys.stderr,
        )
        return 3

    output_path = (args.output or default_output_path(input_path)).resolve()
    if is_inside_repo(output_path):
        print(
            f"REFUSED: output path resolves inside the repo working tree.\n"
            f"  output: {output_path}\n"
            f"  repo:   {REPO_ROOT}\n"
            f"Even after redaction, message dumps are not sanctioned for git.\n"
            f"Choose a path outside this directory tree.",
            file=sys.stderr,
        )
        return 3

    allowlist = load_allowlist(args.allowlist)
    raw = input_path.read_text(encoding="utf-8", errors="replace")

    total_messages = 0
    candidates: list[dict] = []
    redaction_counts: dict[str, int] = {}
    flagged_count = 0

    for block in re.split(r"\n\s*\n+", raw):
        block = block.strip()
        if not block:
            continue

        lines = [
            ln for ln in block.split("\n")
            if not TIMESTAMP_LINE.match(ln.strip())
        ]
        if not lines:
            continue

        message_text = "\n".join(lines).strip()
        if not message_text:
            continue
        total_messages += 1

        if not is_question_candidate(message_text):
            continue

        stripped, redactions, review, flagged = strip_message(
            message_text, allowlist
        )
        for r in redactions:
            redaction_counts[r] = redaction_counts.get(r, 0) + 1
        if review:
            flagged_count += 1

        candidates.append({
            "text": stripped,
            "redactions": redactions,
            "review_needed": review,
            "flagged_tokens": flagged if review else [],
        })

    with output_path.open("w", encoding="utf-8") as f:
        for c in candidates:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    # Summary to stderr so the JSONL on stdout redirects cleanly.
    print(f"input:  {input_path}", file=sys.stderr)
    print(f"output: {output_path}", file=sys.stderr)
    print(f"messages in:             {total_messages}", file=sys.stderr)
    print(f"question candidates out: {len(candidates)}", file=sys.stderr)
    print(f"flagged for review:      {flagged_count}", file=sys.stderr)
    if redaction_counts:
        print("redactions applied:", file=sys.stderr)
        for k in sorted(redaction_counts):
            print(f"  [{k}]: {redaction_counts[k]}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
