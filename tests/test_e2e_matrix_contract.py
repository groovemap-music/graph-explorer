"""Regression tests for the sequential browser-matrix artifact contract."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ("chromium", "firefox", "webkit", "iphone", "ipad")


def test_e2e_setup_installs_playwright_system_dependencies() -> None:
    justfile = (ROOT / "Justfile").read_text()

    assert "uv run playwright install --with-deps chromium firefox webkit" in justfile


def test_matrix_preserves_every_projects_playwright_artifacts(tmp_path: Path) -> None:
    """A later pytest process must not clear an earlier browser's evidence."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_uv = bin_dir / "uv"
    fake_uv.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
project="${GROOVEMAP_E2E_PROJECT:?}"
output=""
for argument in "$@"; do
  case "${argument}" in
    --output=*) output="${argument#--output=}" ;;
  esac
done
test -n "${output}"
# Model pytest-playwright's session-start cleanup, then leave one artifact.
rm -rf -- "${output}"
mkdir -p -- "${output}"
printf '%s\n' "${project}" > "${output}/failure-artifact.txt"
if [[ "${project}" == "chromium" ]]; then
  exit 1
fi
"""
    )
    fake_uv.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = f"{bin_dir}:{environment['PATH']}"

    result = subprocess.run(  # noqa: S603
        ["/bin/bash", str(ROOT / "scripts/run-e2e-matrix.sh")],
        cwd=tmp_path,
        env=environment,
        check=False,
    )
    assert result.returncode == 1

    for project in PROJECTS:
        artifact = tmp_path / "test-results" / project / "playwright" / "failure-artifact.txt"
        assert artifact.read_text().strip() == project


def _collected_e2e_tests_by_file() -> dict[str, int]:
    """The E2E tests the matrix would run per project, by file, as pytest collects them."""
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-m", "e2e", "--collect-only", "-q", "-p", "no:cacheprovider", "-p", "no:warnings"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return {path: int(count) for path, count in re.findall(r"^(tests/\S+\.py): (\d+)$", result.stdout, flags=re.MULTILINE)}


def test_discography_strata_journey_is_in_every_matrix_project() -> None:
    """The strata journey is marked `e2e`, so `run-e2e-matrix.sh` runs it on all five projects."""
    script = (ROOT / "scripts/run-e2e-matrix.sh").read_text()
    assert "pytest -m e2e" in script

    collected = _collected_e2e_tests_by_file()
    assert collected.get("tests/e2e/test_discography_strata.py", 0) >= 1

    # Every test in the file is marked, so none of it is silently left out of the matrix.
    source = (ROOT / "tests/e2e/test_discography_strata.py").read_text()
    assert source.count("@pytest.mark.e2e") == len(re.findall(r"^def test_", source, flags=re.MULTILINE))
    assert source.count("@pytest.mark.e2e") == collected["tests/e2e/test_discography_strata.py"]


def test_genre_atlas_journeys_are_in_every_matrix_project() -> None:
    """The Genre Atlas journeys are marked `e2e` too, so none of them is left out of the matrix."""
    collected = _collected_e2e_tests_by_file()
    assert collected.get("tests/e2e/test_genre_atlas.py", 0) >= 2

    source = (ROOT / "tests/e2e/test_genre_atlas.py").read_text()
    assert source.count("@pytest.mark.e2e") == len(re.findall(r"^def test_", source, flags=re.MULTILINE))
    assert source.count("@pytest.mark.e2e") == collected["tests/e2e/test_genre_atlas.py"]


def test_taste_strata_journeys_are_in_every_matrix_project() -> None:
    """The Taste Strata and Fit landing point journeys are marked `e2e` too, so none is left out of the matrix."""
    collected = _collected_e2e_tests_by_file()
    assert collected.get("tests/e2e/test_taste_strata.py", 0) >= 4

    source = (ROOT / "tests/e2e/test_taste_strata.py").read_text()
    assert source.count("@pytest.mark.e2e") == len(re.findall(r"^def test_", source, flags=re.MULTILINE))
    assert source.count("@pytest.mark.e2e") == collected["tests/e2e/test_taste_strata.py"]


def test_documented_matrix_size_matches_the_collected_tests() -> None:
    """The budget doc and the context-budget comment quote the matrix size; they must not drift."""
    total = sum(_collected_e2e_tests_by_file().values())

    budget_doc = (ROOT / "docs/release-compliance.md").read_text()
    documented = re.search(r"\| E2E tests in the matrix today \| (\d+) \|", budget_doc)
    assert documented is not None
    assert int(documented.group(1)) == total

    conftest = (ROOT / "tests/conftest.py").read_text()
    assert f"matrix drives {total} E2E tests" in conftest
