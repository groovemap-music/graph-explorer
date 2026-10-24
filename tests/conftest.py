"""Fixtures for Graph Explorer tests: browser E2E plus OpenTelemetry isolation."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager, nullcontext, suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright


if TYPE_CHECKING:
    from collections.abc import Callable, Generator, Iterator
    from contextlib import AbstractContextManager


E2E_PROJECTS = {"chromium", "firefox", "webkit", "iphone", "ipad"}
_DEVICE_CONTEXT: dict[str, Any] = {}

# WebKit spends a per-browser-process budget every time a context loads a page over the network,
# and closing the context does not give it back. Measured against the WebKit that Playwright 1.62
# bundles: the 64th context created in one launch is still created, but every navigation from it
# times out while the server keeps answering. Chromium and Firefox show no such ceiling. The
# matrix drives 126 E2E tests through one browser per project, so the `webkit`, `iphone` and
# `ipad` projects used to die at test 64 and stay dead for the rest of the session.
#
# The fix is to retire the browser process before its budget is spent. Half the ceiling leaves
# room for the suite to grow and for the ceiling to be lower on another host or Playwright build,
# and costs one relaunch roughly every 32 tests.
WEBKIT_CONTEXT_CEILING = 64
E2E_CONTEXTS_PER_BROWSER = 32

# Retiring a browser is only safe while no context is still open on it, and one context per test
# is the whole design: the page fixture opens exactly one and closes it in teardown, so the live
# count is 1 inside a test and 0 between tests. Anything more is a context that outlived its test.
# This tripwire fails the next test to ask for a context, and names the tests that leaked, rather
# than letting the session drift into the engine ceiling and fail somewhere unrelated.
E2E_LIVE_CONTEXT_BUDGET = 8

# Headless Firefox on Linux draws WebGL through GLX, so it needs an X server even though it opens no
# window. With none, nothing can create a GL context: the `glxtest` probe Firefox forks at launch
# fails, every WebGL2 context is refused ("AllowWebgl2:false restricts context creation on this
# system"), and `webgl.force-enabled` only moves the refusal to "tryNativeGL ... Exhausted GL driver
# options". A CI runner has no display, so on the Firefox project every Discography Strata and Genre
# Atlas journey that draws the 3D view failed, while the same journeys passed on the other four.
# Measured in mcr.microsoft.com/playwright/python:v1.64.0-noble with Playwright's Firefox 157: with
# no DISPLAY there is no WebGL under any pref or Mesa/EGL variable tried; with DISPLAY on an Xvfb
# server, headless Firefox gets WebGL2 on Mesa's llvmpipe. So the session starts a private Xvfb for
# Firefox when there is no display (`playwright install --with-deps` installs it), and fails rather
# than skipping when it cannot: a Firefox run with no WebGL would test only the fallback message.
#
# `webgl.force-enabled` stays as well. The probe has 4 seconds (GFX_TEST_TIMEOUT in
# widget/gtk/GfxInfo.cpp) to answer against that display, and a loaded runner can miss the deadline;
# the pref skips that verdict (WebGLContext::CreateAndInitGL) and creates the context directly.
FIREFOX_E2E_PREFS: dict[str, Any] = {"webgl.force-enabled": True}
FIREFOX_XVFB_SCREEN = "1280x1024x24"

# Every standard OpenTelemetry variable that changes what the SDK records or exports, for both
# signals. The telemetry suite asserts on what in-memory providers recorded, so it must not
# inherit the ambient configuration — CI runners in particular may set OTEL_SDK_DISABLED=true to
# keep their own instrumentation quiet, which would otherwise make those assertions fail
# silently, and an inherited OTEL_TRACES_SAMPLER_ARG=0 would drop every span a test expects.
_OTEL_ENVIRONMENT = (
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TIMEOUT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_METRICS_EXEMPLAR_FILTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_PROPAGATORS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_SDK_DISABLED",
    "OTEL_SERVICE_NAME",
    "OTEL_TRACES_EXPORTER",
    "OTEL_TRACES_SAMPLER",
    "OTEL_TRACES_SAMPLER_ARG",
)


@pytest.fixture(autouse=True)
def isolated_otel_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run every test against a known-empty OpenTelemetry configuration."""
    for name in _OTEL_ENVIRONMENT:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(scope="session")
