"""Verify the promoted Catalog API route contract and consumer route usage."""

import json
import re
from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_ROOT = ROOT / "contracts/catalog-api/graph-explorer/v1"
source = json.loads((CONTRACT_ROOT / "source.json").read_text())
contract_path = CONTRACT_ROOT / "routes.json"
contract = json.loads(contract_path.read_text())
assert sha256(contract_path.read_bytes()).hexdigest() == source["contract_sha256"]
assert source["version"] == contract["version"] == 1
assert len(source["producer_commit"]) == 40


def route_pattern(path: str) -> re.Pattern[str]:
    """Convert a producer path template into a full-match expression."""
    pieces = re.split(r"(\{[^}]+\})", path)
    return re.compile("^" + "".join("[^/]+" if piece.startswith("{") else re.escape(piece) for piece in pieces) + "$")


patterns = [route_pattern(operation["path"]) for operation in contract["operations"].values()]
literal_pattern = re.compile(r"['\"`](/api/[^'\"`? ]+)")
for javascript in sorted((ROOT / "explore/static/js").glob("*.js")):
    for literal in literal_pattern.findall(javascript.read_text()):
        concrete = literal.replace("${entityType}", "artist")
        concrete = re.sub(r"\$\{[^}]+\}", "value", concrete)
        assert any(pattern.fullmatch(concrete) for pattern in patterns), f"uncontracted Catalog API route in {javascript.name}: {literal}"
