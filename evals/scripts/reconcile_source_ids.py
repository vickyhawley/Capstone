#!/usr/bin/env python3
"""Reconcile stale required_source_ids against the current corpus.

Problem: chunk IDs are `default gen_random_uuid()`, so every ingest
regenerates them. Golden cases reference chunks by UUID, so any
re-ingest silently invalidates them. Discovered 2026-09-16 when
Sprint 2's post-sparse-fix baseline showed dense at 0.0% (Sprint 1
had it at 83.3%).

This script builds a mapping from each case's declared intent-to-
retrieve target back to a current chunk ID, and rewrites the golden
JSONL file in place.

The mapping is done by heuristics, per case:
- product handle → the product's chunk(s) in the corpus
- guide slug + section keyword → the matching guide chunk(s)

Every heuristic decision is printed with the OLD id (if any) → NEW
id transition so a human can review before diffing the file.

Usage
-----

    python reconcile_source_ids.py --dry-run    print the mapping, no writes
    python reconcile_source_ids.py --apply      rewrite the JSONL file

Env
---

Same as find_chunks.py: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATASET = REPO_ROOT / "evals" / "datasets" / "sprint-1" / "cases.jsonl"


def env_or_die(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.stderr.write(f"Missing env: {name}\n")
        sys.exit(2)
    return value


def load_corpus() -> tuple[dict[str, dict], list[dict]]:
    url = env_or_die("SUPABASE_URL").rstrip("/")
    key = env_or_die("SUPABASE_SERVICE_ROLE_KEY")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}
    docs = requests.get(
        f"{url}/rest/v1/documents",
        headers=headers,
        params={"select": "id,content_type,source_ref,title", "limit": "1000"},
        timeout=30,
    ).json()
    doc_by_id = {d["id"]: d for d in docs}
    chunks = requests.get(
        f"{url}/rest/v1/chunks",
        headers=headers,
        params={"select": "id,text,metadata,document_id,ordinal", "limit": "2000"},
        timeout=30,
    ).json()
    return doc_by_id, chunks


def index_chunks(
    doc_by_id: dict[str, dict], chunks: list[dict]
) -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    """Return two indexes: by product handle, and by (guide slug, section)."""
    by_handle: dict[str, list[dict]] = {}
    by_guide_section: dict[str, list[dict]] = {}
    for chunk in chunks:
        doc = doc_by_id.get(chunk["document_id"])
        if not doc:
            continue
        if doc["content_type"] == "product":
            by_handle.setdefault(doc["source_ref"], []).append(chunk)
        else:
            metadata = chunk.get("metadata") or {}
            slug = metadata.get("guide_slug", doc["source_ref"])
            section = metadata.get("section_title", "")
            by_guide_section.setdefault(f"{slug}::{section}", []).append(chunk)
    return by_handle, by_guide_section


def guide_chunks(
    by_guide_section: dict[str, list[dict]], slug: str
) -> list[dict]:
    """All chunks for a given guide slug, regardless of section."""
    out: list[dict] = []
    for key, chunks in by_guide_section.items():
        if key.startswith(f"{slug}::"):
            out.extend(chunks)
    return sorted(out, key=lambda c: c.get("ordinal", 0))


def section_chunks(
    by_guide_section: dict[str, list[dict]], slug: str, section: str
) -> list[dict]:
    """Chunks for a specific (guide, section) pair."""
    return sorted(
        by_guide_section.get(f"{slug}::{section}", []),
        key=lambda c: c.get("ordinal", 0),
    )


# ---------- Per-case mappings ----------
#
# Each entry names WHAT the case's required_source_ids should point
# at, in a form that survives a re-ingest. Handles / guide slugs are
# stable; UUIDs are not.

CASE_TARGETS: dict[str, dict[str, Any]] = {
    # Shavings price question — Sprint 1 mapped 4 shavings product chunks.
    "product-002-shavings-price": {
        "handles": [
            "bedmax-shavings",
            "dutch-shavings-small-flake",
            "littlemax-shavings",
        ],
    },
    # Burley bale haylage — Sprint 1 mapped 6 burlybale + related chunks.
    "product-005-burley-bale-only": {
        "handles": [
            "burlybale-econo",
            "burlybale-high-fibre",
            "burlybale-pasture",
            "burlybale-rye-grass",
            "horsehage-blue-high-fibre",
            "horsehage-timothy",
        ],
    },
    # Purple horsehage = HorseHage Timothy (trade synonym).
    "product-007-purple-horsehage-price": {
        "handles": ["horsehage-timothy"],
    },
    # Small flake shavings — Dutch shavings is the small-flake product.
    "product-009-small-flake-shavings": {
        "handles": ["dutch-shavings-small-flake"],
    },
    # Pig nuts / goat mix.
    "product-010-pig-nuts-goat-mix": {
        "handles": ["a-p-pygmy-goat-mix-15kg"],
    },
    # Delivery / logistics cases — section-specific mappings.
    # Sprint 1 mapped these to 1-3 chunks of the delivery policy; we
    # preserve that granularity here (rather than dumping all 7 chunks
    # of the guide), so Sprint 2 recall numbers stay apples-to-apples
    # with Sprint 1's baseline.
    "logistics-011-round-corner-noaule-lane": {
        # "minimum delivery, round the corner" — free/no-minimum answer.
        "guide_sections": [("delivery", "Current policy")],
    },
    "logistics-012-verwood-delivery-cost": {
        # "how much is delivery to Verwood" — cost + zone.
        "guide_sections": [("delivery", "Current policy")],
    },
    "logistics-013-whatsapp-orders": {
        # "WhatsApp or ring?" — ordering channel answer sits in the
        # second Current-policy chunk.
        "guide_sections": [("delivery", "Current policy")],
    },
    "logistics-014-set-day-or-on-demand": {
        # "set day or on demand" — notes chunk answers this shape.
        "guide_sections": [
            ("delivery", "Current policy"),
            ("delivery", "Notes for the answer engine"),
        ],
    },
    "logistics-015-notice-required": {
        # "how much notice" — notes chunk carries the on-demand answer.
        "guide_sections": [
            ("delivery", "Current policy"),
            ("delivery", "Notes for the answer engine"),
        ],
    },
    "logistics-016-saturday-delivery": {
        # Saturday delivery = delivery current policy + opening-hours
        # standard-hours (which shows Saturday hours).
        "guide_sections": [
            ("delivery", "Current policy"),
            ("opening-hours", "Standard opening hours"),
        ],
    },
    "logistics-017-minimum-delivery-superseded": {
        # Customer quotes old "£200 minimum" policy — needs current
        # answer + superseded chunk.
        "guide_sections": [
            ("delivery", "Current policy"),
            ("delivery", "Superseded policy — do not resurface"),
        ],
    },
    "logistics-018-ordering-level-and-areas-superseded": {
        "guide_sections": [
            ("delivery", "Current policy"),
            ("delivery", "Superseded policy — do not resurface"),
        ],
    },
    "logistics-019-delivery-cost-superseded": {
        "guide_sections": [
            ("delivery", "Current policy"),
            ("delivery", "Superseded policy — do not resurface"),
        ],
    },
    "logistics-020-bank-holiday-monday-superseded": {
        # Bank holiday Monday — bank-holidays section + superseded
        # (customer may be quoting old "closed on bank hols" policy).
        "guide_sections": [
            ("opening-hours", "Bank holidays"),
            ("opening-hours", "Superseded — do not resurface"),
        ],
    },
    # Thunderbrook Herbal Muesli — 15kg is the SKU in the catalogue.
    "product-021-thunderbrook-herbal-muesli": {
        "handles": ["thunderbrook-healthy-herbal-muesli-15kg"],
    },
    # Haygates conditioning cubes — case is about a product NFCS
    # doesn't stock, but their substitute (HiLight conditioning cubes)
    # is the retrieval target. Sprint 1 baseline recorded this as
    # `substitute-offered` tag.
    "product-022-haygates-conditioning-cubes": {
        "handles": ["hilight-conditioning-cubes"],
    },
    # Jodhpur length question — Sprint 1 mapped 2 jodhpur product chunks.
    "fit-029-jodhpur-length-rider": {
        "handles": [
            "rhinegold-essential-jodhpurs",
            "rhinegold-childrens-essential-jodhpurs",
        ],
    },
}


def resolve_case(
    case_id: str,
    old_ids: list[str],
    by_handle: dict[str, list[dict]],
    by_guide_section: dict[str, list[dict]],
) -> tuple[list[str], list[str]]:
    """Return (new_ids, warnings) for a case's target spec."""
    spec = CASE_TARGETS.get(case_id)
    if spec is None:
        return old_ids, [f"no target spec for {case_id}"]

    new_ids: list[str] = []
    warnings: list[str] = []

    for handle in spec.get("handles", []):
        matches = by_handle.get(handle, [])
        if not matches:
            warnings.append(f"no chunk found for product handle {handle!r}")
            continue
        new_ids.extend(c["id"] for c in matches)

    for slug in spec.get("guide_slugs", []):
        matches = guide_chunks(by_guide_section, slug)
        if not matches:
            warnings.append(f"no chunk found for guide slug {slug!r}")
            continue
        new_ids.extend(c["id"] for c in matches)

    for slug, section in spec.get("guide_sections", []):
        matches = section_chunks(by_guide_section, slug, section)
        if not matches:
            warnings.append(f"no chunk for guide {slug!r} section {section!r}")
            continue
        new_ids.extend(c["id"] for c in matches)

    # Preserve declaration order but de-dupe. Downstream doesn't
    # care about order but consistency helps diffs.
    seen: set[str] = set()
    deduped: list[str] = []
    for chunk_id in new_ids:
        if chunk_id in seen:
            continue
        seen.add(chunk_id)
        deduped.append(chunk_id)

    return deduped, warnings


