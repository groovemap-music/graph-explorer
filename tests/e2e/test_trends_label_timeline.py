"""E2E: the Trends pane draws the longest-running labels timeline, sharing the placeholder choice with Insights.

The insights endpoints are stood in for with Playwright routes, so what is asserted is what the real browser
drew from the body it was sent, and which query each checkbox made it send.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from playwright.sync_api import Page, Route, expect


pytestmark = pytest.mark.e2e

_REAL = [
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
    {
        "rank": 2,
        "label_id": "2",
        "label_name": "Decca",
        "first_year": 1929,
        "last_year": 1999,
        "years_active": 70,
        "total_releases": 90000,
        "peak_decade": 1950,
        "still_active": False,
        "is_placeholder": False,
    },
]
_NOT_ON_LABEL = {
    "rank": 51,
    "label_id": "0",
    "label_name": "Not On Label",
    "first_year": 1900,
    "last_year": None,
    "years_active": 126,
    "total_releases": 3000000,
    "peak_decade": 2010,
    "still_active": True,
    "is_placeholder": True,
}
_MANY = [{**_REAL[1], "rank": rank, "label_id": str(rank), "label_name": f"Label {rank}"} for rank in range(1, 51)]


def _json(route: Route, body: dict[str, Any]) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def _install_api(page: Page, requests: list[str], *, many: bool = False) -> None:
    for name in ("top-artists", "this-month", "data-completeness"):
        page.route(re.compile(rf".*/api/insights/{name}.*"), lambda route: _json(route, {"items": []}))
    page.route(re.compile(r".*/api/insights/status.*"), lambda route: _json(route, {"statuses": []}))
    page.route(re.compile(r".*/api/insights/genre-trends.*"), lambda route: _json(route, {"genre": "Rock", "items": []}))

    def items_for(url: str) -> list[dict[str, Any]]:
        if many:
            return _MANY if "limit=50" in url else _MANY[:20]
        if "include_placeholders=true" in url:
            return [_REAL[0], _NOT_ON_LABEL, _REAL[1]]
        return _REAL

    def longevity(route: Route) -> None:
        requests.append(route.request.url)
        items = items_for(route.request.url)
        _json(route, {"items": items, "count": len(items)})

    page.route(re.compile(r".*/api/insights/label-longevity.*"), longevity)


def _open(page: Page, explore_url: str, pane: str) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(explore_url)
    page.locator(f'a.nav-link[data-pane="{pane}"]').click()
    return errors


def test_timeline_draws_ranked_bars_without_a_searched_entity(page: Page, explore_url: str) -> None:
    requests: list[str] = []
    _install_api(page, requests)

    errors = _open(page, explore_url, "trends")

    section = page.locator("#labelTimelineSection")
    expect(section).to_contain_text("Longest-running labels")
    ticks = section.locator(".ytick text")
    expect(ticks).to_have_count(2)
    expect(ticks.nth(0)).to_have_text("1. Columbia")
    expect(ticks.nth(1)).to_have_text("2. Decca")
    expect(section.locator(".barlayer .point")).to_have_count(2)
    # Columbia is still active (open-ended arrow) and both labels carry a peak-decade diamond.
    expect(section.locator(".scatterlayer .trace").nth(0).locator(".point")).to_have_count(1)
    expect(section.locator(".scatterlayer .trace").nth(1).locator(".point")).to_have_count(2)
    expect(page.locator("#trendsPlaceholder")).to_be_visible()
    assert "include_placeholders" not in requests[-1]
    assert "limit=20" in requests[-1]
    assert errors == [], f"the browser reported page errors: {errors}"


def test_checkboxes_in_trends_and_insights_share_one_state(page: Page, explore_url: str) -> None:
    requests: list[str] = []
    _install_api(page, requests)
    errors = _open(page, explore_url, "trends")

    trends_box = page.get_by_label("Include placeholder labels (Not On Label, self-releases)").and_(page.locator("#trendsIncludePlaceholders"))
    ticks = page.locator("#labelTimelineSection .ytick text")
    expect(trends_box).not_to_be_checked()
    expect(ticks).to_have_count(2)

    trends_box.check()

    expect(ticks).to_have_count(3)
    expect(ticks.nth(1)).to_contain_text("Not On Label")
    expect(ticks.nth(1)).not_to_contain_text("51")
    assert "include_placeholders=true" in requests[-1]

    # The Insights checkbox agrees, and its table lists the placeholder.
    page.locator('a.nav-link[data-pane="insights"]').click()
    insights_box = page.locator("#insightsIncludePlaceholders")
    expect(insights_box).to_be_checked()
    expect(page.locator("#insightsLabelLongevity tbody tr")).to_have_count(3)

    insights_box.uncheck()
    expect(page.locator("#insightsLabelLongevity tbody tr")).to_have_count(2)

    page.locator('a.nav-link[data-pane="trends"]').click()
    expect(trends_box).not_to_be_checked()
    expect(ticks).to_have_count(2)
    expect(page.locator("#labelTimelineChart")).not_to_contain_text("Not On Label")
    assert errors == [], f"the browser reported page errors: {errors}"


def test_show_all_lists_every_stored_row(page: Page, explore_url: str) -> None:
    requests: list[str] = []
    _install_api(page, requests, many=True)
    errors = _open(page, explore_url, "trends")

    ticks = page.locator("#labelTimelineSection .ytick text")
    expect(ticks).to_have_count(20)

    page.locator("#labelTimelineShowAll").click()

    expect(ticks).to_have_count(50)
    assert "limit=50" in requests[-1]
    expect(page.locator("#labelTimelineShowAll")).to_have_text("Show top 20")
    assert errors == [], f"the browser reported page errors: {errors}"


def test_error_and_empty_states_are_shown(page: Page, explore_url: str) -> None:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route(re.compile(r".*/api/insights/label-longevity.*"), lambda route: route.fulfill(status=500, body="{}"))
    page.goto(explore_url)
    page.locator('a.nav-link[data-pane="trends"]').click()
    expect(page.locator("#labelTimelineStatus")).to_contain_text("Could not load")

    page.unroute(re.compile(r".*/api/insights/label-longevity.*"))
    page.route(re.compile(r".*/api/insights/label-longevity.*"), lambda route: _json(route, {"items": [], "count": 0}))
    page.locator("#labelTimelineShowAll").click()
    expect(page.locator("#labelTimelineStatus")).to_have_text("No label data available yet")
    assert errors == [], f"the browser reported page errors: {errors}"


def test_timeline_fits_the_viewport_width(page: Page, explore_url: str) -> None:
    requests: list[str] = []
    _install_api(page, requests)
    page.set_viewport_size({"width": 375, "height": 700})
    errors = _open(page, explore_url, "trends")

    expect(page.locator("#labelTimelineSection .ytick text")).to_have_count(2)
    box = page.locator("#labelTimelineChart").bounding_box()
    assert box is not None
    assert box["x"] >= 0
    assert box["x"] + box["width"] <= 375 + 1, f"the chart overflows a phone viewport: {box}"
    assert errors == [], f"the browser reported page errors: {errors}"
