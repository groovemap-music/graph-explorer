"""Consumer-facing request contracts for Missing and owner-copy reads."""

import json
from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_DIR = ROOT / "contracts/catalog-api/graph-explorer/v1"


def test_promoted_contract_pins_the_producer_routes_and_digest() -> None:
    source = json.loads((CONTRACT_DIR / "source.json").read_text())
    routes_path = CONTRACT_DIR / "routes.json"
    routes = json.loads(routes_path.read_text())

    assert source["producer_commit"] == "fab7e993384f032a0ea78817cbdcba798a2e97f8"
    assert source["contract_sha256"] == sha256(routes_path.read_bytes()).hexdigest()
    assert routes["operations"]["user_missing_preview"] == {
        "method": "POST",
        "path": "/api/user/missing/preview",
    }
    assert routes["operations"]["user_items_copies"] == {
        "method": "GET",
        "path": "/api/user/items/{native_item_id}/copies",
        "parameters": ["limit"],
    }
    assert routes["operations"]["user_copies_observations_list"] == {
        "method": "GET",
        "path": "/api/user/copies/{copy_id}/observations",
    }


def test_browser_methods_use_only_contract_parameters_and_never_send_owner_ids() -> None:
    client = (ROOT / "explore/static/js/api-client.js").read_text()

    assert "async previewMissing(token, targetKind, targetId, limit = 100)" in client
    assert "JSON.stringify({ target_kind: targetKind, target_id: String(targetId), limit })" in client
    assert "async getOwnedCopies(token, nativeItemId, limit = 50)" in client
    assert "new URLSearchParams({ limit: String(limit) })" in client
    assert "async getCopyObservations(token, copyId)" in client
    assert "owner_id" not in client
