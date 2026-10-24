"""E2E: Taste Strata and the Fit landing point on the Genre Atlas, walked as a seeded collector.

Concept C' of ADR 0016 lays a signed-in collector's own items over the Genre Atlas (Taste Strata) and
draws a "Will it fit?" candidate on it (the Fit landing point). The journeys here are the ones the
feature exists for:

- a collector opens the atlas and sees what they hold marked on its genres and styles, their masters
  in collector slots on the master plane, what is only counted, and the "recorded as of" control
  that follows when Discogs first recorded each item;
- the same facts are in the atlas table, in its "Yours" column, which sorts and is described to a
  screen reader;
- an anonymous visitor gets the atlas without any of it, and the personal projection is never even
  requested;
- the collector scores a release in the Fit pane and the candidate lands on the atlas: the
  components with a place are drawn and marked, Depth and the artists and labels are listed beside
  it, and the outcome they report is still recorded.

The mock app serves `GET /api/user/taste-projection` from tests/fixtures/taste-projection.json and
the fit route's uncapped `evidence_entries` from tests/fixtures/fit-profile.json, both over the
invented style names of the recorded atlas (tests/fixtures/style-atlas.json), so no assertion
depends on a live database or a real collection. A frame is read only once the stage says
`data-strata-frame="settled"`, and what it drew is read from the stage's own counts
(`data-atlas-held-marks`, `data-atlas-landing-marks`). Nothing waits on a timer or reads the GPU.
"""

from __future__ import annotations

import re

import pytest
from playwright.sync_api import Page, expect

from tests.e2e.test_genre_atlas import _open_atlas, _table_row
from tests.explore_test_app import MOCK_TOKEN


# The synthetic collector (tests/fixtures/taste-projection.json): seven items, five owned, three
# wanted, one both, two without a master and one with a genre and no style.
ITEMS = "7 items: 5 owned, 3 wanted, 1 in both."
# What the atlas marks of it: five genres, four of its five styles (Phantom Fizz is not drawn), and
# five masters, two of them landmarks the collector holds.
MARKED = "Marked: 5 genres, 4 styles, and 5 masters (2 of them landmarks)."
# The collector's three own masters, each in its dominant style's cell on the master plane.
COLLECTOR_MASTERS = ["m:7100001@Copper Drift", "m:7100002@Amber Bop", "m:7100003@Dusty Drift"]
# By the end of 2016 Discogs had recorded only some of the items.
RECORDED_AS_OF = 2016
MARKED_AS_OF = "Recorded by the end of 2016: 2 genres, 1 style, and 1 master (0 of them landmarks)."
# A style the collector holds three items on, and one they do not hold.
HELD_STYLE = "Amber Bop"
HELD_STYLE_ROW = "wanted + owned 3 items (2 owned, 1 wanted)"
UNHELD_STYLE = "Rust Stomp"

# The fit mock (tests/fixtures/fit-profile.json) for release 249504.
FIT_IMPRESSION = "33333333-3333-3333-3333-333333333333"
FIT_TITLE = "Never Gonna Give You Up"
# Five drawn: the shared genre and style (Affinity), the unheld style the atlas has (Novelty), the
# bridge between two genres, and the held copy under its master (Redundancy). Hi NRG is drawable but
# not on the atlas, so it is listed with the artists, labels, and Depth.
FIT_DRAWN = ["affinity", "novelty", "bridge", "redundancy"]
FIT_DRAWN_ITEMS = 5
FIT_LISTED = {"affinity": 2, "novelty": 4, "bridge": 1, "depth": 2}


def _sign_in(page: Page) -> None:
    """Seed the session before the page loads, the way a returning collector arrives.

    The stub API accepts any bearer token, as the real service accepts a valid one, and the login
    dialog is covered where it is the subject.
    """
    page.add_init_script(f"localStorage.setItem('auth_token', {MOCK_TOKEN!r});")


def _stage(page: Page, mount: str = "genreAtlasMount"):
    return page.locator(f"#{mount} .atlas-stage")


def _settled(page: Page, mount: str = "genreAtlasMount", **counts: str):
    """Wait for a frame that has drawn the current state, then for the counts it reports."""
    stage = _stage(page, mount)
    expect(stage).to_have_attribute("data-strata-frame", "settled", timeout=15_000)
    for name, value in counts.items():
        expect(stage).to_have_attribute(f"data-atlas-{name.replace('_', '-')}", value)
    return stage


def _held_marks(page: Page) -> int:
    """How many held rings the settled frame drew."""
    return int(_stage(page).get_attribute("data-atlas-held-marks") or "0")


