"""The e2e app's mock GET /api/user/taste-projection answers like the promoted contract's route."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from tests.explore_test_app import create_test_app, style_atlas_response


CONTRACT = Path(__file__).parents[1] / "contracts" / "catalog-api" / "graph-explorer" / "v1" / "routes.json"


def test_the_route_is_in_the_promoted_contract() -> None:
    operations = json.loads(CONTRACT.read_text())["operations"]
    assert operations["user_taste_projection"] == {"method": "GET", "path": "/api/user/taste-projection"}


def test_an_anonymous_caller_gets_a_401() -> None:
    with TestClient(create_test_app()) as client:
        assert client.get("/api/user/taste-projection").status_code == 401


def test_a_signed_in_caller_gets_the_synthetic_projection_never_cached() -> None:
    with TestClient(create_test_app()) as client:
        response = client.get("/api/user/taste-projection", headers={"Authorization": "Bearer mock"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"totals", "recorded_at", "genres", "styles", "masters"}
    assert body["totals"]["items"] == 7
    assert body["totals"]["masterless_items"] == 2


def test_the_projection_names_the_recorded_atlas_nodes() -> None:
    """Every genre and all but one style are atlas nodes; Phantom Fizz is the one the atlas does not draw."""
    atlas = style_atlas_response()
    with TestClient(create_test_app()) as client:
        body = client.get("/api/user/taste-projection", headers={"Authorization": "Bearer mock"}).json()
    genres = {genre["genre"] for genre in atlas["genres"]}
    styles = {style["style"] for style in atlas["styles"]}
    assert {genre["id"] for genre in body["genres"]} <= genres
    assert {style["id"] for style in body["styles"]} - styles == {"Phantom Fizz"}
    landmarks = {str(master["master_id"]) for master in atlas["masters"]}
    assert [master["id"] for master in body["masters"] if master["id"] in landmarks] == ["910001"]
