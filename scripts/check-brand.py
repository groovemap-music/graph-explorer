"""Verify promoted deterministic brand assets and their source provenance."""

import json
from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "explore/static/brand"
PRODUCER_REPOSITORY = "https://github.com/groovemap-music/design"
PRODUCER_COMMIT = "109cbd5bddcc699426e2406c8de486e012a30f5a"
source = json.loads((BRAND / "source.json").read_text())
assert source["producer_repository"] == PRODUCER_REPOSITORY
assert source["producer_commit"] == PRODUCER_COMMIT
assert set(source["assets"]) == {path.name for path in BRAND.iterdir() if path.is_file() and path.name != "source.json"}
for name, expected in source["assets"].items():
    assert sha256((BRAND / name).read_bytes()).hexdigest() == expected, name
