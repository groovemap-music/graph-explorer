"""E2E: a scanned barcode resolves to a release and that release is scored.

This is the gesture ADR 0011 exists for, walked end to end in a real browser: a
collector standing in a shop types the barcode off the sleeve, the explorer
resolves it to the pressing, and the fit pane scores that pressing against their
own shelves. The barcode is typed with its grouping spaces on purpose — the
producer normalizes the value, and the point of the walk is that the person
holding the record does not have to know that.
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

from tests.explore_test_app import MOCK_BARCODE, MOCK_TOKEN


def _signed_in(page: Page, explore_url: str) -> None:
    """Open the explorer with a session, the way a returning visitor does.

    The token is seeded rather than typed through the login dialog because the
    subject of this test is the lookup, and the dialog is covered where it is the
    subject. The stub API accepts any bearer token, exactly as the real service
    accepts a valid one.
    """
    page.add_init_script(f"localStorage.setItem('auth_token', {MOCK_TOKEN!r});")
    page.goto(explore_url)


@pytest.mark.e2e
def test_barcode_lookup_resolves_to_a_release_in_search(page: Page, explore_url: str) -> None:
    """The search pane resolves a typed barcode and says what resolved it."""
    page.goto(explore_url)
    page.locator('.nav-link[data-pane="search"]').click()

    page.locator('[data-search-mode="barcode"]').click()
    expect(page.locator("#searchPaneFilters")).to_be_hidden()

    page.locator("#searchPaneInput").fill(MOCK_BARCODE)
    page.locator("#searchPaneInput").press("Enter")

    cards = page.locator(".search-result-card")
    expect(cards.first).to_be_visible(timeout=10_000)
    expect(cards.first.locator(".search-result-name")).to_have_text("Never Gonna Give You Up")
    expect(cards.first.locator(".search-resolved-by")).to_have_text("resolved by barcode")
    # One barcode, two catalogs: both rows are shown and each names its own.
    expect(cards).to_have_count(2)


@pytest.mark.e2e
def test_barcode_lookup_to_fit_profile(page: Page, explore_url: str) -> None:
    """A barcode typed into the fit picker scores the release it resolves to."""
    _signed_in(page, explore_url)
    page.locator('.nav-link[data-pane="fit"]').click()

    picker = page.locator("#fitPicker")
    expect(picker).to_be_visible(timeout=10_000)

    page.locator('[data-fit-mode="barcode"]').click()
    page.locator("#fitSearchInput").fill(MOCK_BARCODE)
    page.locator("#fitSearchInput").press("Enter")

    candidates = page.locator(".fit-candidate")
    expect(candidates.first).to_be_visible(timeout=10_000)
    expect(candidates).to_have_count(2)
    # The MusicBrainz row is resolved and shown, and cannot be scored: the fit
    # route reads Discogs release ids, and offering it would promise an answer
    # the service cannot give.
    expect(candidates.nth(1)).to_be_disabled()

    candidates.first.click()
    run = page.locator("#fitRunBtn")
    expect(run).to_be_enabled()
    run.click()

    card = page.locator(".fit-card")
    expect(card).to_be_visible(timeout=15_000)
    expect(card.locator(".fit-card-title")).to_have_text("Never Gonna Give You Up")
    expect(card.locator(".fit-overall-value")).to_be_visible()


@pytest.mark.e2e
def test_release_detail_shows_markings_credits_and_country(page: Page, explore_url: str) -> None:
    """The release view renders the markings, the credits, and the country."""
    page.goto(explore_url)
    page.evaluate("window.exploreApp._onNodeClick('249504', 'release')")

    panel = page.locator("#infoPanelBody")
    expect(panel.locator('[data-detail-section="identifiers"]')).to_be_visible(timeout=10_000)

    identifiers = panel.locator('[data-detail-section="identifiers"] .detail-row')
    expect(identifiers.first.locator(".term")).to_have_text("Barcode")
    expect(identifiers.first.locator(".value")).to_have_text(MOCK_BARCODE)

    credits = panel.locator('[data-detail-section="credits"] .detail-row')
    expect(credits.first.locator(".term")).to_have_text("Pressed By")
    expect(credits.first.locator(".value")).to_have_text("Damont")

    expect(panel.locator(".detail-stat", has_text="Country").locator(".value")).to_have_text("UK")
