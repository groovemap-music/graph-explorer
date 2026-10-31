"""Tests for the in-image dependency consistency check."""

import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).parent.parent
SPEC = importlib.util.spec_from_file_location("check_image_deps", ROOT / "scripts" / "check-image-deps.py")
assert SPEC and SPEC.loader
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

LOCK = """\
# comment
fastapi==0.148.0 \\
    # via groovemap-graph-explorer
groovemap-runtime @ git+https://github.com/groovemap-music/python-libraries.git@abc
orjson==3.13.0
"""
INSTALLED = {
    "fastapi": "0.148.0",
    "groovemap-runtime": "0.1.0",
    "orjson": "3.13.0",
    "groovemap-graph-explorer": "0.2.2",
}


def test_parse_lock_handles_pins_sources_and_comments() -> None:
    assert check.parse_lock(LOCK) == {"fastapi": "0.148.0", "groovemap-runtime": None, "orjson": "3.13.0"}


def test_matching_environment_passes() -> None:
    assert check.compare(check.parse_lock(LOCK), INSTALLED) == []


@pytest.mark.parametrize(
    ("installed", "message"),
    [
        ({**INSTALLED, "fastapi": "0.141.1"}, "fastapi: installed 0.141.1 but uv.lock pins 0.148.0"),
        ({k: v for k, v in INSTALLED.items() if k != "orjson"}, "locked distribution not installed: orjson"),
        ({**INSTALLED, "requests": "2.0"}, "installed distribution not in uv.lock: requests==2.0"),
        ({k: v for k, v in INSTALLED.items() if k != "groovemap-runtime"}, "not installed: groovemap-runtime"),
    ],
)
def test_mismatched_environment_fails(installed: dict[str, str], message: str) -> None:
    errors = check.compare(check.parse_lock(LOCK), installed)
    assert any(message in error for error in errors)


def test_lock_without_runtime_source_fails() -> None:
    errors = check.compare({"fastapi": "0.148.0"}, {"fastapi": "0.148.0"})
    assert any("source-pinned" in error for error in errors)


def test_dockerfile_installs_from_lock_without_hand_pins() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text()
    assert "uv export --frozen --no-dev" in dockerfile
    assert "--require-hashes" in dockerfile
    assert "--no-deps ." not in dockerfile
    assert "fastapi==" not in dockerfile
