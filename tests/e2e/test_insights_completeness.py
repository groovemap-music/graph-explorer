"""E2E: the Insights panel shows a null completeness as n/a and still renders everything else.

Artists and labels have no scorable field once images left the completeness score, so the API sends
``completeness_pct: null`` for them. ``null.toFixed`` used to throw inside ``_renderDataCompleteness`` and
leave the panel half rendered. The insights endpoints are stood in for with Playwright routes, so what is
asserted is what the real browser rendered from the body it was sent.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from playwright.sync_api import Page, Route, expect


pytestmark = pytest.mark.e2e


def _json(route: Route, body: dict[str, Any]) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def _install_insights_api(page: Page, completeness: list[dict[str, Any]]) -> None:
    page.route(
        re.compile(r".*/api/insights/top-artists.*"),
        lambda route: _json(route, {"items": [{"rank": 1, "artist_id": "1", "artist_name": "Ann Other", "edge_count": 42}]}),
    )
    page.route(re.compile(r".*/api/insights/this-month.*"), lambda route: _json(route, {"items": []}))
    page.route(re.compile(r".*/api/insights/data-completeness.*"), lambda route: _json(route, {"items": completeness}))
    page.route(re.compile(r".*/api/insights/status.*"), lambda route: _json(route, {"statuses": []}))
    page.route(re.compile(r".*/api/insights/genre-trends.*"), lambda route: _json(route, {"genre": "Rock", "items": []}))


def _open_insights(page: Page, explore_url: str) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(explore_url)
    page.locator('a.nav-link[data-pane="insights"]').click()
    return errors


def test_a_null_completeness_renders_as_n_a_with_an_empty_bar_and_the_panel_still_renders(page: Page, explore_url: str) -> None:
    _install_insights_api(
        page,
        [
            {"entity_type": "releases", "completeness_pct": 89.5, "total_count": 15000000},
            {"entity_type": "artists", "completeness_pct": None, "total_count": 8000000},
            {"entity_type": "labels", "completeness_pct": None, "total_count": 40000},
        ],
    )

    errors = _open_insights(page, explore_url)

    rows = page.locator(".insights-completeness-row")
    expect(rows).to_have_count(3)
    expect(rows.nth(0).locator(".insights-completeness-pct")).to_have_text("89.5%")
    for index in (1, 2):
        expect(rows.nth(index).locator(".insights-completeness-pct")).to_have_text("n/a")
        assert rows.nth(index).locator(".insights-completeness-bar").evaluate("element => element.style.width") == "0%"
    # What renders after the completeness section, and before it, is not lost to a throw.
    expect(page.locator("#insightsTopArtists")).to_contain_text("Ann Other")
    expect(page.locator("#insightsStatus")).to_be_attached()
    assert errors == [], f"the browser reported page errors: {errors}"


def test_numeric_values_render_as_before(page: Page, explore_url: str) -> None:
    _install_insights_api(
        page,
        [
            {"entity_type": "releases", "completeness_pct": 89.5, "total_count": 15000000},
            {"entity_type": "masters", "completeness_pct": 0, "total_count": 10},
        ],
    )

    errors = _open_insights(page, explore_url)

    rows = page.locator(".insights-completeness-row")
    expect(rows).to_have_count(2)
    expect(rows.nth(0).locator(".insights-completeness-pct")).to_have_text("89.5%")
    expect(rows.nth(1).locator(".insights-completeness-pct")).to_have_text("0.0%")
    assert errors == []
