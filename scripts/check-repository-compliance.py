"""Validate graph-explorer identity, automation, documentation, and exposure policy."""

import json
import re
from pathlib import Path

from repository_source import RepositorySourceError, tracked_tree_text


ROOT = Path(__file__).resolve().parents[1]
AUTOMATION_REVISION = "5e52f14885e70f39c7f588d89fc2a1316d4c4b13"
PYTHON_LIBRARIES_REVISION = "41805b62520785f412e8f5d0db90f8d83838ec56"
DESIGN_REVISION = "59c9fd3c8bbdfa676e0b7bb3d463fc766c1f3c0d"
E2E_PROJECTS = {"chromium", "firefox", "webkit", "iphone", "ipad"}
EXPECTED_BROWSER_COVERAGE = [
    {
        "project": project,
        "lcov": f"coverage/e2e/{project}/lcov.info",
        "artifacts": [f"test-results/{project}", f"coverage/e2e/raw/{project}"],
    }
    for project in ("chromium", "firefox", "webkit", "iphone", "ipad")
]


def workflow_jobs(text: str) -> set[str]:
    """Return top-level job IDs from a workflow's jobs section."""
    jobs = text.split("\njobs:\n", 1)[1]
    return set(re.findall(r"(?m)^  ([a-zA-Z0-9_-]+):\s*$", jobs))


ci = (ROOT / ".github/workflows/ci.yml").read_text()
assert re.search(r"(?m)^  pull_request:\s*$", ci)
assert 'cron: "0 1 * * 6"' in ci
assert 'cron: "0 4 * * 1"' in ci
assert "github.actor" not in ci
assert "dependabot" not in ci.casefold()
assert "fallback-command" not in ci
assert workflow_jobs(ci) == {"required"}
ci_target = re.search(r"groovemap-music/automation/\.github/workflows/reusable-ci\.yml@([^\s]+)", ci)
assert ci_target is not None and ci_target.group(1) == AUTOMATION_REVISION
for required_input in (
    "language: mixed",
    "coverage-command: just coverage",
    "e2e-setup-command: just e2e-setup",
    "e2e-instrument-command: just e2e-instrument",
    "e2e-command: just e2e-run",
    "e2e-post-command: just e2e-post",
    "upload-codecov: true",
    "image-command: just image",
    "CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}",
):
    assert required_input in ci
coverage_mapping_match = re.search(
    r"(?m)^      browser-coverage-mapping: >-\n(?P<body>(?:^        .*\n)+)",
    ci,
)
assert coverage_mapping_match is not None
coverage_mapping = json.loads(" ".join(line.strip() for line in coverage_mapping_match.group("body").splitlines()))
assert coverage_mapping == EXPECTED_BROWSER_COVERAGE
assert "coverage/e2e/*/lcov.info" not in ci
assert "coverage/e2e/raw/**/*.json" not in ci
assert "test-results/**/*" not in ci
assert "coverage-flags: python,javascript,e2e,explorer" in ci
assert not any(f"e2e-{project}" in ci for project in E2E_PROJECTS)
assert "secrets: inherit" not in ci
for marker in (
    "requires-private-library",
    "private-library-client-id",
    "private-library-revision",
    "private_library_private_key",
    "groovemap_ci_app_client_id",
    "groovemap_ci_app_private_key",
):
    assert marker not in ci.lower()

release = (ROOT / ".github/workflows/release.yml").read_text()
assert "attestations: write" in release
release_target = re.search(r"groovemap-music/automation/\.github/workflows/reusable-release\.yml@([^\s]+)", release)
assert release_target is not None and release_target.group(1) == AUTOMATION_REVISION
for required_input in (
    "repository-name: graph-explorer",
    "release-command: just release-dry-run",
    "publish-image: true",
):
    assert required_input in release
assert "secrets: inherit" not in release
for marker in (
    "requires-private-library",
    "private-library-client-id",
    "private-library-revision",
    "private_library_private_key",
    "groovemap_ci_app_client_id",
    "groovemap_ci_app_private_key",
):
    assert marker not in release.lower()

pyproject = (ROOT / "pyproject.toml").read_text()
assert "https://github.com/groovemap-music/python-libraries.git" in pyproject
assert PYTHON_LIBRARIES_REVISION in pyproject

workflow_names = {path.name.casefold() for path in (ROOT / ".github/workflows").iterdir()}
assert not any("renovate" in name or "claude" in name for name in workflow_names)
assert not any(path.name.casefold().startswith("renovate") for path in ROOT.iterdir())

