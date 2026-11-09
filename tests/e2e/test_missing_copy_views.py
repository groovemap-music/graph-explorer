"""Synthetic contract journeys for transient Missing and private selected-copy evidence."""

from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

from tests.e2e.test_discography_strata import ARTIST, _open_artist


@pytest.mark.e2e
def test_transient_missing_scope(page: Page, explore_url: str) -> None:
    """The existing Missing action explains partial evidence and retains usable list filters."""
    page.route(
        "**/api/user/missing/preview",
        lambda route: route.fulfill(
            json={
                "preview": {
                    "catalog_snapshot_id": "synthetic-catalog-window",
                    "collection_snapshot_id": "synthetic-owner-window",
                    "denominator_evidence": {
                        "denominator": 3,
                        "owned": 1,
                        "missing": 0,
                        "ownership_review": 2,
                        "needs_review": 1,
                        "excluded": 0,
                        "denominator_complete": False,
                        "ownership_complete": False,
                        "completion_fraction": None,
                    },
                },
                "sources": {
                    "catalog": {"status": "observed", "truncated": True, "limit": 100, "version": None},
                    "aliases": {"status": "observed", "version": None},
                    "ownership": {"status": "unavailable", "version": None},
                },
                "scope_basis": "bounded_neo4j_projection_not_provider_universe",
                "consistency": "independent_read_windows_no_shared_snapshot",
                "co_release_policy": "needs_review",
            }
        ),
    )
    page.route("**/api/collection/media", lambda route: route.fulfill(json={"families": [], "mediums": []}))
    page.route(
        "**/api/collection/gaps/**",
        lambda route: route.fulfill(json={"entity": {"type": "artist", "name": ARTIST}, "summary": {}, "results": [], "pagination": {"total": 0}}),
    )
    _open_artist(page, explore_url, ARTIST)
    page.locator("g").filter(has=page.locator("text.node-label", has_text=ARTIST)).last.locator("circle").first.click()
    missing = page.get_by_role("button", name="What am I missing?", exact=False)
    expect(missing).to_be_visible()
    missing.focus()
    missing.press("Enter")
    preview = page.get_by_role("status", name="Transient Missing preview")
    expect(preview).to_contain_text("Known eligible native editions: 3")
    expect(preview).to_contain_text("Ownership review: 2")
    expect(preview).to_contain_text("ownership: unavailable")
    expect(preview).to_contain_text("version: unknown")
    expect(preview).not_to_contain_text("%")
    expect(page.get_by_label("Hide wantlisted")).to_be_visible()
    page.get_by_label("Hide wantlisted").check()
    expect(preview).to_contain_text("Unfiltered artist/label scope")
    assert "synthetic-owner-window" not in page.url
    assert "synthetic-owner-window" not in page.evaluate("() => JSON.stringify({history: history.state, storage: {...localStorage}})")


def _preview_body(state: str) -> dict:
    """Synthetic evidence only; the live producer never claims a complete universe."""
    complete = state == "complete"
    return {
        "preview": {
            "denominator_evidence": {
                "denominator": 0 if state == "empty" else 4,
                "owned": 0 if state == "empty" else 1,
                "missing": 0 if state == "empty" else 3,
                "ownership_review": 0,
                "needs_review": 0,
                "unknown_excluded": 0,
                "excluded": 0,
                "denominator_complete": complete,
                "ownership_complete": complete,
                "completion_fraction": 0.25 if complete else None,
            }
        },
        "sources": {
            name: {"status": "observed", "truncated": False, "version": "synthetic-test-v1" if complete else None}
            for name in ["catalog", "aliases", "ownership"]
        },
    }


@pytest.mark.e2e
@pytest.mark.parametrize(
    "state,text",
    [
        ("complete", "Completion: 25%"),
        ("unknown", "Whole-catalog completion is unknown"),
        ("empty", "No eligible editions observed"),
        ("error", "could not be loaded"),
    ],
)
def test_missing_preview_states(page: Page, explore_url: str, state: str, text: str) -> None:
    """The actual app renders complete synthetic, unknown, empty and error responses."""
    page.route(
        "**/api/user/missing/preview",
        lambda route: route.fulfill(status=500 if state == "error" else 200, json={} if state == "error" else _preview_body(state)),
    )
    _open_artist(page, explore_url, ARTIST)
    # Exercise the existing target-scoped pane action on the initialized app.
    page.evaluate("() => window.userPanes.loadGapAnalysis('artist', '9001', true)")
    preview = page.get_by_role("status", name="Transient Missing preview")
    expect(preview).to_contain_text(text)
    if state != "complete":
        expect(preview).not_to_contain_text("%")


@pytest.mark.e2e
@pytest.mark.parametrize("late_error", [False, True])
def test_missing_scope_and_account_switch(page: Page, explore_url: str, late_error: bool) -> None:
    """A late A scope success/error cannot repaint B; B can make a new preview request."""
    delayed = []

    def respond(route):
        if route.request.post_data_json["target_id"] == "old-private":
            delayed.append(route)
        else:
            route.fulfill(json=_preview_body("unknown"))

    page.route("**/api/user/missing/preview", respond)
    _open_artist(page, explore_url, ARTIST)
    page.evaluate("() => { void window.userPanes.loadGapAnalysis('artist', 'old-private', true); }")
    expect(page.get_by_role("status", name="Transient Missing preview")).to_contain_text("Loading")
    page.wait_for_function("() => window.userPanes._gapEntityId === 'old-private'")
    page.evaluate("() => window.userPanes.loadGapAnalysis('label', 'next-scope', true)")
    expect(page.get_by_role("status", name="Transient Missing preview")).to_contain_text("Discogs label next-scope")
    page.evaluate("() => window.authManager.setToken('synthetic-owner-B')")
    expect(page.locator("#missingPreview")).to_be_empty()
    page.evaluate("() => window.userPanes.loadGapAnalysis('artist', 'B-scope', true)")
    expect(page.locator("#missingPreview")).to_contain_text("Discogs artist B-scope")
    assert delayed
    for route in delayed:
        route.fulfill(status=500 if late_error else 200, json={} if late_error else _preview_body("complete"))
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    expect(page.locator("#missingPreview")).to_contain_text("B-scope")
    expect(page.locator("#missingPreview")).not_to_contain_text("25%")

