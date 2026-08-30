"""Fixtures for Graph Explorer browser tests."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from playwright.sync_api import Browser, Page, sync_playwright


if TYPE_CHECKING:
    from collections.abc import Generator, Iterator


E2E_PROJECTS = {"chromium", "firefox", "webkit", "iphone", "ipad"}
_DEVICE_CONTEXT: dict[str, Any] = {}


@pytest.fixture(scope="session")
def test_server() -> Generator[str]:
    """Start the consumer-owned UI with an in-process mock Catalog API."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    server_url = f"http://127.0.0.1:{port}"
    process = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            "-m",
            "uvicorn",
            "tests.explore_test_app:create_test_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
            "--no-access-log",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    for _ in range(40):
        try:
            if httpx.get(f"{server_url}/health", timeout=2.0).status_code == 200:
                break
        except httpx.ConnectError, httpx.TimeoutException:
            pass
        time.sleep(0.5)
    else:
        process.terminate()
        stdout, stderr = process.communicate(timeout=5)
        raise RuntimeError(f"Test server failed to start.\nStdout: {stdout.decode()}\nStderr: {stderr.decode()}")

    yield server_url

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_makereport(item: pytest.Item) -> Iterator[None]:
    """Expose the call outcome to fixture teardown for failure artifacts."""
    outcome = yield
    report = outcome.get_result()
    setattr(item, f"rep_{report.when}", report)


@pytest.fixture(scope="session")
def browser_context_args(browser: Browser) -> dict[str, Any]:
    """Configure an accessible desktop or standard emulated-device context."""
    del browser
    defaults: dict[str, Any] = {
        "viewport": {"width": 1280, "height": 720},
        "ignore_https_errors": True,
        "locale": "en-US",
        "timezone_id": "UTC",
        "record_video_dir": f"test-results/{os.environ.get('GROOVEMAP_E2E_PROJECT', 'chromium')}/videos",
        "record_video_size": {"width": 1280, "height": 720},
    }
    defaults.update(_DEVICE_CONTEXT)
    return defaults


@pytest.fixture(scope="session")
def browser_type_launch_args() -> dict[str, Any]:
    """Run browsers headlessly in local and CI containers."""
    return {"headless": True, "timeout": 30_000}


@pytest.fixture(scope="session")
def browser(browser_type_launch_args: dict[str, Any]) -> Iterator[Browser]:
    """Launch the selected desktop browser or standard emulated WebKit device."""
    project = os.environ.get("GROOVEMAP_E2E_PROJECT", "chromium")
    if project not in E2E_PROJECTS:
        raise ValueError(f"Unknown GROOVEMAP_E2E_PROJECT: {project}")
    with sync_playwright() as playwright:
        engine_name = "webkit" if project in {"iphone", "ipad"} else project
        engine = getattr(playwright, engine_name)
        launch_args = dict(browser_type_launch_args)
        if engine_name == "chromium":
            launch_args["args"] = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        _DEVICE_CONTEXT.clear()
        if project in {"iphone", "ipad"}:
            device_name = "iPhone 15" if project == "iphone" else "iPad (gen 11)"
            _DEVICE_CONTEXT.update(playwright.devices[device_name])
            _DEVICE_CONTEXT.pop("default_browser_type", None)
        instance = engine.launch(**launch_args)
        yield instance
        instance.close()


def _note_e2e_cleanup_error(errors: list[Exception], phase: str, error: Exception) -> None:
    """Retain every independent teardown failure with its diagnostic phase."""
    error.add_note(f"graph-explorer E2E teardown phase: {phase}")
    errors.append(error)


def _finalize_e2e_page(
    request: pytest.FixtureRequest,
    instance: Page,
    context: Any,
    artifact_root: Path,
    project: str,
    node_digest: str,
) -> None:
    """Collect coverage and diagnostics and close even after a page crash."""
    errors: list[Exception] = []
    failed = bool(getattr(request.node, "rep_call", None) and request.node.rep_call.failed)
    retain_diagnostics = failed
    video = instance.video

    try:
        try:
            coverage = instance.evaluate("globalThis.__coverage__ || null")
            if coverage is not None:
                raw_root = Path("coverage/e2e/raw") / project
                raw_root.mkdir(parents=True, exist_ok=True)
                (raw_root / f"{node_digest}.json").write_text(json.dumps(coverage, sort_keys=True) + "\n")
        except Exception as error:
            retain_diagnostics = True
            _note_e2e_cleanup_error(errors, "coverage", error)

        if retain_diagnostics:
            try:
                instance.screenshot(path=artifact_root / f"{node_digest}.png", full_page=True)
            except Exception as error:
                _note_e2e_cleanup_error(errors, "screenshot", error)
    finally:
        try:
            try:
                trace_path = artifact_root / f"{node_digest}-trace.zip" if retain_diagnostics else None
                if trace_path:
                    context.tracing.stop(path=trace_path)
                else:
                    context.tracing.stop()
            except Exception as error:
                _note_e2e_cleanup_error(errors, "trace", error)
        finally:
            try:
                context.close()
            except Exception as error:
                _note_e2e_cleanup_error(errors, "context/video", error)
            else:
                if not retain_diagnostics and video is not None:
                    try:
                        video.delete()
                    except Exception as error:
                        _note_e2e_cleanup_error(errors, "video cleanup", error)

    if errors:
        raise ExceptionGroup("graph-explorer E2E teardown failed", errors)


@pytest.fixture
def page(request: pytest.FixtureRequest, browser: Browser, browser_context_args: dict[str, Any]) -> Iterator[Page]:
    """Create an isolated page and retain coverage plus failure diagnostics."""
    project = os.environ.get("GROOVEMAP_E2E_PROJECT", "chromium")
    artifact_root = Path("test-results") / project
    artifact_root.mkdir(parents=True, exist_ok=True)
    node_digest = hashlib.sha256(request.node.nodeid.encode()).hexdigest()[:16]
    context = browser.new_context(**browser_context_args)
    context.tracing.start(screenshots=True, snapshots=True, sources=True)
    instance = context.new_page()
    yield instance
    _finalize_e2e_page(request, instance, context, artifact_root, project, node_digest)
