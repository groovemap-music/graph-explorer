"""Fixtures for Graph Explorer browser tests."""

from __future__ import annotations

import subprocess
import sys
import time
from typing import TYPE_CHECKING, Any

import httpx
import pytest


if TYPE_CHECKING:
    from collections.abc import Generator


@pytest.fixture(scope="session")
def test_server() -> Generator[str]:
    """Start the consumer-owned UI with an in-process mock Catalog API."""
    port = 8006
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
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    for _ in range(40):
        try:
            if httpx.get(f"{server_url}/health", timeout=2.0).status_code == 200:
                break
        except (httpx.ConnectError, httpx.TimeoutException):
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


@pytest.fixture(scope="session")
def browser_context_args() -> dict[str, Any]:
    """Configure an accessible desktop-sized browser viewport."""
    return {"viewport": {"width": 1280, "height": 720}, "ignore_https_errors": True}


@pytest.fixture(scope="session")
def browser_type_launch_args() -> dict[str, Any]:
    """Run browsers headlessly in local and CI containers."""
    return {"headless": True, "args": ["--no-sandbox", "--disable-gpu"]}
