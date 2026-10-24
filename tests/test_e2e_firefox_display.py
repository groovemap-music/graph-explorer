"""Regression tests for the X display the E2E session gives Firefox so it can draw WebGL on Linux.

Headless Firefox on Linux creates WebGL contexts through GLX, so without an X server every 3D view
in the Firefox project falls back to its no-WebGL message. The session starts a private Xvfb when
there is no display. The server here is a stand-in script that speaks Xvfb's `-displayfd` handshake,
so the lifecycle is covered by `just check` on any host, with or without a real Xvfb.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

import pytest

from tests.conftest import FIREFOX_XVFB_SCREEN, FirefoxDisplayError, firefox_display


if TYPE_CHECKING:
    from pathlib import Path


ANNOUNCING_XVFB = """#!/bin/bash
printf '%s\\n' "$@" > "${FAKE_XVFB_ARGS:?}"
while (( $# )); do
  case "$1" in -displayfd) fd="$2"; shift ;; esac
  shift
done
trap 'printf terminated > "${FAKE_XVFB_STATE:?}"; exit 0' TERM
printf '42\\n' >&"${fd:?}"
while :; do /bin/sleep 0.05; done
"""

FAILING_XVFB = """#!/bin/bash
printf '(EE) Server is already active for display 42\\n' >&2
exit 1
"""


@pytest.fixture
def linux_without_display(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Look like a CI runner: Linux, no DISPLAY, and only the stand-in directory on PATH."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setenv("PATH", str(bin_dir))
    monkeypatch.setenv("FAKE_XVFB_ARGS", str(tmp_path / "args"))
    monkeypatch.setenv("FAKE_XVFB_STATE", str(tmp_path / "state"))
    return bin_dir


def _install(bin_dir: Path, script: str) -> None:
    xvfb = bin_dir / "Xvfb"
    xvfb.write_text(script)
    xvfb.chmod(0o755)


def test_firefox_draws_on_the_platforms_own_display_off_linux(monkeypatch: pytest.MonkeyPatch) -> None:
    """macOS and Windows Firefox need no X server, so nothing is started and nothing is overridden."""
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setenv("PATH", "")
    with firefox_display() as environment:
        assert environment == {}


def test_an_existing_display_is_used_as_it_is(linux_without_display: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A desktop session or an `xvfb-run` wrapper already gives Firefox a display."""
    monkeypatch.setenv("DISPLAY", ":7")
    with firefox_display() as environment:
        assert environment == {}
    assert not (linux_without_display.parent / "args").exists()


def test_a_runner_without_a_display_gets_a_private_xvfb(linux_without_display: Path) -> None:
    """The display the server announces is the one Firefox is given, and the server stops after."""
    _install(linux_without_display, ANNOUNCING_XVFB)
    with firefox_display() as environment:
        assert environment == {"DISPLAY": ":42"}
        arguments = (linux_without_display.parent / "args").read_text().splitlines()
        assert arguments[0] == "-displayfd"
        assert arguments[2:] == ["-screen", "0", FIREFOX_XVFB_SCREEN, "-nolisten", "tcp"]
        assert not (linux_without_display.parent / "state").exists()
    assert (linux_without_display.parent / "state").read_text() == "terminated"


def test_a_missing_xvfb_fails_the_session_instead_of_testing_without_webgl(linux_without_display: Path) -> None:
    """With no server to start, the Firefox project would only ever see the no-WebGL message."""
    del linux_without_display
    with pytest.raises(FirefoxDisplayError, match=r"Xvfb is not installed.*just e2e-setup"), firefox_display():
        pytest.fail("the session went on without a display")


def test_an_xvfb_that_offers_no_display_fails_with_its_own_words(linux_without_display: Path) -> None:
    """A server that exits before announcing a display reports its status and what it printed."""
    _install(linux_without_display, FAILING_XVFB)
    with (
        pytest.raises(FirefoxDisplayError, match=r"(?s)status 1 .*Server is already active for display 42"),
        firefox_display(),
    ):
        pytest.fail("the session went on without a display")
