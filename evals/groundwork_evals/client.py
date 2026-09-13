"""HTTP client for the Groundwork API.

Wraps `POST /api/answer` (Sprint 1 endpoint — doesn't exist yet in the
scaffold). Returns a `CallOutcome` that is either a validated
`ApiResponse` or a typed `ApiError`. The runner handles both.
"""

from __future__ import annotations

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


class ApiClient:
    """Minimal client. One method per API endpoint we call from evals."""

    def __init__(self, base_url: str, timeout_s: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def answer(self, query: str, conversation_id: str | None = None) -> CallOutcome:
        url = f"{self.base_url}/api/answer"
        payload: dict[str, str] = {"query": query}
        if conversation_id:
            payload["conversation_id"] = conversation_id

        try:
            r = requests.post(url, json=payload, timeout=self.timeout_s)
        except requests.Timeout as e:
            return ApiError(kind="timeout", detail=str(e))
        except requests.ConnectionError as e:
            return ApiError(kind="unreachable", detail=str(e))
        except requests.RequestException as e:
            return ApiError(kind="bad-response", detail=str(e))

        if r.status_code == 404:
            return ApiError(
                kind="endpoint-not-implemented",
                detail=f"POST {url} returned 404 — /api/answer not implemented yet",
                status_code=404,
            )
        if r.status_code >= 500:
            return ApiError(
                kind="server-error",
                detail=f"{r.status_code}: {r.text[:200]}",
                status_code=r.status_code,
            )
        if r.status_code >= 400:
            return ApiError(
                kind="bad-response",
                detail=f"{r.status_code}: {r.text[:200]}",
                status_code=r.status_code,
            )

        try:
            data = r.json()
        except ValueError as e:
            return ApiError(kind="bad-response", detail=f"non-JSON body: {e}")

        try:
            return ApiResponse(**data)
        except ValidationError as e:
            return ApiError(kind="bad-response", detail=f"response schema mismatch: {e}")
