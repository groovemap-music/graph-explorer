"""Regression tests for the browser-context budget that keeps WebKit E2E sessions alive.

WebKit spends a per-browser-process budget on every context that loads a page and never refunds
it on close, so the E2E session has to retire browsers on a schedule and has to notice a context
that outlived its test. Both behaviours are exercised here against a stand-in browser, so the
guard itself is covered by `just check` without launching a real engine.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.conftest import (
    E2E_CONTEXTS_PER_BROWSER,
    E2E_LIVE_CONTEXT_BUDGET,
    WEBKIT_CONTEXT_CEILING,
    BrowserContextBudgetError,
    BrowserContextSupply,
)


class FakeContext:
    """A context that reports itself open to its browser until it is closed."""

    def __init__(self, browser: FakeBrowser) -> None:
        self._browser = browser
        self.closed = False

    def close(self) -> None:
        self.closed = True
        self._browser.contexts.remove(self)


class FakeBrowser:
    """A browser that tracks its open contexts the way Playwright's does."""

    def __init__(self, serial: int) -> None:
        self.serial = serial
        self.contexts: list[FakeContext] = []
        self.closed = False
        self.context_args: list[dict[str, Any]] = []

    def new_context(self, **context_args: Any) -> FakeContext:
        self.context_args.append(context_args)
        context = FakeContext(self)
        self.contexts.append(context)
        return context

    def close(self) -> None:
        self.closed = True
        self.contexts.clear()


class FakeLauncher:
    """Hand out a fresh stand-in browser per launch and remember every one of them."""

    def __init__(self) -> None:
        self.browsers: list[FakeBrowser] = []

    def __call__(self) -> FakeBrowser:
        browser = FakeBrowser(len(self.browsers))
        self.browsers.append(browser)
        return browser


def _supply() -> tuple[BrowserContextSupply, FakeLauncher]:
    launcher = FakeLauncher()
    return BrowserContextSupply(launcher), launcher  # type: ignore[arg-type]


def test_the_live_context_budget_stays_well_under_the_webkit_ceiling() -> None:
    """The tripwire and the recycling schedule both have to fire long before WebKit gives up."""
    assert E2E_LIVE_CONTEXT_BUDGET < WEBKIT_CONTEXT_CEILING
    assert E2E_CONTEXTS_PER_BROWSER < WEBKIT_CONTEXT_CEILING


def test_a_context_per_test_never_launches_a_second_browser_early() -> None:
    """One opened-and-closed context per test uses one browser until the budget is spent."""
    supply, launcher = _supply()
    for index in range(E2E_CONTEXTS_PER_BROWSER):
        context = supply.open_context(f"tests/test_x.py::test_{index}")
        supply.close_context(context)
    assert len(launcher.browsers) == 1


def test_the_browser_is_retired_once_its_context_budget_is_spent() -> None:
    """The browser process is replaced on schedule, because closing contexts does not refund it."""
    supply, launcher = _supply()
    for index in range(E2E_CONTEXTS_PER_BROWSER + 1):
        context = supply.open_context(f"tests/test_x.py::test_{index}")
        supply.close_context(context)
    assert len(launcher.browsers) == 2
    assert launcher.browsers[0].closed
    assert not launcher.browsers[1].closed


def test_a_long_session_never_runs_a_browser_past_the_webkit_ceiling() -> None:
    """No single browser process may serve more contexts than WebKit will honour."""
    supply, launcher = _supply()
    for index in range(10 * E2E_CONTEXTS_PER_BROWSER):
        context = supply.open_context(f"tests/test_x.py::test_{index}")
        supply.close_context(context)
    served = [len(browser.context_args) for browser in launcher.browsers]
    assert max(served) <= E2E_CONTEXTS_PER_BROWSER
    assert max(served) < WEBKIT_CONTEXT_CEILING


def test_leaked_contexts_fail_the_next_test_and_name_the_tests_that_leaked() -> None:
    """A context that outlives its test stops the session where the leak is still readable."""
    supply, _ = _supply()
    for index in range(E2E_LIVE_CONTEXT_BUDGET):
        supply.open_context(f"tests/test_leaky.py::test_{index}")

    with pytest.raises(BrowserContextBudgetError) as failure:
        supply.open_context("tests/test_innocent.py::test_next")

    message = str(failure.value)
    assert f"{E2E_LIVE_CONTEXT_BUDGET} browser contexts are open before tests/test_innocent.py::test_next" in message
    assert str(WEBKIT_CONTEXT_CEILING) in message
    assert "tests/test_leaky.py::test_0" in message
    assert f"tests/test_leaky.py::test_{E2E_LIVE_CONTEXT_BUDGET - 1}" in message


def test_the_browser_is_not_retired_while_a_context_is_still_open() -> None:
    """Retiring a browser under a live context would close it out from under the test using it."""
    supply, launcher = _supply()
    for index in range(E2E_CONTEXTS_PER_BROWSER - 1):
        context = supply.open_context(f"tests/test_x.py::test_{index}")
        supply.close_context(context)
    held = supply.open_context("tests/test_x.py::test_holds_a_context")

    # The budget is spent now, but this context is still open, so the browser has to stay.
    neighbour = supply.open_context("tests/test_x.py::test_runs_alongside")

    assert len(launcher.browsers) == 1
    assert not held.closed
    assert not neighbour.closed


def test_session_teardown_closes_survivors_and_reports_them() -> None:
    """Session teardown leaves no context open, and says which tests left them open."""
    supply, launcher = _supply()
    survivor = supply.open_context("tests/test_leaky.py::test_forgot_to_close")

    with pytest.raises(BrowserContextBudgetError) as failure:
        supply.shutdown()

    assert survivor.closed
    assert launcher.browsers[0].closed
    assert "tests/test_leaky.py::test_forgot_to_close" in str(failure.value)


def test_session_teardown_is_quiet_when_every_test_cleaned_up() -> None:
    """A clean session closes its browser without inventing a leak to report."""
    supply, launcher = _supply()
    context = supply.open_context("tests/test_x.py::test_clean")
    supply.close_context(context)

    supply.shutdown()

    assert launcher.browsers[0].closed