def main() -> None:
    parser = argparse.ArgumentParser(description="Reconcile stale required_source_ids.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--dry-run", action="store_true", help="Print the mapping only.")
    action.add_argument("--apply", action="store_true", help="Rewrite the JSONL file.")
    args = parser.parse_args()

    doc_by_id, chunks = load_corpus()
    by_handle, by_guide_section = index_chunks(doc_by_id, chunks)

    with DATASET.open("r", encoding="utf-8") as f:
        lines = f.readlines()

    updated_lines: list[str] = []
    total_changed = 0
    total_warnings: list[tuple[str, str]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            updated_lines.append(line)
            continue
        case = json.loads(stripped)
        case_id = case["id"]
        old_ids = list(case.get("required_source_ids", []))
        if not old_ids:
            updated_lines.append(line)
            continue

        new_ids, warnings = resolve_case(case_id, old_ids, by_handle, by_guide_section)
        for w in warnings:
            total_warnings.append((case_id, w))

        if new_ids == old_ids:
            print(f"UNCHANGED  {case_id}  ({len(old_ids)} ids)")
        else:
            print(f"CHANGED    {case_id}")
            print(f"  from ({len(old_ids)}): {old_ids}")
            print(f"    to ({len(new_ids)}): {new_ids}")
            total_changed += 1

        case["required_source_ids"] = new_ids
        updated_lines.append(json.dumps(case, ensure_ascii=False) + "\n")

    print()
    print(f"summary: {total_changed} case(s) changed")
    if total_warnings:
        print(f"WARNINGS ({len(total_warnings)}):")
        for cid, w in total_warnings:
            print(f"  {cid}: {w}")

    if args.apply:
        with DATASET.open("w", encoding="utf-8") as f:
            f.writelines(updated_lines)
        print()
        print(f"wrote {DATASET}")


if __name__ == "__main__":
    main()
