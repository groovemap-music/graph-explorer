"""The e2e app's mock GET /api/fit/release/{id} answers like the promoted contract's route."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from tests.explore_test_app import MOCK_APP_TOKEN_PREFIX, create_test_app, style_atlas_response, taste_projection_response


CONTRACT = Path(__file__).parents[1] / "contracts" / "catalog-api" / "graph-explorer" / "v1" / "routes.json"
COMPONENTS = ("affinity", "novelty", "bridge", "depth", "redundancy")
ITEM_KEYS = ("dimension", "entity", "kind", "count", "release_id", "detail")


def _profile(token: str) -> dict:
    with TestClient(create_test_app()) as client:
        response = client.get("/api/fit/release/249504", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    return response.json()


def test_the_route_is_in_the_promoted_contract() -> None:
    operations = json.loads(CONTRACT.read_text())["operations"]
    assert operations["fit_release"] == {"method": "GET", "path": "/api/fit/release/{release_id}"}


def test_an_anonymous_caller_gets_a_401() -> None:
    with TestClient(create_test_app()) as client:
        assert client.get("/api/fit/release/249504").status_code == 401


def test_a_session_gets_uncapped_entries_whose_head_is_the_capped_evidence() -> None:
    """Below the cap, entry i is item i with keys added, and every entry says whether it is drawable."""
    components = _profile("mock-session")["components"]
    for name in COMPONENTS:
        component = components[name]
        entries = component["evidence_entries"]
        assert len(component["evidence"]) == len(component["evidence_items"]) == min(3, len(entries))
        assert component["evidence_items"] == [{key: entry[key] for key in ITEM_KEYS if key in entry} for entry in entries[:3]]
        assert all(isinstance(entry["drawable"], bool) for entry in entries)
        assert all(("entity_id" in entry) == ("entity_type" in entry) for entry in entries)
    # The cap hides a drawable unheld style behind an artist and two labels.
    assert [entry["entity"] for entry in components["novelty"]["evidence_entries"] if entry["drawable"]] == ["Glass Drift", "Hi NRG"]
    assert not any(entry["drawable"] for entry in components["novelty"]["evidence_entries"][:3])


def test_an_app_token_never_gets_the_entries() -> None:
    components = _profile(f"{MOCK_APP_TOKEN_PREFIX}delegated")["components"]
    assert all("evidence_entries" not in components[name] for name in COMPONENTS)
    assert components["affinity"]["evidence"][0] == "shares artist Rick Astley with 2 releases you hold"


def test_the_drawable_entries_name_the_recorded_atlas() -> None:
    """Every drawable genre and style is an atlas node but Hi NRG, the bridge joins two atlas genres, and the duplicate's master is a landmark the collector holds."""
    atlas = style_atlas_response()
    genres = {genre["genre"] for genre in atlas["genres"]}
    styles = {style["style"] for style in atlas["styles"]}
    components = _profile("mock-session")["components"]
    drawn = [(name, entry) for name in COMPONENTS for entry in components[name]["evidence_entries"] if entry["drawable"]]
    assert {name for name, _ in drawn} == {"affinity", "novelty", "bridge", "redundancy"}
    nodes = {entry["entity_id"] for name, entry in drawn if name in ("affinity", "novelty")}
    assert nodes - genres - styles == {"Hi NRG"}
    (bridge,) = [entry for name, entry in drawn if name == "bridge"]
    assert set(bridge["genres"]) <= genres
    (duplicate,) = [entry for name, entry in drawn if name == "redundancy"]
    assert duplicate["master_id"] in {str(master["master_id"]) for master in atlas["masters"]}
    assert duplicate["master_id"] in {master["id"] for master in taste_projection_response()["masters"]}
    # Depth, and every artist or label, is listed, never drawn.
    assert not any(entry["drawable"] for entry in components["depth"]["evidence_entries"])
    assert all(entry.get("entity_type") not in ("artist", "label") for _, entry in drawn)
