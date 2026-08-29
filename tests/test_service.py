"""Unit tests for the standalone Graph Explorer proxy service."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from explore import explore as service


@pytest.fixture
def test_client() -> TestClient:
    with patch.object(service, "HealthServer") as health_server:
        health_server.return_value = MagicMock()
        with TestClient(service.app, raise_server_exceptions=False) as client:
            yield client


def _buffered_client(
    *,
    status: int = 200,
    content: bytes = b"{}",
    headers: dict[str, str] | None = None,
) -> tuple[AsyncMock, MagicMock]:
    response = MagicMock()
    response.status_code = status
    response.content = content
    response.headers = headers or {"content-type": "application/json"}
    response.aread = AsyncMock()
    response.aclose = AsyncMock()
    client = AsyncMock(spec=httpx.AsyncClient)
    client.build_request = MagicMock(return_value=MagicMock())
    client.send = AsyncMock(return_value=response)
    return client, response


def test_health_data_is_service_specific() -> None:
    data = service.get_health_data()
    assert data["status"] == "healthy"
    assert data["service"] == "explore"
    datetime.fromisoformat(data["timestamp"])


@pytest.mark.parametrize(("path", "expected"), [("nlq/query", True), ("/nlq/query/", True), ("search", False)])
def test_streaming_path_allowlist(path: str, expected: bool) -> None:
    assert service._is_streaming_path(path) is expected


def test_streaming_timeout_disables_read_only_for_sse() -> None:
    assert service._proxy_timeout("nlq/query").read is None
    assert service._proxy_timeout("search").read == service._PROXY_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_proxy_preserves_repeated_query_values_and_sets_forwarded_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    observed: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        observed["request"] = request
        return httpx.Response(200, json={"ok": True}, request=request)

    async with httpx.AsyncClient(base_url="http://catalog-api", transport=httpx.MockTransport(handler)) as client:
        monkeypatch.setattr(service, "_http_client", client)

        async def receive() -> dict[str, object]:
            return {"type": "http.request", "body": b"", "more_body": False}

        request = Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/search",
                "query_string": b"formats=Vinyl&formats=CD",
                "headers": [(b"x-forwarded-for", b"spoofed")],
                "scheme": "https",
                "client": ("203.0.113.10", 4444),
                "server": ("example.test", 443),
            },
            receive,
        )
        response = await service.proxy_api("search", request)

    upstream = observed["request"]
    assert isinstance(upstream, httpx.Request)
    assert upstream.url.params.get_list("formats") == ["Vinyl", "CD"]
    assert upstream.headers["x-forwarded-for"] == "203.0.113.10"
    assert upstream.headers["x-forwarded-proto"] == "https"
    assert response.status_code == 200


def test_http_client_guard_rejects_pre_lifespan_use() -> None:
    with patch.object(service, "_http_client", None), pytest.raises(RuntimeError, match="not initialized"):
        service._get_http_client()


def test_buffered_proxy_uses_streaming_send_and_closes_response(test_client: TestClient) -> None:
    client, upstream = _buffered_client()
    with patch.object(service, "_get_http_client", return_value=client):
        response = test_client.get("/api/autocomplete?q=radio&type=artist")
    assert response.status_code == 200
    client.send.assert_awaited_once()
    assert client.send.call_args.kwargs["stream"] is True
    upstream.aread.assert_awaited_once()
    upstream.aclose.assert_awaited_once()


@pytest.mark.parametrize(
    ("exception", "status", "message"),
    [
        (httpx.ReadTimeout("stalled"), 504, "Request timed out"),
        (httpx.ReadError("reset"), 502, "Upstream service error"),
    ],
)
def test_buffered_read_failures_close_upstream(
    test_client: TestClient,
    exception: httpx.HTTPError,
    status: int,
    message: str,
) -> None:
    client, upstream = _buffered_client()
    upstream.aread.side_effect = exception
    with patch.object(service, "_get_http_client", return_value=client):
        response = test_client.get("/api/autocomplete?q=radio")
    assert response.status_code == status
    assert response.json()["error"] == message
    upstream.aclose.assert_awaited_once()


@pytest.mark.parametrize(
    ("exception", "status"),
    [(httpx.TimeoutException("timeout"), 504), (httpx.ConnectError("refused"), 502)],
)
def test_upstream_send_failures_are_mapped(test_client: TestClient, exception: httpx.HTTPError, status: int) -> None:
    client, _ = _buffered_client()
    client.send.side_effect = exception
    with patch.object(service, "_get_http_client", return_value=client):
        response = test_client.get("/api/autocomplete?q=radio")
    assert response.status_code == status


def test_proxy_strips_hop_by_hop_response_headers(test_client: TestClient) -> None:
    client, _ = _buffered_client(
        headers={
            "content-type": "application/json",
            "content-encoding": "gzip",
            "transfer-encoding": "chunked",
            "content-length": "2",
        }
    )
    with patch.object(service, "_get_http_client", return_value=client):
        response = test_client.get("/api/test")
    assert "content-encoding" not in response.headers
    assert "transfer-encoding" not in response.headers
    assert response.headers["content-length"] == "2"


def test_proxy_streams_sse_and_closes_upstream(test_client: TestClient) -> None:
    async def chunks():
        yield b"event: status\ndata: {}\n\n"
        yield b"event: result\ndata: {}\n\n"

    client, upstream = _buffered_client(headers={"content-type": "text/event-stream"})
    upstream.aiter_raw = MagicMock(return_value=chunks())
    with patch.object(service, "_get_http_client", return_value=client):
        response = test_client.post("/api/nlq/query", json={"question": "who?"})
    assert response.status_code == 200
    assert response.content == b"event: status\ndata: {}\n\nevent: result\ndata: {}\n\n"
    upstream.aread.assert_not_awaited()
    upstream.aclose.assert_awaited_once()