def _layout_nodes(page: Page, predicate: str) -> list[str]:
    """The ids of the layout's nodes that satisfy `predicate`, in the atlas view's own layout."""
    return page.evaluate(f"() => window.genreAtlas.layout.nodes.filter((n) => {predicate}).map((n) => n.id)")


def _wait_for_taste(page: Page) -> None:
    expect(page.locator("#genreAtlasMount .atlas-taste")).to_have_attribute("data-taste-status", "ready", timeout=15_000)
    _settled(page)


@pytest.mark.e2e
def test_taste_strata_for_a_signed_in_collector(page: Page, explore_url: str) -> None:
    """The atlas marks what the collector holds, places their masters, and follows the recorded time."""
    _sign_in(page)
    _open_atlas(page, explore_url)
    _wait_for_taste(page)

    # What is held is marked and counted, and what cannot be drawn is counted and said so.
    taste = page.locator("#genreAtlasMount .atlas-taste")
    expect(taste.locator(".atlas-taste-title")).to_have_text("Your collection")
    expect(taste).to_contain_text(ITEMS)
    expect(taste).to_contain_text(MARKED)
    expect(taste).to_contain_text("2 items have no master, so they are counted here and not drawn.")
    expect(taste).to_contain_text("1 item carries a genre and no style, so it marks a genre only.")
    expect(taste).to_contain_text("1 of your styles is not drawn on this atlas.")
    expect(taste).to_contain_text("1 of your masters has no style drawn here, so it is not placed.")
    # The state is a word beside its color in the legend, so it never rests on color alone.
    expect(taste.locator(".atlas-taste-legend .strata-chip")).to_have_text(["wanted 1", "owned 1", "wanted + owned 2"])

    # Every held node that is not a collector master is ringed; the layout and the frame agree.
    ringed = _layout_nodes(page, "n.held && !(n.master && n.master.collector)")
    assert "s:Copper Drift" in ringed
    assert "h:Copper Drift@Blues" in ringed, "a ghost copy is the same style, so it is ringed too"
    assert "m:910001@Amber Bop" in ringed, "a landmark the collector holds is marked where it is"
    _settled(page, held_marks=str(len(ringed)))

    # The collector's own masters take collector slots on the master plane, beside the landmarks,
    # and the plane counts them separately.
    assert sorted(_layout_nodes(page, "n.master && n.master.collector")) == COLLECTOR_MASTERS
    expect(page.locator('#genreAtlasMount .strata-plane-label[data-level="2"]')).to_contain_text("+ 3 yours")

    # Selecting a held style says what is the collector's, and when Discogs first recorded it.
    page.evaluate("() => window.genreAtlas.renderer.select('s:Amber Bop')")
    selection = page.locator(".atlas-selection")
    expect(selection.locator(".strata-selection-title")).to_have_text(HELD_STYLE)
    expect(selection.locator(".atlas-held")).to_contain_text("Yours")
    expect(selection.locator(".atlas-held")).to_contain_text("3 items · 2 owned · 1 wanted")
    page.evaluate("() => window.genreAtlas.renderer.select('m:7100001@Copper Drift')")
    expect(selection).to_contain_text("Your master, in its dominant style Copper Drift")

    # The "recorded as of" control moves transaction time: the marks follow when each item was first
    # recorded, and nothing moves. The note says what it cannot do.
    recorded = page.locator("#atlasRecorded")
    expect(recorded).to_be_visible()
    expect(page.locator(".atlas-recorded-value")).to_have_text("now")
    expect(recorded).to_have_attribute("aria-valuetext", "now, everything you hold")
    expect(page.locator("#atlasRecordedNote")).to_contain_text("Items you have since removed are not replayed")
    before = page.evaluate("() => window.genreAtlas.layout.nodes.map((n) => [n.id, n.x, n.z])")
    now_marks = _held_marks(page)
    recorded.fill(str(RECORDED_AS_OF))
    expect(page.locator(".atlas-recorded-value")).to_have_text(str(RECORDED_AS_OF))
    expect(recorded).to_have_attribute("aria-valuetext", f"the end of {RECORDED_AS_OF}")
    expect(taste).to_contain_text(MARKED_AS_OF)
    earlier = _layout_nodes(page, "n.held && !(n.master && n.master.collector)")
    assert "s:Amber Bop" not in earlier
    assert "s:Copper Drift" in earlier
    _settled(page, held_marks=str(len(earlier)))
    assert len(earlier) < now_marks
    assert page.evaluate("() => window.genreAtlas.layout.nodes.map((n) => [n.id, n.x, n.z])") == before
    page.evaluate("() => window.genreAtlas.renderer.select('s:Amber Bop')")
    expect(selection.locator(".atlas-held")).to_have_text(f"Yours, but first recorded after {RECORDED_AS_OF}.")
    recorded.fill(recorded.get_attribute("max") or "")
    expect(page.locator(".atlas-recorded-value")).to_have_text("now")
    _settled(page, held_marks=str(now_marks))

    # Personal layers never enter a shared link or the browser's storage: the projection is held in
    # memory, and the address names nothing of the collection.
    assert page.url.rstrip("/") == explore_url.rstrip("/")
    storage = page.evaluate("() => JSON.stringify([window.localStorage, window.sessionStorage])")
    assert "Copper Drift" not in storage
    assert "7100001" not in storage


