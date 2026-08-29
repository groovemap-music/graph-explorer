#!/usr/bin/env python3
"""Verify third-party web notices cross wheel, image, and dry-run boundaries."""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "explore/static/vendor/"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


require(len(sys.argv) == 2, "usage: check-vendor-artifacts.py WHEEL")
wheel = Path(sys.argv[1])
manifest = json.loads((ROOT / "explore/vendor-assets.json").read_text())
expected = {
    *(PREFIX + output for asset in manifest["assets"] for output in asset["outputs"]),
    *(PREFIX + asset["license_destination"] for asset in manifest["assets"]),
    PREFIX + "ASSET_LICENSES.json",
    PREFIX + "THIRD_PARTY_NOTICES.md",
}
with zipfile.ZipFile(wheel) as archive:
    actual = {name for name in archive.namelist() if name.startswith(PREFIX) and not name.endswith("/")}
require(
    actual == expected,
    f"wheel vendor tree differs from its deterministic map: missing={sorted(expected - actual)}, unclassified={sorted(actual - expected)}",
)

dockerfile = (ROOT / "Dockerfile").read_text()
build_image = (ROOT / "scripts/build-image.sh").read_text()
release_dry_run = (ROOT / "scripts/release-dry-run.sh").read_text()
require(
    "COPY --from=css-builder /build/explore/static/vendor/ ./explore/static/vendor/" in dockerfile,
    "Docker image does not receive the validated vendor tree",
)
require("THIRD_PARTY_NOTICES.md" in build_image and "ASSET_LICENSES.json" in build_image, "image validation omits web notices")
require("WEB_THIRD_PARTY_NOTICES" in release_dry_run, "release dry-run omits web notices")
