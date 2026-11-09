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
    _open_artist(page, explore_url, ARTIST)
    missing = page.get_by_role("button", name="What am I missing?")
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
    expect(page).not_to_have_url("synthetic-owner-window")
