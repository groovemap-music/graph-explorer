"""Unit tests for the standalone Graph Explorer proxy service."""

from datetime import datetime

import httpx
import pytest
from starlette.requests import Request

from explore import explore as service


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
