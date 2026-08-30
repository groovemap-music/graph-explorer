#!/usr/bin/env python3
"""Verify third-party web notices cross wheel, image, and dry-run boundaries."""

from __future__ import annotations

import json
import sys
import zipfile
from email.parser import BytesParser
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
    names = archive.namelist()
    actual = {name for name in names if name.startswith(PREFIX) and not name.endswith("/")}
    metadata_path = next(name for name in names if name.endswith(".dist-info/METADATA"))
    metadata = BytesParser().parsebytes(archive.read(metadata_path))
    license_files = set(metadata.get_all("License-File", []))
    legal_prefix = metadata_path.removesuffix("METADATA") + "licenses/"
    legal_files = {name.removeprefix(legal_prefix) for name in names if name.startswith(legal_prefix) and not name.endswith("/")}
require(
    actual == expected,
    f"wheel vendor tree differs from its deterministic map: missing={sorted(expected - actual)}, unclassified={sorted(actual - expected)}",
)
expected_legal_files = {"LICENSE", "NOTICE", "COMMERCIAL-LICENSING.md", "BRAND-NOTICE.md"}
require(metadata["License-Expression"] == "AGPL-3.0-only", "wheel metadata does not declare AGPL-3.0-only")
require(license_files == expected_legal_files, f"wheel License-File headers differ: {sorted(license_files)}")
require(legal_files == expected_legal_files, f"wheel legal files differ: {sorted(legal_files)}")
require(PREFIX.replace("vendor/", "brand/source.json") in names, "wheel omits promoted brand provenance")

dockerfile = (ROOT / "Dockerfile").read_text()
build_image = (ROOT / "scripts/build-image.sh").read_text()
release_dry_run = (ROOT / "scripts/release-dry-run.sh").read_text()
require(
    "COPY --from=css-builder /build/explore/static/vendor/ ./explore/static/vendor/" in dockerfile,
    "Docker image does not receive the validated vendor tree",
)
require("THIRD_PARTY_NOTICES.md" in build_image and "ASSET_LICENSES.json" in build_image, "image validation omits web notices")
require("BRAND-NOTICE.md" in build_image, "image validation omits the brand notice")
require("WEB_THIRD_PARTY_NOTICES" in release_dry_run, "release dry-run omits web notices")
require("dist/LEGAL" in release_dry_run, "release dry-run omits first-party legal files")
