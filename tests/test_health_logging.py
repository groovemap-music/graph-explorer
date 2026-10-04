"""Structured deployment context emitted by the real health-server writer."""

from __future__ import annotations

import io
import json
import logging
import time
from contextlib import redirect_stdout
from typing import TYPE_CHECKING, Any

import pytest
import structlog

from explore import explore as service


if TYPE_CHECKING:
    from collections.abc import Iterator


@pytest.fixture(autouse=True)
def _restore_logging_state() -> Iterator[None]:
    """Restore process-global stdlib and structlog state after each test."""
    root = logging.getLogger()
    previous_handlers = root.handlers[:]
    previous_level = root.level
    previous_structlog = structlog.get_config().copy()
    previous_context = structlog.contextvars.get_contextvars()
    structlog.contextvars.clear_contextvars()
    yield
    for handler in root.handlers:
        if handler not in previous_handlers:
            handler.close()
    root.handlers = previous_handlers
    root.setLevel(previous_level)
    structlog.configure(**previous_structlog)
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(**previous_context)


def _health_startup_record(environment: str | None, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Capture the actual background-thread startup record as decoded JSON."""
    if environment is None:
        monkeypatch.delenv("ENVIRONMENT", raising=False)
    else:
        monkeypatch.setenv("ENVIRONMENT", environment)

    output = io.StringIO()
    with redirect_stdout(output):
        service.setup_logging(service.SERVICE_NAME)
    structlog.contextvars.bind_contextvars(correlation_id="caller-context")
    server = service.HealthServer(0, lambda: {"status": "healthy"})
    try:
        server.start_background()
        deadline = time.monotonic() + 2
        while "Health server listening" not in output.getvalue() and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        server.stop()

    return next(json.loads(line) for line in output.getvalue().splitlines() if "Health server listening" in line)


def test_health_background_log_has_production_deployment_context(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deployed configuration survives the HealthServer's fresh thread."""
    record = _health_startup_record("production", monkeypatch)

    assert record["service"] == service.SERVICE_NAME
    assert record["environment"] == "production"
    assert "correlation_id" not in record


def test_health_background_log_preserves_default_and_event_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unset deployments keep their documented default and formatter fields."""
    record = _health_startup_record(None, monkeypatch)

    assert record["environment"] == "development"
    assert record["event"].startswith("🏥 Health server listening on port ")
    assert record["logger"] == "common.health_server"
    assert record["level"] == "info"
    assert isinstance(record["timestamp"], str)
    assert isinstance(record["lineno"], int)