@pytest.mark.e2e
def test_the_atlas_table_has_a_yours_column_for_a_signed_in_collector(page: Page, explore_url: str) -> None:
    """The table is the 3D view's equal: the same held counts and states, sortable and described."""
    _sign_in(page)
    _open_atlas(page, explore_url)
    _wait_for_taste(page)
    page.locator('[data-atlas-view="table"]').click()
    table = page.locator(".atlas-table")
    expect(table).to_be_visible()
    expect(table.locator("tbody tr")).to_have_count(156)

    # Yours follows Name, and a screen reader hears what it counts after its label.
    heads = table.locator("thead th")
    expect(heads.nth(2)).to_have_attribute("data-column", "yours")
    yours = table.locator('th[data-column="yours"]')
    expect(yours.get_by_role("button")).to_contain_text("Yours")
    expect(yours.locator(".strata-sr-only")).to_have_text(" (the items you hold on this genre or style, and their collector state)")
    expect(yours).to_have_attribute("aria-sort", "none")

    # A held row is the state as a word beside its chip and the counts; the rest say they are not held.
    held = _table_row(page, HELD_STYLE).locator(".atlas-cell-yours")
    expect(held).to_have_text(HELD_STYLE_ROW)
    expect(held.locator(".strata-chip--wanted-owned")).to_have_text("wanted + owned")
    expect(_table_row(page, "Electronic").locator(".atlas-cell-yours")).to_have_text("wanted + owned 4 items (2 owned, 2 wanted)")
    expect(_table_row(page, UNHELD_STYLE).locator(".atlas-cell-yours")).to_have_text("not held")

    # Sort: fewest held first, most held first, and the outline order again. Rows that hold nothing
    # go last whichever way it sorts, and each change is announced.
    yours.get_by_role("button").click()
    expect(yours).to_have_attribute("aria-sort", "ascending")
    expect(page.locator("#genreAtlasMount [role=status]").first).to_contain_text("sorted by yours, ascending")
    expect(table.locator("tbody tr").first.locator(".atlas-cell-yours")).to_contain_text(" 1 item (")
    expect(table.locator("tbody tr").last.locator(".atlas-cell-yours")).to_have_text("not held")
    yours.get_by_role("button").click()
    expect(yours).to_have_attribute("aria-sort", "descending")
    expect(table.locator("tbody tr").first.locator(".atlas-cell-yours")).to_have_text("wanted + owned 4 items (2 owned, 2 wanted)")
    expect(table.locator("tbody tr").last.locator(".atlas-cell-yours")).to_have_text("not held")
    yours.get_by_role("button").click()
    expect(yours).to_have_attribute("aria-sort", "none")
    expect(table.locator("tbody tr").first.locator("th")).to_have_text("Blues")

    # The column follows the "recorded as of" control, as the marks do.
    page.locator("#atlasRecorded").fill(str(RECORDED_AS_OF))
    expect(held).to_have_text(f"first recorded after {RECORDED_AS_OF}")
    page.locator("#atlasRecorded").fill(page.locator("#atlasRecorded").get_attribute("max") or "")
    expect(held).to_have_text(HELD_STYLE_ROW)


@pytest.mark.e2e
def test_an_anonymous_visitor_sees_no_personal_layer(page: Page, explore_url: str) -> None:
    """Signed out, the atlas is the shared one: a hint to sign in, and nothing of anyone's collection."""
    requested: list[str] = []
    page.on("request", lambda request: requested.append(request.url) if "/api/user/" in request.url else None)
    _open_atlas(page, explore_url)
    _settled(page)

    taste = page.locator("#genreAtlasMount .atlas-taste")
    expect(taste).to_have_attribute("data-taste-status", "anonymous")
    expect(taste).to_have_text("Sign in to see your collection on the atlas: the genres and styles you hold, and your masters on the master plane.")
    expect(page.locator(".atlas-recorded")).to_be_hidden()
    assert _layout_nodes(page, "n.held || n.heldLater") == []
    assert _layout_nodes(page, "n.master && n.master.collector") == []
    assert _stage(page).get_attribute("data-atlas-held-marks") == "0"
    expect(page.locator('#genreAtlasMount .strata-plane-label[data-level="2"]')).not_to_contain_text("yours")

    page.locator('[data-atlas-view="table"]').click()
    expect(page.locator(".atlas-table tbody tr")).to_have_count(156)
    expect(page.locator('.atlas-table th[data-column="yours"]')).to_have_count(0)
    expect(page.locator(".atlas-cell-yours")).to_have_count(0)
    # The projection is not even asked for.
    assert requested == []


