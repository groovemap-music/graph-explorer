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


@pytest.mark.e2e
def test_copy_evidence_in_collection_and_strata(page: Page, explore_url: str) -> None:
    """Both existing homes choose copy B; appends remain separate from copy A's history."""
    from tests.e2e.test_discography_strata import _show

    copies = ["copy-300141-a", "copy-300141-b"]
    histories = {
        copy: [
            {
                "kind": "note",
                "value": f"{copy} original",
                "source": "user",
                "confidence": 0.8,
                "observed_at": "2020-01-01",
                "created_at": "2021-01-01",
            }
        ]
        for copy in copies
    }
    posted = []
    page.route(
        "**/api/user/collection?*",
        lambda route: route.fulfill(
            json={
                "releases": [
                    {"title": "Private edition", "artist": ARTIST, "gm_item_id": "11111111-1111-4111-8111-111111111111", "owned_copy_id": copies[0]}
                ],
                "total": 1,
                "has_more": False,
            }
        ),
    )
    page.route(
        "**/api/user/items/*/copies?*",
        lambda route: route.fulfill(json={"copies": [{"id": copy, "acquired_at": "2017-01-01"} for copy in copies], "truncated": False}),
    )

    def timeline(route):
        copy = route.request.url.split("/copies/")[1].split("/")[0]
        if route.request.method == "POST":
            posted.append(copy)
            histories[copy].append({**route.request.post_data_json, "observed_at": None, "created_at": "2026-11-08"})
            route.fulfill(status=201, json={"id": "synthetic-observation"})
        else:
            route.fulfill(json={"copy_id": copy, "observations": histories[copy]})

    page.route("**/api/user/copies/*/observations", timeline)
    _open_artist(page, explore_url, ARTIST)
    page.locator('[data-pane="collection"]').click()
    page.get_by_role("button", name="Physical copies of Private edition").click()
    detail = page.get_by_role("region", name="Physical copy evidence")
    selector = detail.get_by_label("Physical copy", exact=True)
    expect(selector).to_have_value("")
    selector.focus()
    selector.select_option(copies[1])
    expect(detail).to_contain_text(f"{copies[1]} original")
    expect(detail).not_to_contain_text(f"{copies[0]} original")
    detail.get_by_role("button", name="Record an observation").click()
    detail.get_by_label("Observed", exact=True).fill("Collection second-copy evidence")
    detail.get_by_role("button", name="Save observation").click()
    expect(detail.locator(".copy-timeline")).to_contain_text("Collection second-copy evidence")
    selector.select_option(copies[0])
    expect(detail.locator(".copy-timeline")).not_to_contain_text("Collection second-copy evidence")
    page.locator('[data-pane="explore"]').click()
    _show(page, "table")
    # Open the recorded no-master page, then select its duplicate-owned pressing through the table.
    page.evaluate("() => window.exploreApp.strata.load({focus:'r:300141'})")
    page.locator('#strataTable tr[data-id="r:300141"]').click()
    detail = page.locator("#strataSelection").get_by_role("region", name="Physical copy evidence")
    expect(detail).to_contain_text("completeness is unknown")
    selector = detail.get_by_label("Physical copy", exact=True)
    expect(selector).to_have_value("")
    selector.select_option(copies[1])
    expect(detail.locator(".copy-timeline")).to_contain_text("Collection second-copy evidence")
    page.locator('#strataSelection [data-action="record-observation"]').click()
    detail.get_by_label("Observed", exact=True).fill("Strata second-copy evidence")
    detail.get_by_role("button", name="Save observation").click()
    expect(detail.locator(".copy-timeline")).to_contain_text("Strata second-copy evidence")
    selector.select_option(copies[0])
    expect(detail.locator(".copy-timeline")).not_to_contain_text("Strata second-copy evidence")
    expect(detail).to_contain_text("Observed at:")
    expect(detail).to_contain_text("Recorded at:")
    assert posted == [copies[1], copies[1]]
    private_state = page.evaluate("() => JSON.stringify({url:location.href, history:history.state, storage:{...localStorage}})")
    assert not any(copy in private_state for copy in copies)
    page.evaluate("() => window.authManager.setToken('synthetic-other-owner')")
    expect(page.locator("#strataSelection")).not_to_contain_text("second-copy evidence")
    expect(page.locator("#collectionBody")).to_be_empty()


@pytest.mark.e2e
@pytest.mark.parametrize("late_error", [False, True])
def test_copy_account_reset_ignores_late_read_and_write(page: Page, explore_url: str, late_error: bool) -> None:
    """App account callbacks invalidate pending A GET and POST while B still reads its copy."""
    pending = []
    page.route(
        "**/api/user/collection?*",
        lambda route: route.fulfill(
            json={"releases": [{"title": "Private edition", "gm_item_id": "11111111-1111-4111-8111-111111111111"}], "total": 1, "has_more": False}
        ),
    )

    def list_copies(route):
        owner = "B" if "synthetic-owner-B" in route.request.headers.get("authorization", "") else "A"
        route.fulfill(json={"copies": [{"id": f"{owner}-copy-1"}, {"id": f"{owner}-copy-2"}], "truncated": False})

    def observations(route):
        if "/A-copy-2/" in route.request.url:
            pending.append(route)
        else:
            route.fulfill(json={"observations": [{"kind": "note", "value": "B private evidence", "source": "user"}]})

    page.route("**/api/user/items/*/copies?*", list_copies)
    page.route("**/api/user/copies/*/observations", observations)
    _open_artist(page, explore_url, ARTIST)
    page.locator('[data-pane="collection"]').click()
    page.get_by_role("button", name="Physical copies of Private edition").click()
    detail = page.get_by_role("region", name="Physical copy evidence")
    detail.get_by_label("Physical copy", exact=True).select_option("A-copy-2")
    expect(detail.locator(".copy-timeline")).to_have_text("Loading observations…")
    detail.get_by_role("button", name="Record an observation").click()
    detail.get_by_label("Observed", exact=True).fill("old private write")
    detail.get_by_role("button", name="Save observation").click()
    # Reading the pending request events gives the browser time to send the POST before reset.
    page.wait_for_function("() => document.querySelector('.strata-observation button').disabled")
    page.evaluate("() => window.authManager.setToken('synthetic-owner-B')")
    expect(page.locator("#collectionBody")).to_be_empty()
    page.evaluate("() => window.userPanes.loadCollection(true)")
    page.get_by_role("button", name="Physical copies of Private edition").click()
    detail = page.get_by_role("region", name="Physical copy evidence")
    detail.get_by_label("Physical copy", exact=True).select_option("B-copy-2")
    expect(detail.locator(".copy-timeline")).to_contain_text("B private evidence")
    assert {route.request.method for route in pending} == {"GET", "POST"}
    for route in pending:
        route.fulfill(status=500 if late_error else 200, json={"observations": [{"kind": "note", "value": "old A private evidence"}]})
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    expect(detail.locator(".copy-timeline")).to_contain_text("B private evidence")
    expect(detail).not_to_contain_text("old A private evidence")
    expect(detail).not_to_contain_text("Observation recorded")
