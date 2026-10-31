#!/usr/bin/env python3
"""Check the Python environment inside the runtime image against uv.lock.

The lock file is the unhashed `uv export --frozen --no-dev` requirement set that the
Dockerfile bakes into the image. The check fails when a locked distribution is missing or
at a different version, when an unlocked distribution is installed, or when `pip check`
reports a requirement violation (which covers the pyproject requirements through the
installed groovemap-graph-explorer metadata). Standard library only.
"""

import argparse
import re
import subprocess
import sys
from importlib import metadata
from pathlib import Path


DEFAULT_LOCK = Path("/usr/share/graph-explorer/runtime-requirements.txt")
PROJECT = "groovemap-graph-explorer"
# Source-pinned in uv.lock (git rev), so the export carries a URL instead of a version.
SOURCE_PINNED = {"groovemap-runtime"}
REQUIREMENT = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:==\s*(?P<version>[^\s;\\]+)|@\s*\S+)")


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_lock(text: str) -> dict[str, str | None]:
    pins: dict[str, str | None] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "--")):
            continue
        match = REQUIREMENT.match(line)
        if match is None:
            raise ValueError(f"unparseable lock line: {line!r}")
        pins[normalize(match["name"])] = match["version"]
    return pins


def installed_distributions() -> dict[str, str]:
    return {normalize(dist.metadata["Name"]): dist.version for dist in metadata.distributions()}


def compare(locked: dict[str, str | None], installed: dict[str, str]) -> list[str]:
    errors: list[str] = []
    installed = {name: version for name, version in installed.items() if name != PROJECT}
    if PROJECT in locked:
        locked = {name: version for name, version in locked.items() if name != PROJECT}
    for name, version in sorted(locked.items()):
        if name not in installed:
            errors.append(f"locked distribution not installed: {name}")
        elif version is not None and installed[name] != version:
            errors.append(f"{name}: installed {installed[name]} but uv.lock pins {version}")
    for name in sorted(set(installed) - set(locked)):
        errors.append(f"installed distribution not in uv.lock: {name}=={installed[name]}")
    for name in sorted(SOURCE_PINNED - set(locked)):
        errors.append(f"lock is missing source-pinned distribution: {name}")
    return errors


def pip_check() -> list[str]:
    # The venv has no pip of its own; drive the base interpreter's pip against it.
    base_python = Path(sys.base_prefix) / "bin" / "python"
    result = subprocess.run(  # noqa: S603 - fixed argv, no untrusted input
        [str(base_python), "-m", "pip", "--python", sys.executable, "check"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return []
    return [f"pip check: {line}" for line in (result.stdout + result.stderr).splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK, help="requirements file, or - for stdin")
    args = parser.parse_args()
    lock_text = sys.stdin.read() if str(args.lock) == "-" else args.lock.read_text()
    errors = compare(parse_lock(lock_text), installed_distributions())
    errors.extend(pip_check())
    for error in errors:
        print(f"FAIL {error}", file=sys.stderr)
    if errors:
        return 1
    print(f"OK image dependencies match {args.lock} and pip check is clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