@pytest.mark.e2e
def test_a_fit_check_lands_on_the_atlas_over_the_collectors_layer(page: Page, explore_url: str) -> None:
    """Scoring a release draws its landing point, lists the rest, and the outcome is still recorded."""
    _sign_in(page)
    page.goto(explore_url, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("() => !!window.exploreApp", timeout=10_000)
    page.request.delete(f"{explore_url}/api/activity/events")
    page.locator('.nav-link[data-pane="fit"]').click()
    expect(page.locator("#fitPicker")).to_be_visible(timeout=10_000)
    page.locator("#fitSearchInput").fill("Never Gonna")
    page.locator("#fitSearchBtn").click()
    page.locator(".fit-candidate").first.click()
    run = page.locator("#fitRunBtn")
    expect(run).to_be_enabled()
    run.click()
    card = page.locator(".fit-card")
    expect(card).to_be_visible(timeout=15_000)
    expect(card).to_have_attribute("data-impression-id", FIT_IMPRESSION)

    # The atlas opens under the card with the candidate on it and the collector's layer beneath it.
    mount = page.locator("#fitAtlasMount")
    expect(mount).to_be_visible()
    expect(mount.locator(".atlas-taste")).to_have_attribute("data-taste-status", "ready", timeout=15_000)
    landing = mount.locator(".atlas-landing")
    expect(landing).to_contain_text(FIT_TITLE)
    drawn = landing.locator(".atlas-landing-list--drawn li")
    expect(drawn).to_have_count(FIT_DRAWN_ITEMS, timeout=15_000)
    marked = _layout_nodes(page, "n.landing")
    assert marked, "the landing point marks nodes of the layout"
    _settled(page, mount="fitAtlasMount", landing_marks=str(len(marked)))
    assert int(_stage(page, "fitAtlasMount").get_attribute("data-atlas-held-marks") or "0") > 0

    # Drawn: each component with a place on the atlas is marked on its nodes, in its own words.
    expect(drawn.locator(".atlas-chip")).to_have_text(["Affinity", "Affinity", "Novelty", "Bridge", "Redundancy"])
    for component in FIT_DRAWN:
        expect(landing.locator(f'.atlas-landing-list--drawn li[data-component="{component}"]').first).to_be_visible()
    assert {tuple(pair) for pair in page.evaluate("() => window.genreAtlas.layout.nodes.filter((n) => n.landing).map((n) => [n.id, n.landing])")} >= {
        ("g:Electronic", "affinity"),
        ("s:Amber Bop", "affinity"),
        ("s:Glass Drift", "novelty"),
        ("m:910001@Amber Bop", "redundancy"),
    }
    # Depth, the artists, and the labels have no place on the atlas, so they are listed beside it,
    # with whatever a component named that this atlas cannot place.
    expect(landing.locator('.atlas-landing-list--listed li[data-component="depth"]')).to_have_text(
        [re.compile(r"^Depth deepens artist Rick Astley"), re.compile(r"^Depth deepens label RCA")]
    )
    for component, count in FIT_LISTED.items():
        expect(landing.locator(f'.atlas-landing-list--listed li[data-component="{component}"]')).to_have_count(count)
    expect(landing.locator(".atlas-landing-list--listed li", has_text="Hi NRG")).to_contain_text("not drawn on this atlas")
    # The personal layer stays out of the address here too.
    assert "Rick Astley" not in page.url
    assert "249504" not in page.url

    # An outcome the collector reports is still recorded against the profile's impression.
    with page.expect_response(lambda response: response.url.endswith("/api/activity/events") and response.request.method == "POST") as posted:
        page.locator('[data-outcome="dismiss"]').click()
    assert posted.value.status == 202
    events = page.request.get(f"{explore_url}/api/activity/events").json()["events"]
    assert [(event["event_type"], event["impression_id"]) for event in events] == [("fit.dismissed", FIT_IMPRESSION)]
    expect(page.locator(".fit-card")).to_have_count(0)
    # With no card the landing point is taken off the atlas, and the collector's layer stays.
    expect(page.locator("#fitAtlasMount")).to_be_hidden()
