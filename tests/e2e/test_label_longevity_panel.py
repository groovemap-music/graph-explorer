"""E2E: a label's detail panel shows its own longevity, matched by label id.

The label-details and label-longevity endpoints are stood in for with Playwright routes, so what is asserted is
what the real browser rendered from the bodies it was sent: the span and peak decade of that exact label (two
labels share a name here), its full-catalog rank when the producer stamped it (#N of M, with separators), its rank
from the stored top 50 when it did not (the older-API fallback), the placeholder explanation with no rank even when
the producer sent a total, and an empty state for a label with no dated releases.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from playwright.sync_api import Page, Route, expect


pytestmark = pytest.mark.e2e

_COLUMBIA_OLD = {
    "id": "1",
    "name": "Columbia",
    "release_count": 351183,
    "is_placeholder": False,
    "first_year": 1889,
    "last_year": None,
    "years_active": 137,
    "total_releases": 351183,
    "peak_decade": 1960,
}
_COLUMBIA_SAME_NAME = {
    **_COLUMBIA_OLD,
    "id": "2",
    "release_count": 12,
    "first_year": 1999,
    "last_year": 2004,
    "years_active": 5,
    "total_releases": 12,
    "peak_decade": 2000,
}
_NOT_ON_LABEL = {
    **_COLUMBIA_OLD,
    "id": "0",
    "name": "Not On Label",
    "is_placeholder": True,
    "longevity_rank": None,
    "longevity_rank_of": 929239,
}
_UNDATED = {
    "id": "3",
    "name": "<b>Undated</b> & Co",
    "release_count": 4,
    "is_placeholder": False,
    "first_year": None,
    "last_year": None,
    "years_active": 0,
    "total_releases": 0,
    "peak_decade": None,
}
# Polydor is stamped by the producer (sweep v4): its full-catalog rank replaces the top-50 lookup.
_POLYDOR = {
    **_COLUMBIA_OLD,
    "id": "4",
    "name": "Polydor",
    "release_count": 88412,
    "first_year": 1610,
    "last_year": None,
    "years_active": 416,
    "total_releases": 88412,
    "peak_decade": 1970,
    "longevity_rank": 15,
    "longevity_rank_of": 929239,
}
_NODES = {node["id"]: node for node in (_COLUMBIA_OLD, _COLUMBIA_SAME_NAME, _NOT_ON_LABEL, _UNDATED, _POLYDOR)}
_TOP_50 = [
    {
        "rank": 1,
        "label_id": "1",
        "label_name": "Columbia",
        "first_year": 1889,
        "last_year": None,
        "years_active": 137,
        "total_releases": 351183,
        "peak_decade": 1960,
        "still_active": True,
        "is_placeholder": False,
    },
]


def _json(route: Route, body: dict[str, Any]) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def _open_label(page: Page, node_id: str) -> None:
    page.evaluate(f"window.exploreApp._onNodeClick('{node_id}', 'label')")


def test_label_panel_shows_its_own_longevity_by_id(page: Page, explore_url: str) -> None:
    longevity_requests: list[str] = []
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def node(route: Route) -> None:
        node_id = re.search(r"/api/node/([^/?]+)", route.request.url).group(1)  # type: ignore[union-attr]
        _json(route, _NODES[node_id])

    def longevity(route: Route) -> None:
        longevity_requests.append(route.request.url)
        _json(route, {"items": _TOP_50, "count": len(_TOP_50)})

    page.route(re.compile(r".*/api/node/\d+\?type=label.*"), node)
    page.route(re.compile(r".*/api/insights/label-longevity.*"), longevity)
    page.goto(explore_url)
    page.wait_for_function("() => !!window.exploreApp", timeout=10_000)
    body = page.locator("#infoPanelBody")
    block = body.locator(".label-longevity")

    _open_label(page, "1")
    expect(block).to_contain_text(re.compile(r"1889.present"))
    expect(block).to_contain_text("137")
    expect(block).to_contain_text("1960s")
    expect(block.locator(".label-longevity-rank .value")).to_have_text("#1 of the top 50")

    # Same name, different label: its own span, and not in the stored top 50.
    _open_label(page, "2")
    expect(page.locator("#infoPanelTitle")).to_have_text("Columbia")
    expect(block).to_contain_text(re.compile(r"1999.2004"))
    expect(block).to_contain_text("2000s")
    expect(block.locator(".label-longevity-rank .value")).to_have_text("outside the top 50")

    # A stamped rank is shown as #N of M with separators, and the top-50 list is not needed for it.
    _open_label(page, "4")
    expect(page.locator("#infoPanelTitle")).to_have_text("Polydor")
    expect(block).to_contain_text(re.compile(r"1610.present"))
    expect(block).to_contain_text("1970s")
    expect(block.locator(".label-longevity-rank .value")).to_have_text("#15 of 929,239")

    _open_label(page, "0")
    expect(block).to_contain_text("usually white labels, bootlegs or test pressings")
    expect(block.locator(".detail-stat")).to_have_count(0)
    expect(block).not_to_contain_text("929")  # the producer's total is never shown for a placeholder

    _open_label(page, "3")
    expect(block).to_contain_text("No dated releases")
    expect(body.locator("b")).to_have_count(0)  # the label name is never parsed as HTML

    assert len(longevity_requests) == 1, f"the top 50 is fetched once, for the fallback labels only: {longevity_requests}"
    assert "limit=50" in longevity_requests[0]
    assert errors == [], f"the browser reported page errors: {errors}"
