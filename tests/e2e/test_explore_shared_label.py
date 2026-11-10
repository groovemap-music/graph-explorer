"""E2E: a label whose name is shared with another label is explored and expanded as the one the visitor picked.

The Catalog API is the in-process mock (tests/explore_test_app.py). Its explore and expand answer by label id,
and a bare name shared by several labels answers 409 with the candidates, as the producer does. What is asserted
is which id the browser sent, and what the Explore pane showed for it.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from playwright.sync_api import Page, Request, expect


pytestmark = pytest.mark.e2e


def _record_requests(page: Page, path: str) -> list[dict[str, list[str]]]:
    """Every request to `path` the page sent, as parsed query strings, in order."""
    queries: list[dict[str, list[str]]] = []

    def on_request(request: Request) -> None:
        url = urlsplit(request.url)
        # Exact path: "/api/explore" must not also catch "/api/explore/year-range" and the other explore routes.
        if url.path == path:
            queries.append(parse_qs(url.query))

    page.on("request", on_request)
    return queries


def _open_explore_with_label_search(page: Page, explore_url: str) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(explore_url)
    _choose_label_search_type(page)
    expect(page.locator("#searchTypeBtn")).to_have_text("Label")
    return errors


def _choose_label_search_type(page: Page) -> None:
    """Pick Label in the search-type dropdown.

    The dropdown's @click.outside can close it on the same tick as the button click (the flake
    tests/test_explore_ui.py works around), so the click is retried once if the item is not shown.
    """
    button = page.locator("#searchTypeBtn")
    item = page.locator('div.relative:has(#searchTypeBtn) [data-type="label"]')
    button.click()
    try:
        expect(item).to_be_visible(timeout=2000)
    except AssertionError:
        button.click()
        expect(item).to_be_visible(timeout=5000)
    item.click()


def test_a_bare_shared_name_in_explore_lists_the_labels_and_explores_the_one_picked(page: Page, explore_url: str) -> None:
    explores = _record_requests(page, "/api/explore")
    errors = _open_explore_with_label_search(page, explore_url)

    search = page.locator("#searchInput")
    search.fill("808")
    search.press("Enter")

    picker = page.locator("#graphAmbiguous")
    expect(picker).to_be_visible()
    expect(picker.locator("button")).to_have_text(["808 (id 808-a)", "808 (id 808-b)"])
    assert explores[-1] == {"name": ["808"], "type": ["label"]}, "a bare name was sent with an id"

    picker.locator("button", has_text="808-b").click()

    expect(picker).to_be_hidden()
    assert explores[-1] == {"name": ["808"], "type": ["label"], "id": ["808-b"]}
    assert errors == [], f"the browser reported page errors: {errors}"


def test_picking_a_shared_name_from_autocomplete_expands_its_categories_by_id(page: Page, explore_url: str) -> None:
    explores = _record_requests(page, "/api/explore")
    expands = _record_requests(page, "/api/expand")
    errors = _open_explore_with_label_search(page, explore_url)

    page.locator("#searchInput").fill("808")
    second = page.locator(".autocomplete-item", has_text="808").nth(1)
    expect(second).to_be_visible()
    second.click()

    expect(page.locator("#graphAmbiguous")).to_be_hidden()
    assert explores[-1] == {"name": ["808"], "type": ["label"], "id": ["808-b"]}
    # The centre's categories are expanded under the same label: the name stays the node id, the id picks the label.
    expect(page.locator("#graphPlaceholder")).to_be_hidden()
    assert expands, "no /api/expand request was sent after the label was explored"
    assert all(query.get("id") == ["808-b"] for query in expands), f"an expand ignored the picked id: {expands}"
    assert all(query.get("node_id") == ["808"] and query.get("type") == ["label"] for query in expands)
    assert errors == [], f"the browser reported page errors: {errors}"
