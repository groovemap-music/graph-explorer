"""Regression tests for the sequential browser-matrix artifact contract."""

from __future__ import annotations

import os
import subprocess
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
