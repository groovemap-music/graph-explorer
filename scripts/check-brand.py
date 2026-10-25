"""Verify promoted deterministic brand assets and their source provenance."""

import json
from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "explore/static/brand"
PRODUCER_REPOSITORY = "https://github.com/groovemap-music/design"
PRODUCER_COMMIT = "7abe13ad3e22e81b5437eb92acb8db998730e11a"
source = json.loads((BRAND / "source.json").read_text())
assert source["producer_repository"] == PRODUCER_REPOSITORY
assert source["producer_commit"] == PRODUCER_COMMIT
assert set(source["assets"]) == {path.name for path in BRAND.iterdir() if path.is_file() and path.name != "source.json"}
for name, expected in source["assets"].items():
    assert sha256((BRAND / name).read_bytes()).hexdigest() == expected, name
