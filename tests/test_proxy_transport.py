"""Focused tests for proxy construction boundaries."""

import httpx
import pytest
from starlette.requests import Request

from explore.proxy_transport import build_upstream_request, forwarded_headers, response_headers
from explore.runtime_config import RuntimeConfig


def _request(*, query: bytes = b"", headers: list[tuple[bytes, bytes]] | None = None) -> Request:
    async def receive() -> dict[str, object]:
        return {"type": "http.request", "body": b"payload", "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/search",
            "query_string": query,
            "headers": headers or [],
            "scheme": "https",
            "client": ("203.0.113.10", 4444),
            "server": ("example.test", 443),
        },
        receive,
    )


def test_runtime_config_reads_and_normalizes_environment_at_construction() -> None:
    config = RuntimeConfig.from_environment({"API_BASE_URL": "http://catalog:8004", "CORS_ORIGINS": " https://one.test,https://two.test "})
    assert config.api_base_url == "http://catalog:8004"
    assert config.cors_origins == ("https://one.test", "https://two.test")


def test_forwarded_headers_replace_untrusted_client_values() -> None:
    headers = forwarded_headers(_request(headers=[(b"x-forwarded-for", b"spoofed"), (b"x-extra", b"kept")]))
    assert headers == {
        "x-extra": "kept",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
    }


@pytest.mark.asyncio
async def test_build_upstream_request_preserves_repeated_query_values() -> None:
    async with httpx.AsyncClient(base_url="http://catalog") as client:
        upstream = await build_upstream_request(client, "search", _request(query=b"media=vinyl&media=tape"))
    assert upstream.url.params.get_list("media") == ["vinyl", "tape"]
    assert upstream.content == b"payload"


def test_response_headers_strip_transport_owned_metadata() -> None:
    assert response_headers({"content-type": "application/json", "content-encoding": "gzip", "content-length": "2"}) == {
        "content-type": "application/json"
    }
