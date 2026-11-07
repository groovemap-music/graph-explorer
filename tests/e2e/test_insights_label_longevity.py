"""E2E: the Insights pane lists the longest-running labels, hiding placeholder labels until asked.

The insights endpoints are stood in for with Playwright routes, so what is asserted is what the real browser
rendered from the body it was sent, and which query the checkbox made it send.
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
# The stored rank (51) sits after every real label's; the pane must never show it.
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


def _json(route: Route, body: dict[str, Any]) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def _install_insights_api(page: Page, requests: list[str]) -> None:
    page.route(re.compile(r".*/api/insights/top-artists.*"), lambda route: _json(route, {"items": []}))
    page.route(re.compile(r".*/api/insights/this-month.*"), lambda route: _json(route, {"items": []}))
    page.route(re.compile(r".*/api/insights/data-completeness.*"), lambda route: _json(route, {"items": []}))
    page.route(re.compile(r".*/api/insights/status.*"), lambda route: _json(route, {"statuses": []}))
    page.route(re.compile(r".*/api/insights/genre-trends.*"), lambda route: _json(route, {"genre": "Rock", "items": []}))

    def longevity(route: Route) -> None:
        requests.append(route.request.url)
        include = "include_placeholders=true" in route.request.url
        items = [_REAL[0], _NOT_ON_LABEL, _REAL[1]] if include else _REAL
        _json(route, {"items": items, "count": len(items)})

    page.route(re.compile(r".*/api/insights/label-longevity.*"), longevity)


def _open_insights(page: Page, explore_url: str) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(explore_url)
    page.locator('a.nav-link[data-pane="insights"]').click()
    return errors


def test_placeholder_labels_are_hidden_by_default_and_shown_marked_when_asked(page: Page, explore_url: str) -> None:
    requests: list[str] = []
    _install_insights_api(page, requests)

    errors = _open_insights(page, explore_url)

    section = page.locator("#insightsLabelLongevitySection")
    expect(section.locator(".insights-section-title")).to_contain_text("Longest-running labels")
    toggle = section.get_by_label("Include placeholder labels (Not On Label, self-releases)")
    expect(toggle).not_to_be_checked()
    rows = section.locator("tbody tr")
    expect(rows).to_have_count(2)
    expect(section).not_to_contain_text("Not On Label")
    assert "include_placeholders" not in requests[-1]

    toggle.check()

    expect(rows).to_have_count(3)
    placeholder = rows.nth(1)
    expect(placeholder).to_contain_text("Not On Label")
    expect(placeholder.locator("td").first).to_have_text("placeholder")
    expect(placeholder).to_contain_text("usually white labels, bootlegs or test pressings")
    expect(placeholder).not_to_contain_text("51")
    # The real labels keep their ranks.
    expect(rows.nth(0).locator("td").first).to_have_text("1")
    expect(rows.nth(2).locator("td").first).to_have_text("2")
    assert "include_placeholders=true" in requests[-1]

    toggle.uncheck()

    expect(rows).to_have_count(2)
    expect(section).not_to_contain_text("Not On Label")
    assert errors == [], f"the browser reported page errors: {errors}"