def test_server() -> Generator[str]:
    """Start the consumer-owned UI with an in-process mock Catalog API."""
    # The browser projects run as concurrent sessions. Picking a free port here and letting the
    # server bind it later would leave a window in which another session is handed the same port.
    # The session binds and listens on the socket itself and the server inherits it, so the port is
    # this session's from the moment it exists.
    with socket.create_server(("127.0.0.1", 0)) as listener:
        port = listener.getsockname()[1]
        process = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "tests.explore_test_app", str(listener.fileno())],
            pass_fds=(listener.fileno(),),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    server_url = f"http://127.0.0.1:{port}"
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
def browser_context_args(browser_engine: Callable[[], Browser]) -> dict[str, Any]:
    """Configure an accessible desktop or standard emulated-device context."""
    del browser_engine
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


class BrowserContextBudgetError(RuntimeError):
    """A browser context outlived its test, or too many are open at once to continue safely."""


class BrowserContextSupply:
    """Hand one context to each test, and retire the browser process before WebKit's budget runs out.

    Contexts are the unit every E2E test is isolated by, and every one of them costs a slice of a
    per-browser-process budget that WebKit never refunds. This is the single place that knows how
    many have been spent, which test owns each open one, and when the browser has to be replaced.
    """

    def __init__(self, launch: Callable[[], Browser]) -> None:
        self._launch = launch
        self._browser: Browser | None = None
        self._contexts_created = 0
        self._owners: dict[int, str] = {}

    @property
    def browser(self) -> Browser:
        """Return the browser currently serving contexts, launching one on first use."""
        if self._browser is None:
            self._browser = self._launch()
            self._contexts_created = 0
        return self._browser

    def _live_contexts(self) -> list[BrowserContext]:
        """Ask the browser what is open instead of trusting this object's own bookkeeping."""
        return [] if self._browser is None else list(self._browser.contexts)

    def _owner_list(self, contexts: list[BrowserContext]) -> str:
        owners = sorted({self._owners.get(id(context), "<opened outside the page fixture>") for context in contexts})
        return "\n".join(f"  - {owner}" for owner in owners)

    def _refuse_when_contexts_leaked(self, nodeid: str) -> None:
        """Stop the session at the leak rather than at the engine ceiling it would drift into."""
        live = self._live_contexts()
        if len(live) < E2E_LIVE_CONTEXT_BUDGET:
            return
        raise BrowserContextBudgetError(
            f"{len(live)} browser contexts are open before {nodeid} starts, at or over the "
            f"{E2E_LIVE_CONTEXT_BUDGET}-context budget for one E2E session. Each test opens exactly one context and "
            f"the page fixture closes it in teardown, so every context still open here was leaked by a test that "
            f"already finished. Left to run, this session would spend WebKit's {WEBKIT_CONTEXT_CEILING}-context "
            f"per-process budget and fail every later navigation instead of this one. Contexts still open, by the "
            f"test that opened them:\n{self._owner_list(live)}"
        )

    def _retire_browser_when_budget_spent(self) -> None:
        """Replace the browser process before the next context would run past WebKit's ceiling."""
        if self._browser is None or self._contexts_created < E2E_CONTEXTS_PER_BROWSER:
            return
        if self._live_contexts():
            return
        self._browser.close()
        self._browser = None
        self._owners.clear()

    def open_context(self, nodeid: str, **context_args: Any) -> BrowserContext:
        """Open the one context that belongs to this test."""
        self._refuse_when_contexts_leaked(nodeid)
        self._retire_browser_when_budget_spent()
        context = self.browser.new_context(**context_args)
        self._contexts_created += 1
        self._owners[id(context)] = nodeid
        return context

    def close_context(self, context: BrowserContext) -> None:
        """Close one context and forget it, however its test ended."""
        self._owners.pop(id(context), None)
        context.close()

    def shutdown(self) -> None:
        """Close whatever survived, then the browser, and report any survivor as the leak it is."""
        survivors = self._live_contexts()
        leaked = self._owner_list(survivors)
        try:
            for context in survivors:
                self._owners.pop(id(context), None)
                with suppress(Exception):
                    # One context that refuses to close must not keep the others open.
                    context.close()
        finally:
            if self._browser is not None:
                self._browser.close()
                self._browser = None
        if survivors:
            raise BrowserContextBudgetError(
                f"{len(survivors)} browser contexts outlived the tests that opened them and were closed by session teardown. Opened by:\n{leaked}"
            )


class FirefoxDisplayError(RuntimeError):
    """Firefox on Linux has no X display to draw WebGL with, and the session could not start one."""


