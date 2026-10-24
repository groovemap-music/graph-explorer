"""E2E: Discography Strata, walked the way a collector walks it.

Strata draws one artist's credits, masters, and pressings on three planes, with the table as the
same entries in rows (ADR 0016). The journey here is the one the feature exists for: search for an
artist, open the strata, drill into a group of masters and page through it, find a pressing that
exists only in MusicBrainz and read why nothing can be done to it, move both clocks, and then do the
same reading in the table. The mock app serves bodies recorded from catalog-api's fold over an
invented catalog (tests/fixtures/strata-route.json), so no assertion here depends on a live
database. Two artists in the mock make the route fail the way it does at scale: a catalog above the
release ceiling answers 422 and a slow read answers 504.

The 3D view is driven from the keyboard, which is how it is documented to be used without a
pointer: a canvas click would only prove where the camera happened to be. Nothing here reads the
GPU, so the journey holds on every project in the matrix.

Not covered, on purpose: searching for a pressing that the current page does not draw. The route
has no cursor for one pressing, so that search reaches it only through its master. That is a known
follow-up (gm-graph-explorer-sqjq), and the docs say so.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import Page, expect

from tests.explore_test_app import MOCK_TOKEN


ARTIST = "The Placeholder Band"
EN_DASH = "\u2013"
MB_ONLY_PRESSING = "Lantern Static (MusicBrainz)"
# What "Only what I collect" leaves on a pressing's row: wanted, owned, or both.
COLLECTED_STATE = re.compile(r"owned|wanted")


def _open_artist(page: Page, explore_url: str, name: str, *, signed_in: bool = True) -> None:
    """Search for an artist from the Explore box, the way a visitor reaches the strata."""
    if signed_in:
        # The token is seeded rather than typed through the login dialog, which has its own tests.
        # The mock API accepts any bearer token, as the real one accepts a valid one.
        page.add_init_script(f"localStorage.setItem('auth_token', {MOCK_TOKEN!r});")
    page.goto(explore_url)
    search = page.locator("#searchInput")
    search.fill(name)
    search.press("Enter")
    # The view toggle stays disabled until the search has centered an artist.
    expect(page.locator('[data-explore-view="strata"]')).to_be_enabled(timeout=15_000)


def _show(page: Page, view: str) -> None:
    page.locator(f'[data-explore-view="{view}"]').click()
    expect(page.locator(f'[data-explore-view="{view}"]')).to_have_attribute("aria-pressed", "true")


def _record_strata_requests(page: Page) -> list[tuple[str | None, int]]:
    """Every `focus`/`page` pair the view asks the strata route for, in order."""
    asked: list[tuple[str | None, int]] = []

    def note(request) -> None:
        url = urlparse(request.url)
        if url.path != "/api/explore/strata":
            return
        query = parse_qs(url.query)
        asked.append(((query.get("focus") or [None])[0], int((query.get("page") or ["0"])[0])))

    page.on("request", note)
    return asked


def _step_to(page: Page, key: str, title: str, *, limit: int = 40, state: str | None = None) -> None:
    """Press `key` on the stage until the panel describes the node titled `title`."""
    heading = page.locator(".strata-selection-title")
    for _ in range(limit):
        page.keyboard.press(key)
        if heading.count() and heading.inner_text() == title and (state is None or page.locator(".strata-state").first.inner_text() == state):
            return
    pytest.fail(f"{key!r} never reached {title!r}{f' in state {state!r}' if state else ''} in {limit} presses")


def _table_row(page: Page, name: str, kind: str | None = None):
    """The table row whose name cell is exactly `name`, of one kind (`master`, `pressing`) when given."""
    return page.locator(f"#strataTable tbody tr.strata-row--{kind}" if kind else "#strataTable tbody tr").filter(
        has=page.locator("th.strata-cell-name", has_text=re.compile(f"^{re.escape(name)}$"))
    )


@pytest.mark.e2e
def test_strata_journey_from_search_to_a_pressing_nothing_can_change(page: Page, explore_url: str) -> None:
    """Open an artist's strata, drill and page a group, and read a MusicBrainz-only pressing."""
    asked = _record_strata_requests(page)
    _open_artist(page, explore_url, ARTIST)

    # The view is the artist the search centered, and it asked for the overview, not a cursor.
    _show(page, "strata")
    expect(page.locator("#strataSummary .strata-summary-title")).to_have_text(ARTIST, timeout=15_000)
    expect(page.locator("#strataSummary")).to_contain_text("6 credits · 40 masters · 169 releases")
    expect(page.locator("#strataSummary")).to_contain_text("13 MusicBrainz-only")
    expect(page.locator("#strataStage canvas")).to_have_count(1)
    expect(page.locator("#strataTrail")).to_be_hidden()
    assert asked == [(None, 0)]

    # Drill an aggregate: solo the master plane, step to the 1990s group, and open it.
    page.locator("#strataStage").focus()
    page.keyboard.press("2")
    _step_to(page, "]", f"8 masters, 1993{EN_DASH}2015")
    expect(page.locator(".strata-selection-plane")).to_have_text(f"Master group · 1993{EN_DASH}2015")
    page.keyboard.press("Enter")
    trail = page.locator("#strataTrail")
    expect(trail).to_contain_text("masters from the 1990s: page 1 of 2 (9 in all)")

    # Page it. The server pages, so each turn is a request for the next page of the same cursor.
    trail.get_by_role("button", name="Next page").click()
    expect(trail).to_contain_text("page 2 of 2")
    trail.get_by_role("button", name="Previous page").click()
    expect(trail).to_contain_text("page 1 of 2")
    focus = "ma:c:9001:1990s"
    assert asked[1:] == [(focus, 0), (focus, 1), (focus, 0)]

    # Back to the overview, then into one master's pressings.
    trail.get_by_role("button", name="Back").click()
    expect(trail).to_be_hidden()
    page.locator("#strataStage").focus()
    page.keyboard.press("Escape")
    _step_to(page, "]", "Lantern Static")
    page.keyboard.press("Enter")
    expect(trail).to_contain_text("pressings of Lantern Static: page 1 of 2")

    # A pressing that exists only in MusicBrainz says why nothing can be done to it, and offers
    # no action at all: no Discogs page, no sync, no observation.
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    page.keyboard.press("3")
    _step_to(page, "]", MB_ONLY_PRESSING)
    selection = page.locator("#strataSelection")
    expect(selection.locator(".strata-blocked")).to_contain_text("MusicBrainz-only pressing")
    expect(selection.locator(".strata-blocked")).to_contain_text("no wantlist or collection edge can carry a change to it")
    expect(selection.locator(".strata-actions > *")).to_have_count(0)
    expect(selection.locator(".strata-state")).to_have_count(0)

    # An owned Discogs pressing of the same master is the contrast. It can be synced, and as an
    # owned copy it can have an observation recorded about it. Neither writes a wantlist or a
    # collection: Sync now asks Discogs, and the state changes only when Discogs reports it.
    _step_to(page, "]", "Lantern Static", state="owned")
    actions = selection.locator(".strata-actions")
    expect(actions.get_by_role("button")).to_have_text(["Sync now", "Record an observation"])
    expect(actions.get_by_role("link", name="Open on Discogs")).to_have_attribute("href", re.compile(r"^https://www\.discogs\.com/release/\d+$"))
    actions.get_by_role("button", name="Sync now").click()
    expect(page.locator("#strataActionStatus")).to_contain_text("Sync started. States change only when Discogs reports them", timeout=10_000)
    actions.get_by_role("button", name="Record an observation").click()
    expect(selection.get_by_role("form", name="Record an observation about your copy")).to_be_visible()


