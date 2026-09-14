#!/usr/bin/env python3
"""Profile the product catalogue for fact-type coverage.

Purpose: measure what fraction of products carry the kinds of facts
customers actually ask about (fit / feeding / weather / ingredients),
so that ADR-0003 (corpus composition) is grounded in reproducible
numbers rather than a hunch. Rerun after any catalogue refresh.

Output goes to stdout. Numbers are pattern-sensitive; the patterns
below are the ones cited in ADR-0003. Tighter patterns give lower
percentages, broader ones give higher — the shape is stable in either
direction, and either reading is well below the coverage a grounded
answer engine would need.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = REPO_ROOT / "data" / "catalogue" / "products.csv"


# Two probe sets per fact type: tight (strict pattern set, floor) and
# broad (generous pattern set, ceiling). Reporting both gives ADR-0003
# an honest range for pattern-sensitive metrics. Where tight and broad
# agree, the number is pattern-insensitive and can be quoted as a
# single value; where they diverge (feeding, ingredients), the range
# is the defensible statement.
TIGHT: dict[str, list[str]] = {
    "size guidance": [
        r"\bsize guide\b", r"\bsize chart\b", r"\bsizing\b",
        r"\bfits (?:up to |from )?\d", r"\bhorse height\b",
    ],
    "feeding rate": [
        r"\bfeed(?:ing)?\s+rate\b", r"\bfeed(?:ing)?\s+guide\b",
        r"\bfeeding instructions\b",
        r"\d+\s*(?:g|kg|ml)\s*(?:per|/)\s*(?:100\s*kg|day|horse)",
    ],
    "waterproof rating": [
        r"\bwaterproof(?:ing)?\b", r"\bhydrostatic\b",
        r"\b\d{3,5}\s*mm\b", r"\bdenier\b",
    ],
    "ingredients": [
        r"\bingredients?\b", r"\bcomposition\b",
        r"\banalytical constituents\b", r"\bguaranteed analysis\b",
    ],
}

BROAD: dict[str, list[str]] = {
    "size guidance": TIGHT["size guidance"] + [
        r"\bmeasure\b", r"\bhh\b", r"\bchest\b",
        r"\bpony\b.*\bsize\b",
    ],
    "feeding rate": TIGHT["feeding rate"] + [
        r"\brecommended (?:daily )?(?:feeding|amount|intake|rate)\b",
        r"\bfeed(?:ing)? per day\b", r"\bhow (?:much|to feed)\b",
        r"\bdaily (?:allowance|amount|dose|intake)\b",
        r"\bfeed\s+at\s+\d", r"\bfeed(?:ing)?\s+level\b",
        r"\bscoop(?:s)?\s+per\b", r"\bration\b",
    ],
    "waterproof rating": TIGHT["waterproof rating"] + [
        r"\brainproof\b", r"\bwater[- ]resistant\b",
    ],
    "ingredients": TIGHT["ingredients"] + [
        r"\bnutritional (?:analysis|information|content|values?)\b",
        r"\bcontains\b\s*[:—-]", r"\bmade (?:from|with)\b",
        r"\bcrude\s+protein\b", r"\bcrude\s+(?:oils?|fibre|ash)\b",
        r"\bprotein\b\s*:?\s*\d", r"\boil\b\s*:?\s*\d.*%",
        r"\b(?:calcium|phosphorus|vitamin\s+[a-e]|copper|zinc)\b\s*:?\s*\d",
        r"\balfalfa|linseed|oat|barley|wheat|maize\s*:",
        r"%\s*(?:protein|fibre|oil|ash|starch|sugar)",
    ],
}


def load_products(path: Path) -> dict[str, dict]:
    """Dedup Shopify export to one row per handle (the product row)."""
    products: dict[str, dict] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            handle = row.get("Handle", "").strip()
            title = row.get("Title", "").strip()
            if handle and title and handle not in products:
                products[handle] = row
    return products


def count_variant_rows(path: Path) -> int:
    with path.open(newline="", encoding="utf-8") as fh:
        return sum(1 for row in csv.DictReader(fh) if row.get("Variant Price", "").strip())


def description_text(product: dict) -> str:
    body = product.get("Body (HTML)", "") or ""
    text = re.sub(r"<[^>]+>", " ", body)
    return re.sub(r"\s+", " ", text).strip()


def probe(products: dict[str, dict], patterns: list[str]) -> int:
    compiled = [re.compile(p, re.IGNORECASE) for p in patterns]
    hits = 0
    for product in products.values():
        haystack = " ".join([
            product.get("Body (HTML)", "") or "",
            product.get("Tags", "") or "",
            product.get("Title", "") or "",
        ])
        if any(rx.search(haystack) for rx in compiled):
            hits += 1
    return hits


def metafield_coverage(path: Path, n_products: int) -> list[tuple[str, int]]:
    populated: dict[str, int] = defaultdict(int)
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        cols = [c for c in reader.fieldnames or [] if "metafield" in c.lower()]
        seen_by_handle: dict[str, set[str]] = defaultdict(set)
        for row in reader:
            handle = row.get("Handle", "").strip()
            if not handle:
                continue
            for col in cols:
                if row.get(col, "").strip() and col not in seen_by_handle[handle]:
                    populated[col] += 1
                    seen_by_handle[handle].add(col)
    return sorted(populated.items(), key=lambda kv: -kv[1])


def main() -> None:
    products = load_products(CATALOGUE)
    variant_rows = count_variant_rows(CATALOGUE)
    n = len(products)

    lengths = sorted(len(description_text(p)) for p in products.values())
    median = lengths[len(lengths) // 2] if lengths else 0
    empties = sum(1 for length in lengths if length == 0)

    print(f"products      : {n}")
    print(f"variant rows  : {variant_rows}")
    print(f"description   : median {median} chars, {empties} empty of {n}")
    print()
    print("fact coverage (tight and broad pattern sets; range is the honest number):")
    print(f"  {'fact type':20s}  {'tight':>10s}  {'broad':>10s}")
    for fact_type in TIGHT:
        tight_hits = probe(products, TIGHT[fact_type])
        broad_hits = probe(products, BROAD[fact_type])
        tight_pct = f"{tight_hits:3d} = {100 * tight_hits / n:.1f}%"
        broad_pct = f"{broad_hits:3d} = {100 * broad_hits / n:.1f}%"
        print(f"  {fact_type:20s}  {tight_pct:>10s}  {broad_pct:>10s}")

    print()
    print("top metafield columns (populated on N of the 398 products):")
    for col, count in metafield_coverage(CATALOGUE, n)[:10]:
        short = col.split(".")[-1][:50] if "." in col else col[:50]
        print(f"  {short:52s}: {count:3d} = {100 * count / n:.1f}%")


if __name__ == "__main__":
    main()
