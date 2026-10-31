"""Verify promoted deterministic brand assets and their source provenance.

Without arguments, checks the source tree against the record in
explore/static/brand/source.json. Options widen the check:

  --design-repo PATH   also check the record against the design repository at
                       the recorded commit (read-only, via git objects).
  --fetch              fetch the recorded commit read-only into a temporary
                       repository when no usable --design-repo is given.
  --static-dir DIR     check the brand assets under DIR/brand (the served static
                       tree, e.g. extracted from a built image) against the record.
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "explore/static/brand"
PRODUCER_REPOSITORY = "https://github.com/groovemap-music/design"
PRODUCER_COMMIT = "41be7cbe738f40df0c75ad7065475e91d6cc2aa4"
PRODUCER_PATH = "brand/assets"
RECORD = "source.json"


def load_record() -> dict:
    source = json.loads((BRAND / RECORD).read_text())
    assert source["producer_repository"] == PRODUCER_REPOSITORY
    assert source["producer_commit"] == PRODUCER_COMMIT
    assert source["producer_path"] == PRODUCER_PATH
    return source


def check_directory(directory: Path, source: dict) -> None:
    """Fail unless every shipped asset in directory is recorded and matches its digest."""
    shipped = {path.name for path in directory.iterdir() if path.is_file() and path.name != RECORD}
    assert shipped == set(source["assets"]), f"{directory}: asset set differs from record: {shipped ^ set(source['assets'])}"
    for name, expected in source["assets"].items():
        assert sha256((directory / name).read_bytes()).hexdigest() == expected, f"{directory}/{name}"
    if (directory / RECORD).exists():
        assert json.loads((directory / RECORD).read_text()) == source, f"{directory}/{RECORD} differs from the repository record"


GIT = shutil.which("git") or "git"


def run_git(*args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run([GIT, *args], check=check, capture_output=True, timeout=300)  # noqa: S603


def git(repo: Path, *args: str) -> bytes:
    return run_git("-C", str(repo), *args).stdout


def has_commit(repo: Path) -> bool:
    return run_git("-C", str(repo), "cat-file", "-e", f"{PRODUCER_COMMIT}^{{commit}}", check=False).returncode == 0


def check_design(repo: Path, source: dict) -> None:
    """Fail unless the record equals the design repository's blobs at the recorded commit."""
    assert has_commit(repo), f"{repo} does not contain {PRODUCER_COMMIT}"
    published = {
        line.split()[1].removeprefix(f"{PRODUCER_PATH}/"): line.split()[0]
        for line in git(repo, "show", f"{PRODUCER_COMMIT}:brand/assets.sha256").decode().splitlines()
    }
    actual = {name: sha256(git(repo, "show", f"{PRODUCER_COMMIT}:{PRODUCER_PATH}/{name}")).hexdigest() for name in source["assets"]}
    assert actual == source["assets"], "record differs from design assets at the pinned commit"
    assert published == source["assets"], "record differs from design brand/assets.sha256 at the pinned commit"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--design-repo", type=Path)
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--static-dir", type=Path)
    args = parser.parse_args()

    source = load_record()
    check_directory(BRAND, source)
    if args.static_dir:
        check_directory(args.static_dir / "brand", source)
    if args.design_repo and has_commit(args.design_repo):
        check_design(args.design_repo, source)
    elif args.design_repo or args.fetch:
        if not args.fetch:
            sys.exit(f"{args.design_repo} lacks {PRODUCER_COMMIT}; pass --fetch to fetch it read-only")
        with tempfile.TemporaryDirectory() as scratch:
            run_git("init", "--quiet", scratch)
            run_git("-C", scratch, "fetch", "--quiet", "--depth", "1", PRODUCER_REPOSITORY, PRODUCER_COMMIT)
            check_design(Path(scratch), source)


if __name__ == "__main__":
    main()