@pytest.mark.e2e
def test_strata_both_clocks_move_what_the_view_shows(page: Page, explore_url: str) -> None:
    """Valid time hides what was not out yet; "Recorded as of" replays what the collector held."""
    _open_artist(page, explore_url, ARTIST)
    _show(page, "table")
    summary = page.locator("#strataSummary")
    expect(summary).to_contain_text("6 credits · 40 masters · 169 releases", timeout=15_000)
    tide = _table_row(page, "Tide Amber EP")
    expect(tide.locator(".strata-cell-state")).to_have_text("wanted + owned")
    expect(page.locator("#strataRecordedAsOfLabel")).to_have_text("now")
    rows_now = page.locator("#strataTable tbody tr").count()

    # Transaction time: Discogs recorded this pressing as wanted on 2011-11-10 and as owned on
    # 2017-05-09, so on 2012-01-01 the collector only wanted it.
    recorded = page.locator("#strataRecordedAsOf")
    expect(recorded).to_be_enabled()
    recorded.fill(str(1_325_376_000_000))  # 2012-01-01T00:00:00Z
    expect(page.locator("#strataRecordedAsOfLabel")).to_have_text("2012-01-01")
    expect(tide.locator(".strata-cell-state")).to_have_text("wanted")
    expect(summary).to_contain_text("States as recorded on 2012-01-01.")
    # Recording the past moves no node: the same entries are listed.
    assert page.locator("#strataTable tbody tr").count() == rows_now
    recorded.fill(recorded.get_attribute("max") or "")
    expect(page.locator("#strataRecordedAsOfLabel")).to_have_text("now")
    expect(tide.locator(".strata-cell-state")).to_have_text("wanted + owned")

    # Valid time is the year scrubber the Explore pane already has. Tide Amber EP came out in 2013.
    page.locator("#strataValidTimeBtn").click()
    expect(page.locator("#timelineScrubber")).to_be_visible()
    page.locator("#timelineSlider").fill("1995")
    expect(page.locator("#strataValidTimeLabel")).to_have_text("to 1995")
    expect(summary).to_contain_text("Releases up to 1995.")
    expect(tide).to_have_count(0)
    assert page.locator("#strataTable tbody tr").count() < rows_now

    # Moving the clock back to "all" brings it back.
    page.locator("#timelineResetBtn").click()
    expect(page.locator("#strataValidTimeLabel")).to_have_text("All")
    expect(tide).to_have_count(1)
    assert page.locator("#strataTable tbody tr").count() == rows_now