matrix = (ROOT / "scripts/run-e2e-matrix.sh").read_text()
projects_match = re.search(r"projects=\(([^)]+)\)", matrix)
assert projects_match is not None
assert set(projects_match.group(1).split()) == E2E_PROJECTS
assert '--output="test-results/${project}/playwright"' in matrix
instrument = (ROOT / "explore/scripts/instrument-e2e-coverage.mjs").read_text()
instrument_guard = (ROOT / "scripts/instrument-e2e-coverage.sh").read_text()
restore = (ROOT / "explore/scripts/e2e-coverage-sources.mjs").read_text()
finalize = (ROOT / "explore/scripts/finalize-e2e-coverage.mjs").read_text()
assert "istanbul-lib-instrument" in instrument
assert instrument_guard.index("trap restore_on_failure EXIT") < instrument_guard.index("node explore/scripts/instrument-e2e-coverage.mjs")
assert "restoreSources();" in instrument
assert "e2e-original" in restore
assert "Missing Istanbul coverage" in finalize
assert set(re.findall(r'"(chromium|firefox|webkit|iphone|ipad)"', finalize)) == E2E_PROJECTS
assert "finally" in finalize and "restoreSources();" in finalize

conftest = (ROOT / "tests/conftest.py").read_text()
assert "def _finalize_e2e_page(" in conftest
assert 'instance.screenshot(path=artifact_root / f"{node_digest}.png"' in conftest
assert "context.tracing.stop" in conftest
assert "context.close()" in conftest
assert "finally:" in conftest

package = json.loads((ROOT / "explore/package.json").read_text())
for dependency in ("istanbul-lib-coverage", "istanbul-lib-instrument", "istanbul-lib-report", "istanbul-reports"):
    assert dependency in package["devDependencies"]

private_planning = (
    ROOT / ".planning",
    ROOT / "docs/superpowers/plans",
    ROOT / "docs/superpowers/specs",
    ROOT / "docs/extraction.md",
)
assert not any(path.exists() for path in private_planning)
rehearsal = (ROOT / "scripts/rehearse-history-sanitization.sh").read_text()
assert "--mirror --no-local" in rehearsal
assert "filter-repo --force --invert-paths" in rehearsal
assert "remote-cutover-approved=false" in rehearsal
assert "public-visibility-approved=false" in rehearsal
assert 'gitleaks git --config "${gitleaks_config}"' in rehearsal
assert 'trufflehog git "file://${sanitized_repo}" --bare --fail --only-verified' in rehearsal
assert 'cd "${sanitized_worktree}"' in rehearsal
assert not re.search(r"\bgit\s+push\b", rehearsal)

readme = (ROOT / "README.md").read_text()
docs_index = (ROOT / "docs/README.md").read_text()
assert "GrooveMap Graph Explorer" in readme
assert "graph-explorer" in readme
assert "```mermaid" in readme
assert "architecture.md" in docs_index
assert "release-compliance.md" in docs_index
assert "history-rewrite-gate.md" in docs_index
assert "active release workflow" in readme
assert "explicitly approved `v*` tag" in readme
assert "publishing workflow remains disabled" not in readme
assert "```mermaid" in (ROOT / "docs/architecture.md").read_text()
assert "```mermaid" in (ROOT / "docs/release-compliance.md").read_text()

source = (ROOT / "explore/explore.py").read_text()
assert 'SERVICE_NAME = "graph-explorer"' in source
assert "GrooveMap graph-explorer" in source
assert 'Path("/logs/graph-explorer.log")' in source
assert "graph-explorer" in (ROOT / "explore/static/index.html").read_text()

dockerfile = (ROOT / "Dockerfile").read_text()
assert 'org.opencontainers.image.title="graph-explorer"' in dockerfile
assert 'org.opencontainers.image.source="https://github.com/groovemap-music/graph-explorer"' in dockerfile
assert 'org.opencontainers.image.revision="${VCS_REF}"' in dockerfile

brand_source = json.loads((ROOT / "explore/static/brand/source.json").read_text())
assert brand_source["producer_repository"] == "https://github.com/groovemap-music/design"
assert brand_source["producer_commit"] == DESIGN_REVISION

ignored_parts = {
    ".git",
    ".venv",
    ".build",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
    "dist",
    "coverage",
    "coverage-e2e",
    "test-results",
}
legacy_product_name = "discogs" + "ography"
try:
    current_tree_text = tracked_tree_text(ROOT, excluded_parts=ignored_parts)
except RepositorySourceError as error:
    raise SystemExit(str(error)) from error
assert legacy_product_name not in current_tree_text.casefold()
