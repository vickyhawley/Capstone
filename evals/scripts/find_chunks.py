#!/usr/bin/env python3
"""Find candidate chunk IDs in the deployed Supabase corpus.

Read-only helper for populating `required_source_ids` on golden cases.
The corpus will change (product catalogue refreshes, guides get
authored, chunkers get tuned), so this script is deliberately
rerunnable — never bake chunk IDs into anything beyond the case
files themselves.

Usage
-----

    python find_chunks.py "shavings"          keyword search across all chunks
    python find_chunks.py --handle aubiose    the chunk for a specific product handle
    python find_chunks.py --guides            list all guide chunks
    python find_chunks.py --all-products      list all product handles

Env
---

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
The service role key bypasses RLS (read-only calls only in this
script). Populate .env.local from `.env.example`; source it however
you prefer (`export $(grep -v '^#' .env.local | xargs)` or invoke
this via a wrapper that sources it).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Any

import requests


def env_or_die(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.stderr.write(f"Missing env: {name}\n")
        sys.exit(2)
    return value


def rest_get(url: str, headers: dict[str, str], params: dict[str, str] | None = None) -> Any:
    response = requests.get(url, headers=headers, params=params, timeout=30)
    if response.status_code >= 400:
        sys.stderr.write(f"HTTP {response.status_code}: {response.text}\n")
        sys.exit(1)
    return response.json()


def preview(text: str, length: int = 220) -> str:
    """Collapse whitespace and truncate for one-line display."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= length:
        return text
    return text[:length] + "…"


def load_corpus(url: str, headers: dict[str, str]) -> tuple[dict[str, dict], list[dict]]:
    """Fetch all documents and chunks. ~500 rows total at Sprint 1 scale."""
    docs = rest_get(
        f"{url}/rest/v1/documents",
        headers,
        {"select": "id,content_type,source_ref,title", "limit": "1000"},
    )
    doc_by_id = {d["id"]: d for d in docs}
    chunks = rest_get(
        f"{url}/rest/v1/chunks",
        headers,
        {"select": "id,text,metadata,document_id,ordinal", "limit": "2000"},
    )
    return doc_by_id, chunks


def print_chunk(chunk: dict, doc: dict, length: int = 220) -> None:
    metadata = chunk.get("metadata") or {}
    if doc["content_type"] == "product":
        handle = doc["source_ref"]
        label = f"product/{handle}"
    else:
        slug = metadata.get("guide_slug", doc["source_ref"])
        section = metadata.get("section_title", "")
        label = f"guide/{slug}  §{section!r}" if section else f"guide/{slug}"
    print(f"{chunk['id']}  {label}")
    print(f"    {preview(chunk['text'], length)}")


def cmd_search(query: str, doc_by_id: dict, chunks: list[dict]) -> None:
    needle = query.lower()
    hits = 0
    for chunk in chunks:
        text = chunk.get("text") or ""
        if needle not in text.lower():
            continue
        doc = doc_by_id.get(chunk["document_id"])
        if not doc:
            continue
        print_chunk(chunk, doc)
        print()
        hits += 1
    if hits == 0:
        print(f"No chunks match: {query!r}")


def cmd_handle(handle: str, doc_by_id: dict, chunks: list[dict]) -> None:
    matched = [
        c
        for c in chunks
        if (doc_by_id.get(c["document_id"]) or {}).get("source_ref") == handle
        and (doc_by_id.get(c["document_id"]) or {}).get("content_type") == "product"
    ]
    if not matched:
        print(f"No chunk found for product handle: {handle}")
        return
    for chunk in matched:
        doc = doc_by_id[chunk["document_id"]]
        print_chunk(chunk, doc, length=400)


def cmd_guides(doc_by_id: dict, chunks: list[dict]) -> None:
    guide_chunks = [
        c for c in chunks if (doc_by_id.get(c["document_id"]) or {}).get("content_type") == "guide"
    ]
    guide_chunks.sort(
        key=lambda c: (
            (doc_by_id.get(c["document_id"]) or {}).get("source_ref", ""),
            c.get("ordinal", 0),
        )
    )
    for chunk in guide_chunks:
        doc = doc_by_id[chunk["document_id"]]
        print_chunk(chunk, doc, length=260)
        print()


def cmd_all_products(doc_by_id: dict, chunks: list[dict]) -> None:
    _ = chunks
    handles = sorted(
        {d["source_ref"] for d in doc_by_id.values() if d["content_type"] == "product"}
    )
    for handle in handles:
        print(handle)


def main() -> None:
    parser = argparse.ArgumentParser(description="Find candidate chunk IDs in Supabase.")
    parser.add_argument("query", nargs="?", help="Case-insensitive substring to search for.")
    parser.add_argument("--handle", help="Return the chunk for a specific product handle.")
    parser.add_argument("--guides", action="store_true", help="List all guide chunks.")
    parser.add_argument(
        "--all-products", action="store_true", help="List all product handles."
    )
    args = parser.parse_args()

    url = env_or_die("SUPABASE_URL").rstrip("/")
    key = env_or_die("SUPABASE_SERVICE_ROLE_KEY")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}

    doc_by_id, chunks = load_corpus(url, headers)

    if args.all_products:
        cmd_all_products(doc_by_id, chunks)
    elif args.guides:
        cmd_guides(doc_by_id, chunks)
    elif args.handle:
        cmd_handle(args.handle, doc_by_id, chunks)
    elif args.query:
        cmd_search(args.query, doc_by_id, chunks)
    else:
        parser.print_usage()
        sys.exit(2)


if __name__ == "__main__":
    main()
