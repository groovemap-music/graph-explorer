"""OpenTelemetry metrics contracts for graph-explorer.

Every test here installs an in-memory MeterProvider (mirroring the pattern
`groovemap-runtime`'s own test suite uses) so assertions read back exactly what the proxy
recorded, rather than trusting the shape by inspection.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from common import telemetry
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics import MeterProvider as SdkMeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from starlette.requests import Request

from explore import explore as service


if TYPE_CHECKING:
    from collections.abc import Iterator

    from opentelemetry.sdk.metrics.export import Metric


SERVER_DURATION_METRIC = "http.server.request.duration"
CLIENT_DURATION_METRIC = "http.client.request.duration"


class Collector:
    """An in-memory provider plus helpers for reading what was recorded."""

    def __init__(self) -> None:
        self.reader = InMemoryMetricReader()
        self.provider = SdkMeterProvider(metric_readers=[self.reader])

    def metrics(self) -> dict[str, Metric]:
        data = self.reader.get_metrics_data()
        if data is None:
            return {}
        return {
            metric.name: metric
            for resource_metrics in data.resource_metrics
            for scope_metrics in resource_metrics.scope_metrics
            for metric in scope_metrics.metrics
        }

    def points(self, name: str) -> list[Any]:
        metric = self.metrics().get(name)
        return [] if metric is None else list(metric.data.data_points)


@pytest.fixture
def collector(monkeypatch: pytest.MonkeyPatch) -> Iterator[Collector]:
    """Install an in-memory provider and reset graph-explorer's own lazily-built instrument."""
    active = Collector()
    monkeypatch.setattr(telemetry, "_provider", active.provider)
    service.reset_proxy_telemetry()
    assert telemetry._active_provider() is active.provider
    yield active
    monkeypatch.setattr(telemetry, "_provider", None)
    service.reset_proxy_telemetry()


@pytest.fixture
def test_client() -> Iterator[TestClient]:
    with patch.object(service, "HealthServer") as health_server:
        health_server.return_value = MagicMock()
        with TestClient(service.app, raise_server_exceptions=False) as client:
            yield client


def _isolated_app() -> FastAPI:
    """A throwaway app exposing the production proxy + static routes for instrumentation
    tests, so `instrument_fastapi_app` — which refuses a second call on the same app — is
    never asked to double-instrument the shared `service.app` singleton other test modules
    reuse."""
    app = FastAPI(default_response_class=service.JSONResponse)
    app.add_api_route("/api/{path:path}", service.proxy_api, methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    app.mount("/", StaticFiles(directory=Path(service.__file__).parent / "static", html=True), name="static")
    return app


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


def _request(path: str = "/api/search", query: bytes = b"") -> Request:
    async def receive() -> dict[str, object]:
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "query_string": query,
            "headers": [],
            "scheme": "http",
            "client": ("203.0.113.10", 4444),
            "server": ("example.test", 80),
        },
        receive,
    )


def test_setup_telemetry_with_no_endpoint_leaves_proxy_behavior_unchanged() -> None:
    """Regression: with OTEL_EXPORTER_OTLP_ENDPOINT unset (scrubbed by the autouse conftest
    fixture), calling setup_telemetry must not fail startup or change proxy behavior."""
    provider = service.setup_telemetry("explore")
    assert provider is not None
    try:
        client, _upstream = _buffered_client()
        with patch.object(service, "_get_http_client", return_value=client):
            response = asyncio.run(service.proxy_api("search", _request()))
        assert response.status_code == 200
        assert response.body == b"{}"
    finally:
        service.shutdown_telemetry()


def test_fastapi_instrumentation_reports_templated_routes_never_raw_paths(collector: Collector) -> None:
    """instrument_fastapi_app must report the templated proxy route, and never a raw path
    for the static mount, which has no route template to report at all."""
    app = _isolated_app()
    assert service.instrument_fastapi_app(app) is True

    client, _ = _buffered_client()
    with patch.object(service, "_get_http_client", return_value=client), TestClient(app, raise_server_exceptions=False) as tc:
        static_response = tc.get("/some/deep/static/path.js")
        proxy_response = tc.get("/api/search?q=vinyl")

    assert static_response.status_code == 404
    assert proxy_response.status_code == 200

    points = collector.points(SERVER_DURATION_METRIC)
    attribute_sets = [dict(point.attributes) for point in points]

    proxy_points = [attrs for attrs in attribute_sets if attrs.get("http.route") == service._PROXY_ROUTE]
    assert len(proxy_points) == 1
    assert proxy_points[0]["http.response.status_code"] == 200

    static_points = [attrs for attrs in attribute_sets if "http.route" not in attrs]
    assert static_points, "the static mount must never report the raw request path as http.route"
    assert static_points[0]["http.response.status_code"] == 404
    assert all("/some/deep/static/path.js" not in str(value) for value in static_points[0].values())


