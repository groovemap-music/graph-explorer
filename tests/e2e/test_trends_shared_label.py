"""E2E: a label whose name is shared with another label charts the one the visitor picked.

The Catalog API is the in-process mock (tests/explore_test_app.py). Its label trends are keyed by id, and a
bare name shared by several labels answers 409 with the candidates, as the producer does. What is asserted is
which id the browser sent, and what the Trends pane showed for it.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from playwright.sync_api import Page, Request, expect


pytestmark = pytest.mark.e2e


def _record_trends_requests(page: Page) -> list[dict[str, list[str]]]:
    """Every /api/trends query the page sent, in order."""
    queries: list[dict[str, list[str]]] = []

    def on_request(request: Request) -> None:
        if "/api/trends" in request.url:
            queries.append(parse_qs(urlsplit(request.url).query))

    page.on("request", on_request)
    return queries


def _open_trends_with_label_search(page: Page, explore_url: str) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(explore_url)
    page.locator('a.nav-link[data-pane="trends"]').click()
    page.locator("#searchTypeBtn").click()
    page.locator('[data-type="label"]').first.click()
    expect(page.locator("#searchTypeBtn")).to_have_text("Label")
    return errors


def test_picking_a_shared_name_from_autocomplete_charts_that_label_by_id(page: Page, explore_url: str) -> None:
    queries = _record_trends_requests(page)
    errors = _open_trends_with_label_search(page, explore_url)

    page.locator("#searchInput").fill("808")
    second = page.locator(".autocomplete-item", has_text="808").nth(1)
    expect(second).to_be_visible()
    second.click()

    expect(page.locator("#trendsPlaceholder")).to_be_hidden()
    expect(page.locator("#trendsAmbiguous")).to_be_hidden()
    assert queries, "no /api/trends request was sent"
    assert queries[-1] == {"name": ["808"], "type": ["label"], "id": ["808-b"]}
    assert errors == [], f"the browser reported page errors: {errors}"


def test_a_bare_shared_name_lists_the_labels_and_charts_the_one_picked(page: Page, explore_url: str) -> None:
    queries = _record_trends_requests(page)
    errors = _open_trends_with_label_search(page, explore_url)

    search = page.locator("#searchInput")
    search.fill("808")
    search.press("Enter")

    picker = page.locator("#trendsAmbiguous")
    expect(picker).to_be_visible()
    expect(picker.locator("button")).to_have_text(["808 (id 808-a)", "808 (id 808-b)"])
    expect(page.locator("#trendsPlaceholder")).to_be_hidden()
    assert queries[-1] == {"name": ["808"], "type": ["label"]}, "a bare name was sent with an id"

    picker.locator("button", has_text="808-b").click()

    expect(picker).to_be_hidden()
    expect(page.locator("#trendsPlaceholder")).to_be_hidden()
    assert queries[-1] == {"name": ["808"], "type": ["label"], "id": ["808-b"]}
    assert errors == [], f"the browser reported page errors: {errors}"
