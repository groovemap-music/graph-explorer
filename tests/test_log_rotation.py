"""Log-file rotation contract for the sink `explore.explore.main()` installs.

`main()` calls `setup_logging(SERVICE_NAME, log_file=Path("/logs/graph-explorer.log"))`
(asserted verbatim by `tests/test_service.py::test_startup_identity_is_repository_specific`).
These tests call the same `groovemap-runtime` function, on the same call path, against a
temporary log file to prove the handler it builds for that file sink is a size-capped
`RotatingFileHandler` — not the unbounded `FileHandler` the pre-9bac022 runtime installed —
and that `LOG_FILE_MAX_BYTES` / `LOG_FILE_BACKUP_COUNT` retune it exactly as
`docs/configuration.md` documents.
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from typing import TYPE_CHECKING

import pytest

from explore import explore as service


if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path


@pytest.fixture(autouse=True)
def _restore_root_logging() -> Iterator[None]:
    """`setup_logging` reconfigures the root logger with `force=True`; undo that after each test."""
    root = logging.getLogger()
    previous_handlers = list(root.handlers)
    previous_level = root.level
    try:
        yield
    finally:
        for handler in root.handlers:
            if handler not in previous_handlers:
                handler.close()
        root.handlers = previous_handlers
        root.setLevel(previous_level)


def _installed_file_handler() -> RotatingFileHandler:
    file_handlers = [handler for handler in logging.getLogger().handlers if isinstance(handler, logging.FileHandler)]
    assert len(file_handlers) == 1, "setup_logging(..., log_file=...) should install exactly one file handler"
    handler = file_handlers[0]
    assert isinstance(handler, RotatingFileHandler)
    return handler


def test_service_log_file_sink_is_a_size_capped_rotating_handler(tmp_path: Path) -> None:
    """The handler main() installs for /logs/graph-explorer.log rotates rather than growing forever."""
    log_file = tmp_path / "graph-explorer.log"

    service.setup_logging(service.SERVICE_NAME, log_file=log_file)

    handler = _installed_file_handler()
    # Defaults documented in docs/configuration.md's LOG_FILE_MAX_BYTES / LOG_FILE_BACKUP_COUNT rows.
    assert handler.maxBytes == 104857600
    assert handler.backupCount == 5


def test_service_log_file_sink_honors_deployment_overrides(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """LOG_FILE_MAX_BYTES / LOG_FILE_BACKUP_COUNT retune the same handler main() installs, and rollover behaves."""
    # Sized for this handler's structlog JSON records (~170 bytes each with a 10-char
    # message): small enough that 100 records force several rollovers, large enough that
    # no single JSON-formatted record exceeds the cap on its own.
    max_bytes = 2048
    backup_count = 2
    monkeypatch.setenv("LOG_FILE_MAX_BYTES", str(max_bytes))
    monkeypatch.setenv("LOG_FILE_BACKUP_COUNT", str(backup_count))
    log_file = tmp_path / "graph-explorer.log"

    service.setup_logging(service.SERVICE_NAME, log_file=log_file)

    handler = _installed_file_handler()
    assert handler.maxBytes == max_bytes
    assert handler.backupCount == backup_count

    logger = logging.getLogger("graph-explorer-rotation-test")
    for _ in range(100):
        logger.info("x" * 10)
    handler.flush()

    rotated = sorted(tmp_path.glob("graph-explorer.log*"))
    assert log_file.with_suffix(".log.1") in rotated
    assert len(rotated) == backup_count + 1
    assert all(path.stat().st_size <= max_bytes for path in rotated)
