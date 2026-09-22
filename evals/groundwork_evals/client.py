"""HTTP client for the Groundwork API.

Wraps `POST /api/answer`. Returns a `TimedOutcome` — the (outcome,
latency_ms) tuple. `outcome` is either a validated `ApiResponse` or a
typed `ApiError`; `latency_ms` is the wall-clock request time in
milliseconds (including error paths, so timeouts and 5xx also
contribute to the p50/p95 summary). The runner handles both.

Latency reporting matches the AI Engineering Project brief's required
system metric: p50/p95 request-to-answer for 10-20 queries.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

import requests
from pydantic import ValidationError

from .schema import ApiResponse


ErrorKind = Literal["endpoint-not-implemented", "unreachable", "timeout", "bad-response", "server-error"]


@dataclass(frozen=True)
class ApiError:
    """Non-response outcome. The runner scores affected metrics as
    non-applicable and records the reason so failures are debuggable."""

    kind: ErrorKind
    detail: str
    status_code: int | None = None


CallOutcome = ApiResponse | ApiError

# (outcome, latency_ms). Latency includes error paths so p50/p95 aren't
# artificially rosy when the server is timing out.
TimedOutcome = tuple[CallOutcome, float]


class ApiClient:
    """Minimal client. One method per API endpoint we call from evals."""

    def __init__(self, base_url: str, timeout_s: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def answer(self, query: str, conversation_id: str | None = None) -> TimedOutcome:
        url = f"{self.base_url}/api/answer"
        payload: dict[str, str] = {"query": query}
        if conversation_id:
            payload["conversation_id"] = conversation_id

        # `time.perf_counter()` — monotonic, high-resolution. Not
        # wall-clock time (which can jump backwards on NTP correction),
        # which is what latency reporting actually wants.
        start = time.perf_counter()

        def _elapsed_ms() -> float:
            return (time.perf_counter() - start) * 1000.0

        try:
            r = requests.post(url, json=payload, timeout=self.timeout_s)
        except requests.Timeout as e:
            return ApiError(kind="timeout", detail=str(e)), _elapsed_ms()
        except requests.ConnectionError as e:
            return ApiError(kind="unreachable", detail=str(e)), _elapsed_ms()
        except requests.RequestException as e:
            return ApiError(kind="bad-response", detail=str(e)), _elapsed_ms()

        if r.status_code == 404:
            return ApiError(
                kind="endpoint-not-implemented",
                detail=f"POST {url} returned 404 — /api/answer not implemented yet",
                status_code=404,
            ), _elapsed_ms()
        if r.status_code >= 500:
            return ApiError(
                kind="server-error",
                detail=f"{r.status_code}: {r.text[:200]}",
                status_code=r.status_code,
            ), _elapsed_ms()
        if r.status_code >= 400:
            return ApiError(
                kind="bad-response",
                detail=f"{r.status_code}: {r.text[:200]}",
                status_code=r.status_code,
            ), _elapsed_ms()

        try:
            data = r.json()
        except ValueError as e:
            return ApiError(kind="bad-response", detail=f"non-JSON body: {e}"), _elapsed_ms()

        try:
            return ApiResponse(**data), _elapsed_ms()
        except ValidationError as e:
            return ApiError(kind="bad-response", detail=f"response schema mismatch: {e}"), _elapsed_ms()
