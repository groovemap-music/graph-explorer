from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
CI_TARGET = "groovemap-music/automation/.github/workflows/reusable-ci.yml@2f890111657d9f3e6f55d8bd5a5e7b8f9ca97b26"
RELEASE_TARGET = "groovemap-music/automation/.github/workflows/reusable-release.yml@833cb464507678c38ab78bd4718ce697399463e9"


@pytest.mark.parametrize(
    ("workflow", "target", "replacement", "accepted"),
    [
        ("ci.yml", CI_TARGET, CI_TARGET, True),
        ("ci.yml", CI_TARGET, CI_TARGET.replace("2f890111657d9f3e6f55d8bd5a5e7b8f9ca97b26", "833cb464507678c38ab78bd4718ce697399463e9"), False),
        ("ci.yml", CI_TARGET, CI_TARGET.replace("groovemap-music/automation", "foreign/automation"), False),
        ("ci.yml", CI_TARGET, CI_TARGET.replace("2f890111657d9f3e6f55d8bd5a5e7b8f9ca97b26", "0" * 40), False),
        ("release.yml", RELEASE_TARGET, RELEASE_TARGET, True),
        (
            "release.yml",
            RELEASE_TARGET,
            RELEASE_TARGET.replace("833cb464507678c38ab78bd4718ce697399463e9", "2f890111657d9f3e6f55d8bd5a5e7b8f9ca97b26"),
            False,
        ),
    ],
    ids=["current-ci", "old-ci", "foreign-ci-repository", "foreign-ci-revision", "unchanged-release", "altered-release"],
)
def test_actual_checker_enforces_independent_workflow_pins(tmp_path: Path, workflow: str, target: str, replacement: str, *, accepted: bool) -> None:
    inventory = subprocess.check_output(  # noqa: S603 - fixed tracked-source inventory
        ["git", "-C", str(ROOT), "ls-files", "-z"]  # noqa: S607 - trusted test PATH
    )
    for raw_path in inventory.decode().split("\0"):
        if raw_path:
            destination = tmp_path / raw_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / raw_path, destination)
    path = tmp_path / ".github/workflows" / workflow
    original = path.read_text()
    assert original.count(target) == 1
    path.write_text(original.replace(target, replacement))
    for arguments in (["init", "--quiet"], ["add", "."]):
        subprocess.run(  # noqa: S603 - fixed disposable repository setup
            ["git", "-C", str(tmp_path), *arguments],  # noqa: S607 - trusted test PATH
            check=True,
            capture_output=True,
        )
    result = subprocess.run(  # noqa: S603 - actual fixed checker in owned fixture
        [sys.executable, str(tmp_path / "scripts/check-repository-compliance.py")],
        cwd=tmp_path,
        check=False,
        capture_output=True,
        text=True,
    )
    assert (result.returncode == 0) is accepted, result.stdout + result.stderr
    if not accepted:
        assert "AssertionError" in result.stderr
