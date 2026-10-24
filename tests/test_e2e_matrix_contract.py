"""Regression tests for the concurrent browser-matrix contract: artifacts, exit status, logs."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ("chromium", "firefox", "webkit", "iphone", "ipad")


@pytest.fixture(autouse=True)
def _all_projects_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """CI sets E2E_PROJECT; a test that wants one project sets it itself."""
    monkeypatch.delenv("E2E_PROJECT", raising=False)


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


# Stands in for `uv run pytest` in one project: records when it ran, writes one line of output and
# exits with the status FAKE_UV_FAIL assigns the project.
TIMED_FAKE_UV = """#!/usr/bin/env bash
set -euo pipefail
project="${GROOVEMAP_E2E_PROJECT:?}"
printf '%s start %s\\n' "${project}" "$(python3 -c 'import time; print(time.time())')" >> "${FAKE_UV_EVENTS:?}"
echo "pytest output for ${project}"
sleep 1
printf '%s end %s\\n' "${project}" "$(python3 -c 'import time; print(time.time())')" >> "${FAKE_UV_EVENTS:?}"
case " ${FAKE_UV_FAIL:-} " in *" ${project} "*) echo "${project} broke"; exit 3 ;; esac
"""


def _run_timed_matrix(tmp_path: Path, jobs: str, failing: str = "", project: str | None = None) -> tuple[subprocess.CompletedProcess[str], int]:
    """Run the matrix against the timed fake and return its result and peak concurrency."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_uv = bin_dir / "uv"
    fake_uv.write_text(TIMED_FAKE_UV)
    fake_uv.chmod(0o755)
    events = tmp_path / "events"
    environment = os.environ.copy()
    environment.update(
        PATH=f"{bin_dir}:{environment['PATH']}",
        FAKE_UV_EVENTS=str(events),
        FAKE_UV_FAIL=failing,
        GROOVEMAP_E2E_JOBS=jobs,
    )
    if project is not None:
        environment["E2E_PROJECT"] = project
    result = subprocess.run(  # noqa: S603
        ["/bin/bash", str(ROOT / "scripts/run-e2e-matrix.sh")],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    timeline = sorted(
        (float(moment), 1 if kind == "start" else -1) for _project, kind, moment in (line.split() for line in events.read_text().splitlines())
    )
    running = peak = 0
    for _moment, change in timeline:
        running += change
        peak = max(peak, running)
    return result, peak


def test_matrix_runs_the_projects_concurrently_within_the_job_bound(tmp_path: Path) -> None:
    result, peak = _run_timed_matrix(tmp_path, jobs="2")

    assert result.returncode == 0, result.stdout + result.stderr
    assert peak == 2
    for project in PROJECTS:
        assert f"{project}: passed" in result.stdout
        assert f"[{project}] pytest output for {project}" in result.stdout
        log = tmp_path / "test-results" / project / "pytest.log"
        assert log.read_text() == f"pytest output for {project}\n"


def test_matrix_runs_every_project_at_once_when_the_bound_allows(tmp_path: Path) -> None:
    result, peak = _run_timed_matrix(tmp_path, jobs="16")

    assert result.returncode == 0, result.stdout + result.stderr
    assert peak == len(PROJECTS)


def test_matrix_fails_when_any_project_fails_and_repeats_its_log(tmp_path: Path) -> None:
    result, _peak = _run_timed_matrix(tmp_path, jobs="5", failing="webkit ipad")

    assert result.returncode == 1
    assert "webkit: FAILED with exit status 3" in result.stdout
    assert "ipad: FAILED with exit status 3" in result.stdout
    for project in ("chromium", "firefox", "iphone"):
        assert f"{project}: passed" in result.stdout
    for project in ("webkit", "ipad"):
        failure_report = result.stdout.split(f"E2E project {project} failed; its log", 1)[1]
        assert f"{project} broke" in failure_report.split("=====", 2)[1]


@pytest.mark.parametrize("project", PROJECTS)
def test_matrix_runs_exactly_the_project_named_by_e2e_project(tmp_path: Path, project: str) -> None:
    """CI gives each browser project its own runner and names it in E2E_PROJECT."""
    result, peak = _run_timed_matrix(tmp_path, jobs="5", project=project)

    assert result.returncode == 0, result.stdout + result.stderr
    assert peak == 1
    assert f"{project}: passed" in result.stdout
    assert sorted(path.name for path in (tmp_path / "test-results").iterdir()) == [project]
    started = [line.split()[0] for line in (tmp_path / "events").read_text().splitlines() if " start " in line]
    assert started == [project]


def test_matrix_fails_when_the_one_selected_project_fails(tmp_path: Path) -> None:
    result, _peak = _run_timed_matrix(tmp_path, jobs="5", failing="webkit", project="webkit")

    assert result.returncode == 1
    assert "webkit: FAILED with exit status 3" in result.stdout
    assert "webkit broke" in result.stdout.split("E2E project webkit failed; its log", 1)[1]


def test_matrix_treats_an_empty_e2e_project_as_unset(tmp_path: Path) -> None:
    result, peak = _run_timed_matrix(tmp_path, jobs="16", project="")

    assert result.returncode == 0, result.stdout + result.stderr
    assert peak == len(PROJECTS)
    for project in PROJECTS:
        assert f"{project}: passed" in result.stdout


def test_matrix_refuses_an_unknown_e2e_project(tmp_path: Path) -> None:
    for project in ("opera", "chromium firefox", "chrom", "../chromium"):
        result = subprocess.run(  # noqa: S603
            ["/bin/bash", str(ROOT / "scripts/run-e2e-matrix.sh")],
            cwd=tmp_path,
            env={**os.environ, "E2E_PROJECT": project},
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 2
        assert "E2E_PROJECT must be one of" in result.stderr
        assert not (tmp_path / "test-results").exists()


# Stands in for a project that never finishes: a grandchild of the matrix, like pytest's app
# server or browser, that records its pid and outlives the fake unless something stops it.
HANGING_FAKE_UV = """#!/usr/bin/env bash
sleep 300 &
echo "$!" > "${FAKE_UV_PIDS:?}/${GROOVEMAP_E2E_PROJECT:?}"
wait
"""


def test_matrix_stops_every_projects_process_tree_when_terminated(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_uv = bin_dir / "uv"
    fake_uv.write_text(HANGING_FAKE_UV)
    fake_uv.chmod(0o755)
    pids = tmp_path / "pids"
    pids.mkdir()
    environment = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_UV_PIDS": str(pids), "GROOVEMAP_E2E_JOBS": "5"}
    matrix = subprocess.Popen(  # noqa: S603
        ["/bin/bash", str(ROOT / "scripts/run-e2e-matrix.sh")],
        cwd=tmp_path,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 20
        while len([path for path in pids.iterdir() if path.read_text().strip()]) < len(PROJECTS):
            assert time.monotonic() < deadline, "the projects did not all start"
            time.sleep(0.1)
        grandchildren = [int(path.read_text()) for path in pids.iterdir()]

        matrix.send_signal(signal.SIGTERM)
        assert matrix.wait(timeout=20) == 143
    finally:
        if matrix.poll() is None:
            matrix.kill()

    # A killed grandchild is reparented and reaped by init, so give that a moment.
    deadline = time.monotonic() + 5
    while survivors := [pid for pid in grandchildren if _alive(pid)]:
        assert time.monotonic() < deadline, f"processes outlived the matrix: {survivors}"
        time.sleep(0.1)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_matrix_refuses_a_job_bound_that_is_not_a_positive_integer(tmp_path: Path) -> None:
    for jobs in ("0", "two", "-1"):
        result = subprocess.run(  # noqa: S603
            ["/bin/bash", str(ROOT / "scripts/run-e2e-matrix.sh")],
            cwd=tmp_path,
            env={**os.environ, "GROOVEMAP_E2E_JOBS": jobs},
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 2
        assert "GROOVEMAP_E2E_JOBS must be a positive integer" in result.stderr
        assert not (tmp_path / "test-results").exists()


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


FINALIZE = ROOT / "explore/scripts/finalize-e2e-coverage.mjs"
INSTRUMENTED_SOURCE = "explore/static/js/app.js"


def _istanbul_fragment(project: str) -> str:
    """One Istanbul coverage fragment, as the browser writes it, covering one statement."""
    source = f"/app/{project}.js"
    position = {"line": 1, "column": 0}
    return json.dumps(
        {
            source: {
                "path": source,
                "statementMap": {"0": {"start": position, "end": {"line": 1, "column": 5}}},
                "fnMap": {},
                "branchMap": {},
                "s": {"0": 1},
                "f": {},
                "b": {},
            }
        }
    )


def _finalize(tmp_path: Path, fragments: tuple[str, ...], project: str | None = None) -> subprocess.CompletedProcess[str]:
    """Run finalize-e2e-coverage.mjs in a scratch repository holding only these projects' fragments."""
    for name in fragments:
        raw = tmp_path / "coverage/e2e/raw" / name
        raw.mkdir(parents=True)
        (raw / "coverage.json").write_text(_istanbul_fragment(name))
    # The instrumented source and the original that finalize puts back, like instrument-e2e-coverage.
    instrumented = tmp_path / INSTRUMENTED_SOURCE
    instrumented.parent.mkdir(parents=True)
    instrumented.write_text("instrumented")
    backup = tmp_path / ".build/e2e-original" / INSTRUMENTED_SOURCE
    backup.parent.mkdir(parents=True)
    backup.write_text("original")
    environment = {**os.environ, "GROOVEMAP_E2E_ROOT": str(tmp_path)}
    if project is not None:
        environment["E2E_PROJECT"] = project
    return subprocess.run(  # noqa: S603
        ["node", str(FINALIZE)],  # noqa: S607 - trusted test PATH
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def _assert_sources_restored(tmp_path: Path) -> None:
    assert (tmp_path / INSTRUMENTED_SOURCE).read_text() == "original"
    assert not (tmp_path / ".build/e2e-original").exists()


def test_finalize_writes_every_project_and_the_merged_report_when_unset(tmp_path: Path) -> None:
    result = _finalize(tmp_path, PROJECTS)

    assert result.returncode == 0, result.stdout + result.stderr
    for project in PROJECTS:
        assert f"/app/{project}.js" in (tmp_path / "coverage/e2e" / project / "lcov.info").read_text()
    merged = (tmp_path / "coverage/e2e/lcov.info").read_text()
    for project in PROJECTS:
        assert f"/app/{project}.js" in merged
    _assert_sources_restored(tmp_path)


def test_finalize_fails_when_a_project_has_no_coverage_and_none_is_selected(tmp_path: Path) -> None:
    result = _finalize(tmp_path, ("chromium", "firefox"))

    assert result.returncode != 0
    assert "Missing Istanbul coverage for webkit" in result.stderr
    _assert_sources_restored(tmp_path)


@pytest.mark.parametrize("project", PROJECTS)
def test_finalize_succeeds_on_one_projects_coverage_alone(tmp_path: Path, project: str) -> None:
    """A per-project runner holds only its own fragments, and writes only its own report."""
    result = _finalize(tmp_path, (project,), project=project)

    assert result.returncode == 0, result.stdout + result.stderr
    assert f"/app/{project}.js" in (tmp_path / "coverage/e2e" / project / "lcov.info").read_text()
    reports = sorted(path.relative_to(tmp_path / "coverage/e2e").as_posix() for path in (tmp_path / "coverage/e2e").rglob("lcov.info"))
    assert reports == [f"{project}/lcov.info"]
    _assert_sources_restored(tmp_path)


def test_finalize_for_one_project_fails_when_its_coverage_is_missing(tmp_path: Path) -> None:
    # Another project's fragments do not stand in for the selected project's own.
    result = _finalize(tmp_path, ("firefox",), project="chromium")

    assert result.returncode != 0
    assert "Missing Istanbul coverage for chromium" in result.stderr
    assert not (tmp_path / "coverage/e2e/chromium/lcov.info").exists()
    _assert_sources_restored(tmp_path)


def test_finalize_for_one_project_fails_when_its_coverage_is_empty(tmp_path: Path) -> None:
    result = _finalize(tmp_path, (), project="chromium")
    assert result.returncode != 0
    _assert_sources_restored(tmp_path)

    empty = tmp_path / "coverage/e2e/raw/chromium"
    empty.mkdir(parents=True)
    (empty / "notes.txt").write_text("not a coverage fragment")
    again = subprocess.run(  # noqa: S603
        ["node", str(FINALIZE)],  # noqa: S607 - trusted test PATH
        cwd=tmp_path,
        env={**os.environ, "GROOVEMAP_E2E_ROOT": str(tmp_path), "E2E_PROJECT": "chromium"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert again.returncode != 0
    assert "Missing Istanbul coverage for chromium" in again.stderr


def test_finalize_refuses_an_unknown_project(tmp_path: Path) -> None:
    result = _finalize(tmp_path, ("chromium",), project="opera")

    assert result.returncode != 0
    assert "E2E_PROJECT must be one of" in result.stderr
    _assert_sources_restored(tmp_path)
