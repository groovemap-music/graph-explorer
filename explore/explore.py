#!/usr/bin/env python3
"""GrooveMap's public graph exploration web application and Catalog API proxy."""

import asyncio
import os
import time
from collections.abc import AsyncGenerator  # noqa: TC003  # Required for runtime annotation evaluation.
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import structlog
import uvicorn
from common import (
    HealthServer,
    describe_exception,
    get_meter,
    instrument_fastapi_app,
    instrument_httpx,
    setup_logging,
    setup_telemetry,
    shutdown_telemetry,
)
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from explore import __version__


logger = structlog.get_logger(__name__)
SERVICE_NAME = "graph-explorer"

# OTEL service.name: the docker-compose service key, per the GrooveMap telemetry conventions.
# Deliberately distinct from SERVICE_NAME above, which identifies this process in logs.
_TELEMETRY_SERVICE_NAME = "explore"

STARTUP_BANNER = r"""
                    _                    _
 __ _ _ _ __ _ _ __| |_ ___ _____ ___ __| |___ _ _ ___ _ _
/ _` | '_/ _` | '_ \ ' \___/ -_) \ / '_ \ / _ \ '_/ -_) '_|
\__, |_| \__,_| .__/_||_|  \___/_\_\ .__/_\___/_| \___|_|
|___/         |_|                  |_|
                         graph-explorer
""".strip("\n")

# CORS origins configurable via environment variable (comma-separated list)
_cors_origins_raw = os.environ.get("CORS_ORIGINS", "")
_cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()] if _cors_origins_raw else None

# API service base URL for proxying /api/* requests
_api_base_url = os.environ.get("API_BASE_URL", "http://api:8004")


# Domain metric: the full duration of an /api/* proxy request, including the complete SSE
# stream when the response streams. Separate from the `http.client.request.duration` that
# `instrument_httpx` emits, which — because the proxy issues `client.send(req, stream=True)` —
# only covers the wait for response headers, not the time spent draining a streamed body.
_PROXY_DURATION_METRIC = "groovemap.explore.proxy.duration"
# Matches the FastAPI route pattern declared below (and what instrument_fastapi_app's own
# http.route attribute reports for it) verbatim, so both metrics agree on the templated value.
_PROXY_ROUTE = "/api/{path:path}"
_proxy_duration_histogram: Any | None = None


def _proxy_duration_instrument() -> Any:
    """Return the proxy-duration histogram, built lazily against the active provider.

    Deferred past import time so it binds to the MeterProvider `setup_telemetry` installs in
    `main()`, rather than to whatever was active when this module was first imported.
    """
    global _proxy_duration_histogram
    if _proxy_duration_histogram is None:
        meter = get_meter("groovemap.explore")
        _proxy_duration_histogram = meter.create_histogram(
            _PROXY_DURATION_METRIC,
            unit="s",
            description="Duration of a graph-explorer /api/* proxy request to catalog-api, including the full SSE stream.",
        )
    return _proxy_duration_histogram


def _record_proxy_duration(start: float, *, outcome: str) -> None:
    """Record one proxy request's duration. Never raises — telemetry must not break a request."""
    try:
        _proxy_duration_instrument().record(time.perf_counter() - start, {"http.route": _PROXY_ROUTE, "outcome": outcome})
    except Exception:
        logger.debug("Could not record proxy duration metric", exc_info=True)


def reset_proxy_telemetry() -> None:
    """Drop the cached proxy-duration instrument. Test seam only."""
    global _proxy_duration_histogram
    _proxy_duration_histogram = None


def get_health_data() -> dict[str, Any]:
    """Return health check data."""
    return {
        "status": "healthy",
        "service": SERVICE_NAME,
        "timestamp": datetime.now(UTC).isoformat(),
    }


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    """Manage application lifecycle."""
    logger.info("🚀 Starting GrooveMap graph-explorer")

    # Start health server on separate port
    health_server = HealthServer(8007, get_health_data)
    health_server.start_background()
    logger.info("🏥 Health server started on port 8007")

    # Initialize HTTP client during startup to avoid lazy-init race condition
    global _http_client
    _http_client = httpx.AsyncClient(base_url=_api_base_url, timeout=150.0)
    # Called after setup_telemetry (main() runs it before starting uvicorn) so this binds to
    # the configured provider. A no-op (returns False, logs once) without the otel-http extra.
    instrument_httpx(client=_http_client)

    logger.info("✅ GrooveMap graph-explorer ready")
    yield

    # Shutdown
    logger.info("🛑 Shutting down GrooveMap graph-explorer")
    if _http_client is not None:
        await _http_client.aclose()
    health_server.stop()
    logger.info("✅ GrooveMap graph-explorer shutdown complete")