@contextmanager
def firefox_display() -> Iterator[dict[str, str]]:
    """Yield the environment that gives Firefox an X display, starting Xvfb when there is none.

    Only Linux needs one, and a display the caller already has (a desktop, or `xvfb-run`) is used as
    it is. Otherwise the server picks a free display number and writes it to `-displayfd` once it
    accepts connections, so the browser is never launched against a server that is still starting.
    """
    if sys.platform != "linux" or os.environ.get("DISPLAY"):
        yield {}
        return
    xvfb = shutil.which("Xvfb")
    if xvfb is None:
        raise FirefoxDisplayError(
            "Firefox needs an X display for WebGL on Linux, and Xvfb is not installed. "
            "Run `just e2e-setup`, which installs it with the browsers' system dependencies."
        )
    with tempfile.TemporaryFile() as errors:
        read_end, write_end = os.pipe()
        try:
            server = subprocess.Popen(  # noqa: S603
                [xvfb, "-displayfd", str(write_end), "-screen", "0", FIREFOX_XVFB_SCREEN, "-nolisten", "tcp"],
                pass_fds=(write_end,),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=errors,
            )
        finally:
            os.close(write_end)
        try:
            with os.fdopen(read_end) as announced:
                display = announced.readline().strip()
            if not display:
                server.wait(timeout=5)
                errors.seek(0)
                raise FirefoxDisplayError(
                    f"Xvfb exited with status {server.returncode} before it offered a display for Firefox:\n{errors.read().decode(errors='replace')}"
                )
            yield {"DISPLAY": f":{display}"}
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


@pytest.fixture(scope="session")
def browser_engine(browser_type_launch_args: dict[str, Any]) -> Iterator[Callable[[], Browser]]:
    """Yield a launcher for the selected desktop browser or standard emulated WebKit device."""
    project = os.environ.get("GROOVEMAP_E2E_PROJECT", "chromium")
    if project not in E2E_PROJECTS:
        raise ValueError(f"Unknown GROOVEMAP_E2E_PROJECT: {project}")
    engine_name = "webkit" if project in {"iphone", "ipad"} else project
    display: AbstractContextManager[dict[str, str]] = firefox_display() if engine_name == "firefox" else nullcontext({})
    with display as display_environment, sync_playwright() as playwright:
        engine = getattr(playwright, engine_name)
        launch_args = dict(browser_type_launch_args)
        if engine_name == "chromium":
            launch_args["args"] = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        if engine_name == "firefox":
            launch_args["firefox_user_prefs"] = FIREFOX_E2E_PREFS
        if display_environment:
            launch_args["env"] = {**os.environ, **display_environment}
        _DEVICE_CONTEXT.clear()
        if project in {"iphone", "ipad"}:
            device_name = "iPhone 15" if project == "iphone" else "iPad (gen 11)"
            _DEVICE_CONTEXT.update(playwright.devices[device_name])
            _DEVICE_CONTEXT.pop("default_browser_type", None)
        yield lambda: engine.launch(**launch_args)


@pytest.fixture(scope="session")
def browser_supply(browser_engine: Callable[[], Browser]) -> Iterator[BrowserContextSupply]:
    """Own every browser process and every context the E2E session opens."""
    supply = BrowserContextSupply(browser_engine)
    yield supply
    supply.shutdown()


@pytest.fixture
def browser(browser_supply: BrowserContextSupply) -> Browser:
    """Return the browser currently serving contexts; it is replaced during long sessions."""
    return browser_supply.browser


def _note_e2e_cleanup_error(errors: list[Exception], phase: str, error: Exception) -> None:
    """Retain every independent teardown failure with its diagnostic phase."""
    error.add_note(f"graph-explorer E2E teardown phase: {phase}")
    errors.append(error)


def _finalize_e2e_page(
    request: pytest.FixtureRequest,
    instance: Page,
    context: BrowserContext,
    supply: BrowserContextSupply,
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
                supply.close_context(context)
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
def page(
    request: pytest.FixtureRequest,
    browser_supply: BrowserContextSupply,
    browser_context_args: dict[str, Any],
) -> Iterator[Page]:
    """Create an isolated page and retain coverage plus failure diagnostics.

    The context is closed on every path out of this fixture — a failed test, a page that crashed,
    and a page that was never opened because arming the context raised — so that the live-context
    count is back to zero before the next test asks for one.
    """
    project = os.environ.get("GROOVEMAP_E2E_PROJECT", "chromium")
    artifact_root = Path("test-results") / project
    artifact_root.mkdir(parents=True, exist_ok=True)
    node_digest = hashlib.sha256(request.node.nodeid.encode()).hexdigest()[:16]
    context = browser_supply.open_context(request.node.nodeid, **browser_context_args)
    try:
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        instance = context.new_page()
    except BaseException:
        browser_supply.close_context(context)
        raise
    try:
        yield instance
    finally:
        _finalize_e2e_page(request, instance, context, browser_supply, artifact_root, project, node_digest)