@pytest.mark.e2e
def test_strata_table_is_a_view_of_its_own(page: Page, explore_url: str) -> None:
    """The table needs no WebGL, filters to what cannot change state, and is driven by keyboard."""
    _open_artist(page, explore_url, ARTIST)
    _show(page, "table")
    table = page.locator("#strataTable")
    rows = table.locator("tbody tr")
    expect(rows.first).to_be_visible(timeout=15_000)
    expect(page.locator("#strataTableWrap")).to_be_visible()
    expect(page.locator("#strataStage")).to_be_hidden()
    # Opening the table builds no renderer: there is no canvas to lose where WebGL is missing.
    expect(page.locator("#strataStage canvas")).to_have_count(0)
    all_rows = rows.count()

    # "Only what cannot change state" lists the rows that say why. Every one has a reason.
    blocked_only = page.locator("#strataTableBlockedOnly")
    blocked_only.check()
    expect(page.locator("#strataTableStatus")).to_contain_text("that cannot change state")
    shown = rows.count()
    assert 0 < shown < all_rows
    for cell in table.locator("tbody .strata-cell-blocked").all():
        expect(cell).not_to_be_empty()
    blocked_only.uncheck()
    expect(rows).to_have_count(all_rows)

    # Sorting is a button on the header, with the state in aria-sort.
    year = table.locator('th[data-column="year"]')
    year.get_by_role("button").click()
    expect(year).to_have_attribute("aria-sort", "ascending")
    expect(page.locator("#strataTableStatus")).to_contain_text("sorted by year, ascending")
    year.get_by_role("button").click()
    year.get_by_role("button").click()
    expect(year).to_have_attribute("aria-sort", "none")

    # Keyboard: one row is the tab stop, and the keys move through the outline.
    first = rows.first
    first_name = first.locator("th.strata-cell-name").inner_text()
    first.focus()
    page.keyboard.press("ArrowDown")
    expect(rows.nth(1)).to_be_focused()
    page.keyboard.press("End")
    expect(rows.last).to_be_focused()
    page.keyboard.press("Home")
    expect(first).to_be_focused()
    page.keyboard.press("PageDown")
    child = page.locator("#strataTable tbody tr:focus")
    expect(child.locator(".strata-cell-path")).to_have_text(first_name)
    page.keyboard.press("PageUp")
    expect(first).to_be_focused()
    page.keyboard.press("Space")
    expect(first).to_have_attribute("aria-current", "true")
    expect(page.locator(".strata-selection-title")).to_have_text(first_name)
    page.keyboard.press("Escape")
    expect(first).not_to_have_attribute("aria-current", "true")

    # Enter on a master opens its pressings, as it does in 3D, and the MusicBrainz-only one that
    # is on that page is a row of its own with its reason and no state.
    _table_row(page, "Lantern Static", "master").focus()
    page.keyboard.press("Enter")
    expect(page.locator("#strataTrail")).to_contain_text("pressings of Lantern Static: page 1 of 2")
    mb_only = _table_row(page, MB_ONLY_PRESSING)
    expect(mb_only).to_have_count(1)
    expect(mb_only.locator(".strata-cell-state")).to_have_text("no state")
    expect(mb_only.locator(".strata-cell-blocked")).to_contain_text("MusicBrainz-only pressing")
    mb_only.click()
    expect(page.locator("#strataSelection .strata-blocked")).to_contain_text("MusicBrainz-only pressing")
    expect(page.locator("#strataSelection .strata-actions > *")).to_have_count(0)

    # "Only what I collect" keeps what the collector wants or owns, with what holds it.
    # The first button of the trail goes back; it reads "Overview" until a second page is turned.
    page.locator("#strataTrail .strata-trail-btn").first.click()
    expect(page.locator("#strataTrail")).to_be_hidden()
    expect(rows).to_have_count(all_rows)
    collect = page.locator("#strataOnlyCollected")
    expect(collect).to_be_enabled()
    collect.check()
    kept = rows.count()
    assert 0 < kept < all_rows
    expect(page.locator("#strataSummary")).to_contain_text("hidden by the filters")
    for state in table.locator("tbody tr.strata-row--pressing .strata-cell-state").all_inner_texts():
        assert COLLECTED_STATE.search(state), state
    collect.uncheck()
    expect(rows).to_have_count(all_rows)

    # The evidence for the docs: the table, as a collector reads it.
    page.locator("#strataTableBlockedOnly").check()
    project = os.environ.get("GROOVEMAP_E2E_PROJECT", "chromium")
    shot = Path("test-results") / project / "strata-table.png"
    shot.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(shot))


