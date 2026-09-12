"""Request construction and response metadata for the Catalog API proxy."""

from __future__ import annotations

from typing import TYPE_CHECKING

import httpx


if TYPE_CHECKING:
    from collections.abc import Mapping

    from starlette.requests import Request


PROXY_SKIP_HEADERS = frozenset({"host", "content-length", "transfer-encoding", "x-forwarded-for", "x-forwarded-proto"})
STREAMING_CONTENT_TYPE_PREFIX = "text/event-stream"
PROXY_TIMEOUT_SECONDS = 150.0
STREAMING_PATHS = frozenset({"nlq/query"})
SKIP_RESPONSE_HEADERS = frozenset({"content-encoding", "transfer-encoding", "content-length"})


def is_streaming_path(path: str) -> bool:
    return path.strip("/") in STREAMING_PATHS


def proxy_timeout(path: str) -> httpx.Timeout:
    if is_streaming_path(path):
        return httpx.Timeout(PROXY_TIMEOUT_SECONDS, read=None)
    return httpx.Timeout(PROXY_TIMEOUT_SECONDS)


def forwarded_headers(request: Request) -> dict[str, str]:
    headers = {key: value for key, value in request.headers.items() if key.lower() not in PROXY_SKIP_HEADERS}
    if request.client:
        headers["x-forwarded-for"] = request.client.host
    headers["x-forwarded-proto"] = request.url.scheme
    return headers


async def build_upstream_request(client: httpx.AsyncClient, path: str, request: Request) -> httpx.Request:
    return client.build_request(
        method=request.method,
        url=f"/api/{path}",
        params=httpx.QueryParams(tuple(request.query_params.multi_items())),
        content=await request.body(),
        headers=forwarded_headers(request),
        timeout=proxy_timeout(path),
    )


def response_headers(headers: Mapping[str, str]) -> dict[str, str]:
    return {key: value for key, value in headers.items() if key.lower() not in SKIP_RESPONSE_HEADERS}
