"""E2E: a path to a label whose name is shared with another label resolves to the one the visitor picked.

The Catalog API is the in-process mock (tests/explore_test_app.py). Its path route answers a bare shared name with 409
and the candidates, and resolves a label id to a path, as the producer does. What is asserted is which ids the browser
sent to /api/path, and what the Find Path pane showed.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from playwright.sync_api import Page, Request, expect


pytestmark = pytest.mark.e2e


def _record_path_requests(page: Page) -> list[dict[str, list[str]]]:
    """Every request to /api/path the page sent, as parsed query strings, in order."""
    queries: list[dict[str, list[str]]] = []

    def on_request(request: Request) -> None:
        url = urlsplit(request.url)
        if url.path == "/api/path":
            queries.append(parse_qs(url.query))

    page.on("request", on_request)
    return queries


def _open_path_pane_with_label_end(page: Page, explore_url: str, end: str) -> list[str]:
    """Open the Find Path pane and set one end's type to Label. `end` is "from" or "to"."""
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(explore_url)
    page.locator('.nav-link[data-pane="path"]').click()
    expect(page.locator("#pathPane")).to_be_visible()

    button = page.locator("#pathFromTypeBtn" if end == "from" else "#pathToTypeBtn")
    item = page.locator(f'[data-path-{end}-type="label"]')
    button.click()
    try:
        expect(item).to_be_visible(timeout=2000)
    except AssertionError:
        button.click()
        expect(item).to_be_visible(timeout=5000)
    item.click()
    expect(button).to_have_text("Label")
    return errors


def test_a_bare_shared_name_in_the_path_lists_the_labels_and_retries_with_the_one_picked(page: Page, explore_url: str) -> None:
    paths = _record_path_requests(page)
    errors = _open_path_pane_with_label_end(page, explore_url, "from")

    page.locator("#pathFromInput").fill("808")
    page.locator("#pathToInput").fill("Radiohead")
    page.locator("#pathConnectBtn").click()

    picker = page.locator("#pathAmbiguous")
    expect(picker).to_be_visible()
    expect(picker.locator("button")).to_have_text(["808 (id 808-a)", "808 (id 808-b)"])
    expect(page.locator("#pathError")).to_be_hidden()
    assert paths[-1] == {"from_name": ["808"], "from_type": ["label"], "to_name": ["Radiohead"], "to_type": ["artist"], "max_depth": ["10"]}

    picker.locator("button", has_text="808-b").click()

    expect(picker).to_be_hidden()
    expect(page.locator("#pathResultSummary")).to_contain_text("1 hop")
    assert paths[-1]["from_name"] == ["808"], "the name is still sent with the id"
    assert paths[-1]["from_id"] == ["808-b"]
    assert "to_id" not in paths[-1]
    assert errors == [], f"the browser reported page errors: {errors}"


def test_picking_a_shared_name_from_autocomplete_sends_its_id_without_a_409(page: Page, explore_url: str) -> None:
    paths = _record_path_requests(page)
    errors = _open_path_pane_with_label_end(page, explore_url, "to")

    page.locator("#pathFromInput").fill("Radiohead")
    page.locator("#pathToInput").fill("808")
    second = page.locator("#pathToDropdown .autocomplete-item", has_text="808").nth(1)
    expect(second).to_be_visible()
    second.dispatch_event("mousedown")

    page.locator("#pathConnectBtn").click()

    expect(page.locator("#pathResultSummary")).to_contain_text("1 hop")
    expect(page.locator("#pathAmbiguous")).to_be_hidden()
    assert paths, "no /api/path request was sent"
    assert paths[-1]["to_name"] == ["808"]
    assert paths[-1]["to_id"] == ["808-b"], f"the picked label id was not sent: {paths[-1]}"
    assert "from_id" not in paths[-1]
    assert errors == [], f"the browser reported page errors: {errors}"


def test_typing_after_a_pick_drops_the_id_so_the_next_connect_sends_the_name_alone(page: Page, explore_url: str) -> None:
    paths = _record_path_requests(page)
    errors = _open_path_pane_with_label_end(page, explore_url, "from")

    page.locator("#pathToInput").fill("Radiohead")
    from_input = page.locator("#pathFromInput")
    from_input.fill("808")
    second = page.locator("#pathFromDropdown .autocomplete-item", has_text="808").nth(1)
    expect(second).to_be_visible()
    second.dispatch_event("mousedown")
    from_input.fill("808 ")

    # Enter connects from the from-input. The open to-end suggestion list covers the Connect button on a phone width.
    from_input.press("Enter")

    expect(page.locator("#pathAmbiguous")).to_be_visible()
    assert "from_id" not in paths[-1], f"a stale id was sent after typing: {paths[-1]}"
    assert errors == [], f"the browser reported page errors: {errors}"
