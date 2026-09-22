from __future__ import annotations

import responses

from groundwork_evals.client import ApiClient, ApiError
from groundwork_evals.schema import ApiResponse


@responses.activate
def test_answer_success():
    responses.post(
        "https://api.test/api/answer",
        json={
            "answer": "hello",
            "citations": [{"chunk_id": "c1"}],
            "retrieved_chunk_ids": ["c1", "c2"],
        },
        status=200,
    )
    client = ApiClient("https://api.test")
    out, latency_ms = client.answer("q")
    assert isinstance(out, ApiResponse)
    assert out.answer == "hello"
    assert out.citations[0].chunk_id == "c1"
    # Latency always reported; wall-clock so any positive value is fine.
    # A single mocked local request should be well under 1 second.
    assert 0.0 < latency_ms < 1000.0


@responses.activate
def test_answer_404_returns_endpoint_not_implemented():
    responses.post("https://api.test/api/answer", body="not found", status=404)
    client = ApiClient("https://api.test")
    out, latency_ms = client.answer("q")
    assert isinstance(out, ApiError)
    assert out.kind == "endpoint-not-implemented"
    assert latency_ms >= 0.0


@responses.activate
def test_answer_500_returns_server_error():
    responses.post("https://api.test/api/answer", body="boom", status=500)
    client = ApiClient("https://api.test")
    out, latency_ms = client.answer("q")
    assert isinstance(out, ApiError)
    assert out.kind == "server-error"
    assert latency_ms >= 0.0


@responses.activate
def test_answer_non_json_body_returns_bad_response():
    responses.post("https://api.test/api/answer", body="<html>", status=200)
    client = ApiClient("https://api.test")
    out, latency_ms = client.answer("q")
    assert isinstance(out, ApiError)
    assert out.kind == "bad-response"
    assert latency_ms >= 0.0