@pytest.mark.asyncio
async def test_instrument_httpx_emits_client_duration_for_the_shared_client(collector: Collector) -> None:
    """instrument_httpx, applied to the shared AsyncClient as lifespan() does, must emit
    http.client.request.duration toward catalog-api."""

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True}, request=request)

    async with httpx.AsyncClient(base_url="http://catalog-api", transport=httpx.MockTransport(handler)) as real_client:
        assert service.instrument_httpx(client=real_client) is True
        with patch.object(service, "_get_http_client", return_value=real_client):
            response = await service.proxy_api("search", _request())
        assert response.status_code == 200

    points = collector.points(CLIENT_DURATION_METRIC)
    assert points, "instrument_httpx must emit http.client.request.duration for the shared client"


@pytest.mark.asyncio
async def test_domain_proxy_duration_records_success_outcome(collector: Collector) -> None:
    client, _ = _buffered_client()
    with patch.object(service, "_get_http_client", return_value=client):
        response = await service.proxy_api("search", _request())
    assert response.status_code == 200

    points = collector.points(service._PROXY_DURATION_METRIC)
    assert len(points) == 1
    assert dict(points[0].attributes) == {"http.route": service._PROXY_ROUTE, "outcome": "success"}
    assert points[0].sum >= 0


@pytest.mark.asyncio
async def test_domain_proxy_duration_records_send_timeout(collector: Collector) -> None:
    client, _ = _buffered_client()
    client.send.side_effect = httpx.TimeoutException("timeout")
    with patch.object(service, "_get_http_client", return_value=client):
        response = await service.proxy_api("search", _request())
    assert response.status_code == 504

    points = collector.points(service._PROXY_DURATION_METRIC)
    assert len(points) == 1
    assert dict(points[0].attributes) == {"http.route": service._PROXY_ROUTE, "outcome": "timeout"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("exception", "expected_outcome"),
    [
        (httpx.ReadTimeout("stalled"), "timeout"),
        (httpx.ReadError("reset"), "upstream_error"),
    ],
)
async def test_domain_proxy_duration_records_buffered_read_failure_outcomes(
    collector: Collector,
    exception: httpx.HTTPError,
    expected_outcome: str,
) -> None:
    client, upstream = _buffered_client()
    upstream.aread.side_effect = exception
    with patch.object(service, "_get_http_client", return_value=client):
        response = await service.proxy_api("search", _request())
    assert response.status_code in (502, 504)

    points = collector.points(service._PROXY_DURATION_METRIC)
    assert len(points) == 1
    assert dict(points[0].attributes) == {"http.route": service._PROXY_ROUTE, "outcome": expected_outcome}


@pytest.mark.asyncio
async def test_domain_proxy_duration_recording_failure_never_breaks_the_request(collector: Collector) -> None:
    """Telemetry must never turn a working proxy request into a failure."""
    client, _ = _buffered_client()
    with (
        patch.object(service, "_get_http_client", return_value=client),
        patch.object(service, "_proxy_duration_instrument", side_effect=RuntimeError("boom")),
    ):
        response = await service.proxy_api("search", _request())
    assert response.status_code == 200
    assert collector.points(service._PROXY_DURATION_METRIC) == []


def test_domain_proxy_duration_covers_the_full_sse_stream(collector: Collector, test_client: TestClient) -> None:
    """The domain metric's timer must span the whole stream, not just the wait for headers —
    unlike http.client.request.duration, which (because the proxy sends with stream=True)
    only covers time-to-headers."""

    async def chunks() -> Any:
        yield b"event: status\ndata: {}\n\n"
        await asyncio.sleep(0.05)
        yield b"event: result\ndata: {}\n\n"

    client, upstream = _buffered_client(headers={"content-type": "text/event-stream"})
    upstream.aiter_raw = MagicMock(return_value=chunks())
    with patch.object(service, "_get_http_client", return_value=client):
        response = test_client.post("/api/nlq/query", json={"question": "who?"})
    assert response.status_code == 200

    points = collector.points(service._PROXY_DURATION_METRIC)
    assert len(points) == 1
    assert dict(points[0].attributes) == {"http.route": service._PROXY_ROUTE, "outcome": "success"}
    assert points[0].sum >= 0.05


def test_domain_proxy_duration_records_upstream_error_outcome_for_interrupted_stream(
    collector: Collector,
    test_client: TestClient,
) -> None:
    async def failing_chunks() -> Any:
        yield b"event: status\ndata: {}\n\n"
        raise httpx.ReadError("reset mid-stream")

    client, upstream = _buffered_client(headers={"content-type": "text/event-stream"})
    upstream.aiter_raw = MagicMock(return_value=failing_chunks())
    with patch.object(service, "_get_http_client", return_value=client):
        response = test_client.post("/api/nlq/query", json={"question": "who?"})
    assert response.status_code == 200
    assert response.content == b"event: status\ndata: {}\n\n"

    points = collector.points(service._PROXY_DURATION_METRIC)
    assert len(points) == 1
    assert dict(points[0].attributes) == {"http.route": service._PROXY_ROUTE, "outcome": "upstream_error"}