app = FastAPI(
    title="GrooveMap Graph Explorer",
    version="0.1.0",
    default_response_class=JSONResponse,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins or ["http://localhost:3000", "http://localhost:8003"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


@app.get("/health")
async def health_check() -> JSONResponse:
    """Health check endpoint."""
    return JSONResponse(content=get_health_data())


# x-forwarded-for/-proto are stripped from the inbound request before forwarding:
# graph-explorer is the public edge, so any value a client sent for these is untrusted and
# must not be passed through verbatim (that would let an attacker spoof their
# apparent IP to the API and defeat per-IP rate limiting downstream). explore sets
# its own trustworthy values below, from what it actually observed as the peer.
_PROXY_SKIP_HEADERS = frozenset({"host", "content-length", "transfer-encoding", "x-forwarded-for", "x-forwarded-proto"})

# Content-Type prefix used by sse_starlette's EventSourceResponse (see
# api/routers/nlq.py) for the NLQ 'Ask' streaming endpoint.
_STREAMING_CONTENT_TYPE_PREFIX = "text/event-stream"

# Total budget for connect/write/pool, and the default read budget for every
# BUFFERED proxied response.
_PROXY_TIMEOUT_SECONDS = 150.0

# The only upstream paths that stream (SSE). The timeout has to be chosen before
# the response's content-type is known, so the read timeout may only be disabled
# for these — disabling it for every request meant a stalled upstream wedged a
# buffered request forever, pinning an httpx pool connection and a server task
# with no deadline until the pool was exhausted (legacy stalled-stream regression).
_STREAMING_PATHS = frozenset({"nlq/query"})

_http_client: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    if _http_client is None:
        msg = "HTTP client not initialized — service not started"
        raise RuntimeError(msg)
    return _http_client


def _is_streaming_path(path: str) -> bool:
    """Whether this upstream path returns an SSE stream."""
    return path.strip("/") in _STREAMING_PATHS


def _proxy_timeout(path: str) -> httpx.Timeout:
    """Build the per-request timeout, disabling the read budget for SSE only.

    An SSE response may legitimately go quiet between events for longer than the
    total timeout (e.g. a long Anthropic generation phase), so streaming paths
    get `read=None`. Every other path keeps a bounded read timeout: without it
    `client.send()`/`aread()` on a buffered response had no deadline at all, and
    a stalled-but-connected upstream (hung Neo4j query, half-open TCP after an
    OOM-kill) parked the request forever (legacy stalled-stream regression).
    """
    if _is_streaming_path(path):
        return httpx.Timeout(_PROXY_TIMEOUT_SECONDS, read=None)
    return httpx.Timeout(_PROXY_TIMEOUT_SECONDS)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_api(path: str, request: Request) -> Response:
    """Proxy /api/* requests to the API service.

    Uses a streamed httpx request/response instead of the non-streaming
    client.request()/.content, which used to buffer the ENTIRE upstream body
    before returning. That broke Server-Sent-Event endpoints (e.g. the NLQ 'Ask'
    endpoint /api/nlq/query): events were held back until the whole stream
    finished, and a long-running answer that went quiet between events for
    longer than the client's fixed total timeout was aborted with a 504,
    discarding an otherwise-successful response. text/event-stream responses are
    now forwarded chunk-by-chunk via StreamingResponse with the read timeout
    disabled; every other response is still read fully and returned as before.
    """
    start = time.perf_counter()
    client = _get_http_client()
    url = f"/api/{path}"
    forward_headers = {k: v for k, v in request.headers.items() if k.lower() not in _PROXY_SKIP_HEADERS}

    # Set trustworthy X-Forwarded-For/-Proto from what graph-explorer itself observed as the
    # TCP peer and request scheme — never from client-supplied headers (stripped above).
    # api/api.py trusts these only when they arrive from the internal docker network
    # (FORWARDED_ALLOW_IPS), so this is the sole source of per-client identity that
    # api's rate limiter (api/limiter.py get_remote_address) resolves. See
    # the forwarded-client-identity regression.
    client_host = request.client.host if request.client else None
    if client_host:
        forward_headers["x-forwarded-for"] = client_host
    forward_headers["x-forwarded-proto"] = request.url.scheme

    req = client.build_request(
        method=request.method,
        url=url,
        # request.query_params is a Starlette multi-dict — wrapping it in
        # dict() keeps only the LAST value per repeated key (e.g.
        # ?formats=Vinyl&formats=CD collapses to formats=CD), silently
        # dropping multi-value filters. Build an httpx.QueryParams from
        # the multi-item list so every repeated key is preserved.
        params=httpx.QueryParams(tuple(request.query_params.multi_items())),
        content=await request.body(),
        headers=forward_headers,
        # Read timeout disabled for SSE paths only — see _proxy_timeout.
        timeout=_proxy_timeout(path),
    )

    try:
        if _is_streaming_path(path):
            # The read timeout is disabled for this path, and httpx's read
            # timeout also covers waiting for the response HEADERS — so bound
            # the header phase explicitly. Otherwise an upstream that accepts
            # the connection and then stalls before responding parks this task
            # (and its pool connection) with no deadline at all.
            async with asyncio.timeout(_PROXY_TIMEOUT_SECONDS):
                proxied = await client.send(req, stream=True)
        else:
            proxied = await client.send(req, stream=True)
    except httpx.TimeoutException, TimeoutError:
        logger.warning("⚠️ Proxy request timed out", path=path)
        _record_proxy_duration(start, outcome="timeout")
        return JSONResponse(content={"error": "Request timed out"}, status_code=504)
    except httpx.HTTPError as exc:
        logger.error("❌ Proxy request failed", path=path, error=describe_exception(exc))
        _record_proxy_duration(start, outcome="upstream_error")
        return JSONResponse(content={"error": "Upstream service error"}, status_code=502)

    skip_response_headers = {"content-encoding", "transfer-encoding", "content-length"}
    response_headers = {k: v for k, v in proxied.headers.items() if k.lower() not in skip_response_headers}
    content_type = proxied.headers.get("content-type", "")

    if content_type.startswith(_STREAMING_CONTENT_TYPE_PREFIX):

        async def _forward_stream() -> AsyncGenerator[bytes]:
            # `instrument_httpx`'s http.client.request.duration only covers the wait for
            # headers (client.send(..., stream=True) returns before the body is read), so
            # this domain metric's own timer is what covers the full SSE stream duration.
            outcome = "success"
            try:
                async for chunk in proxied.aiter_raw():
                    yield chunk
            except httpx.HTTPError as exc:
                outcome = "upstream_error"
                logger.warning("⚠️ Proxy stream interrupted", path=path, error=describe_exception(exc))
            finally:
                await proxied.aclose()
                _record_proxy_duration(start, outcome=outcome)

        return StreamingResponse(_forward_stream(), status_code=proxied.status_code, headers=response_headers, media_type=content_type)

    try:
        await proxied.aread()
    except httpx.TimeoutException, TimeoutError:
        logger.warning("⚠️ Proxy request timed out", path=path)
        _record_proxy_duration(start, outcome="timeout")
        return JSONResponse(content={"error": "Request timed out"}, status_code=504)
    except httpx.HTTPError as exc:
        logger.error("❌ Proxy request failed", path=path, error=describe_exception(exc))
        _record_proxy_duration(start, outcome="upstream_error")
        return JSONResponse(content={"error": "Upstream service error"}, status_code=502)
    finally:
        # finally, not per-branch: a client disconnect cancels this task mid-read,
        # and the pool connection must be released on that path too.
        await proxied.aclose()

    _record_proxy_duration(start, outcome="success")
    return Response(content=proxied.content, status_code=proxied.status_code, headers=response_headers)


# Serve UI — must be mounted after all API routes so /health and /api/* take priority
app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")


def main() -> None:  # pragma: no cover
    """Entry point for GrooveMap graph-explorer."""
    setup_logging(SERVICE_NAME, log_file=Path("/logs/graph-explorer.log"))
    setup_telemetry(_TELEMETRY_SERVICE_NAME, service_version=__version__)
    # instrument_fastapi_app must run after setup_telemetry so it binds to the configured
    # provider; `app` already exists at module import time, ahead of this call.
    instrument_fastapi_app(app)
    print(STARTUP_BANNER)
    try:
        uvicorn.run(
            "explore.explore:app",
            host="0.0.0.0",  # noqa: S104  # nosec B104
            port=8006,
            reload=False,
            log_level=os.getenv("LOG_LEVEL", "INFO").lower(),
        )
    finally:
        shutdown_telemetry()


if __name__ == "__main__":
    main()