@pytest.mark.e2e
def test_strata_signed_out_shows_the_discography_without_collector_state(page: Page, explore_url: str) -> None:
    """A visitor who has not signed in sees the discography and is told what signing in adds."""
    _open_artist(page, explore_url, ARTIST, signed_in=False)
    _show(page, "table")
    expect(page.locator("#strataSummary")).to_contain_text("Sign in to see what you want and own.", timeout=15_000)
    collect = page.locator("#strataOnlyCollected")
    expect(collect).to_be_disabled()
    expect(collect).to_have_attribute("title", "Sign in to see what you collect")
    expect(page.locator("#strataRecordedAsOf")).to_be_disabled()
    pressings = page.locator("#strataTable tbody tr.strata-row--pressing .strata-cell-state")
    expect(pressings.first).to_have_text(re.compile("not signed in|no state"))
    for state in pressings.all_inner_texts():
        assert state in {"not signed in", "no state"}, state


@pytest.mark.e2e
def test_strata_large_artist_is_refused_with_its_own_words(page: Page, explore_url: str) -> None:
    """An artist above the ceiling gets the number, the ceiling, and a way on, not a failure."""
    _open_artist(page, explore_url, "Overlong Catalog")
    _show(page, "strata")
    message = page.locator("#strataMessage")
    expect(message).to_be_visible(timeout=15_000)
    expect(message).to_have_text(
        "Overlong Catalog has 1,356,055 releases. Discography Strata draws artists with up to 134,051, "
        "so it cannot open this one. The graph view still can."
    )
    # The table is the same data and says the same thing.
    _show(page, "table")
    expect(message).to_contain_text("1,356,055 releases")
    # And the graph view does still work.
    _show(page, "graph")
    expect(page.locator("#graphContainer")).to_be_visible()


@pytest.mark.e2e
def test_strata_slow_read_is_stopped_with_its_own_words(page: Page, explore_url: str) -> None:
    """A read past the server's bound says it was stopped, not that the strata are broken."""
    _open_artist(page, explore_url, "Slow Reader")
    _show(page, "strata")
    message = page.locator("#strataMessage")
    expect(message).to_have_text("The strata read took too long and was stopped. Try again in a moment.", timeout=15_000)
