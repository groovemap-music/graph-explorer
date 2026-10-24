"""E2E: the Genre Atlas, walked the way a listener reads it.

The Genre Atlas draws genres, styles, and landmark masters on three planes, colored by lifecycle
stage over valid time, with a table of the same genres and styles (ADR 0016 section 4). It opens in
the Genres pane. The journey here is the one the feature exists for: open the atlas, read the stage
rule, scrub to a year the catalogue has not caught up with and see it marked provisional, select a
style to see its parents and the emergence edges drawn from them, see its co-tagged styles drawn as
edges (and the ones the atlas does not draw listed beside them), see a failed co-tag read worded
without breaking the atlas, then read the same atlas as a table and move through it from the keyboard.

The mock app serves `GET /api/insights/style-atlas` from tests/fixtures/style-atlas.json, a body
recorded from analytics-engine's own read path over its seeded synthetic catalogue, and synthetic
`GET /api/insights/style-atlas/cotags` lists for a few styles, so no assertion here depends on a
live database. A frame is read only once the stage says `data-strata-frame="settled"`. The 3D view is driven from the keyboard, which is how it is
documented to be used without a pointer. Nothing here reads the GPU, so the journey holds on every
project in the matrix. The recorded timeline is 1951 to 2025 and its last two years are provisional.
"""

from __future__ import annotations

import re

import pytest
from playwright.sync_api import Page, expect


LAST_YEAR = 2025
PROVISIONAL_FROM = 2024
# Under Pop in the recorded body: two parents, both with an emergence edge, a latest stage that
# differs from its settled one, and emerged in 1999 (so it is absent in 1990).
STYLE = "Copper Drift"
STYLE_GENRE = "Pop"
STYLE_OTHER_PARENT = "Blues"
# The mock app's co-tags for STYLE (tests/explore_test_app.py): three of the four styles are drawn
# in the atlas, and "Phantom Fizz" is not. A style whose co-tag read fails.
COTAGS_DRAWN = ["Rust Stomp", "Silver Wave", "Amber Bop"]
COTAGS_LISTED = ["Phantom Fizz"]
FAILING_COTAGS_STYLE = "Solar Pulse"
# The synthetic landmark masters the mock app merges into the recorded body.
MASTERS = 952


def _open_atlas(page: Page, explore_url: str) -> None:
    """Open the Genres pane, which opens on the atlas, and wait for the recorded month to draw."""
    page.goto(explore_url, wait_until="domcontentloaded", timeout=30_000)
    # The nav handlers bind once the app exists. A click before then is swallowed, and Firefox can
    # also drop one, so the click is retried once.
    page.wait_for_function("() => !!window.exploreApp", timeout=10_000)
    link = page.locator("[data-pane='genres']")
    pane = page.locator("#genresPane")
    link.click()
    try:
        expect(pane).to_have_class(re.compile(r"\bactive\b"), timeout=2_000)
    except AssertionError:
        link.click()
        expect(pane).to_have_class(re.compile(r"\bactive\b"), timeout=5_000)
    expect(page.locator("#atlasTitle")).to_have_text("Genre Atlas")
    expect(page.locator("#atlasSummary")).to_contain_text("16 genres, 140 styles, and 78 ghost copies", timeout=15_000)


def _scrub(page: Page, year: int) -> None:
    page.locator("#atlasYear").fill(str(year))
    expect(page.locator(".atlas-year-value")).to_have_text(str(year))


def _select_style(page: Page) -> None:
    """From a cleared selection: the second genre round the ring, then its first style."""
    page.locator("#genreAtlasMount .atlas-stage").focus()
    page.keyboard.press("]")
    page.keyboard.press("]")
    expect(page.locator(".atlas-selection .strata-selection-title")).to_have_text(STYLE_GENRE)
    page.keyboard.press("PageDown")
    expect(page.locator(".atlas-selection .strata-selection-title")).to_have_text(STYLE)


def _settled_cotag_edges(page: Page, count: int) -> None:
    """Wait for a frame that has drawn the current selection, with `count` co-tag edges in it."""
    stage = page.locator("#genreAtlasMount .atlas-stage")
    expect(stage).to_have_attribute("data-strata-frame", "settled", timeout=15_000)
    expect(stage).to_have_attribute("data-atlas-cotag-edges", str(count))


def _table_row(page: Page, name: str):
    """The table row whose name cell is exactly `name`."""
    return page.locator(".atlas-table tbody tr").filter(has=page.locator("th.atlas-cell-name", has_text=re.compile(f"^{re.escape(name)}$")))


def _focused_row_name(page: Page) -> str:
    return page.evaluate("document.activeElement.querySelector('th')?.textContent ?? ''")


@pytest.mark.e2e
def test_genre_atlas_journey_from_the_rule_to_the_table(page: Page, explore_url: str) -> None:
    """Read the rule, scrub into the provisional years, select a style, and read it as a table."""
    _open_atlas(page, explore_url)
    expect(page.locator("#genreAtlasMount canvas")).to_have_count(1)

    # The rule is on screen with its revision. The served id is internal, so it is a small detail
    # line for support and never the heading.
    rule = page.locator(".atlas-rule")
    expect(rule.locator("h4")).to_have_text("Stage rule (version 1)")
    expect(rule.locator("h4")).not_to_contain_text("gm-design")
    expect(rule.locator(".atlas-rule-version")).to_have_text("Rule id gm-design-4804/1")
    expect(rule).to_contain_text("The latest 2 years are provisional")

    # The latest years are provisional: hatched on the scrubber, and said in words, not color alone.
    expect(page.locator(".atlas-year-cell--provisional")).to_have_count(LAST_YEAR - PROVISIONAL_FROM + 1)
    expect(page.locator(".atlas-year-value")).to_have_text(str(LAST_YEAR))
    expect(page.locator("#atlasYearNote")).to_be_visible()
    _scrub(page, PROVISIONAL_FROM)
    expect(page.locator("#atlasYearNote")).to_have_text("provisional")
    expect(page.locator("#atlasYear")).to_have_attribute("aria-valuetext", f"{PROVISIONAL_FROM}, provisional")
    _scrub(page, 1980)
    expect(page.locator("#atlasYearNote")).to_be_hidden()
    expect(page.locator("#atlasYear")).to_have_attribute("aria-valuetext", "1980")
    _scrub(page, LAST_YEAR)

    # Select a style from the keyboard: the second genre round the ring, then its first style.
    selection = page.locator(".atlas-selection")
    _select_style(page)

    # The panel gives the stage in the scrubbed year, the latest stage as provisional with the
    # settled stage beside it, and every parent with its share and its emergence edge.
    expect(selection.locator(".atlas-stage-line").first).to_have_text(f"In {LAST_YEAR}: Decliningprovisional")
    expect(selection.locator(".atlas-stage-latest")).to_have_text(
        f"Latest ({LAST_YEAR}): Decliningprovisional · settled ({PROVISIONAL_FROM - 1}): Established"
    )
    expect(selection).to_contain_text("Emerged in 1999 (25 cumulative releases).")
    parents = selection.locator(".atlas-parents li")
    expect(parents).to_have_count(2)
    expect(parents.filter(has_text=STYLE_GENRE)).to_contain_text("dominant, drawn here")
    expect(parents.filter(has_text=STYLE_GENRE)).to_contain_text(f"emerged after {STYLE_GENRE}: emergence edge drawn")
    expect(parents.filter(has_text=STYLE_OTHER_PARENT)).to_contain_text("ghost copy")
    expect(parents.filter(has_text=STYLE_OTHER_PARENT)).to_contain_text(f"emerged after {STYLE_OTHER_PARENT}: emergence edge drawn")

    # The route's co-tags arrive on demand: the pairs whose two styles are drawn become edges from
    # the selected style (counted on the settled frame), and a co-tagged style the atlas does not
    # draw is listed in the panel instead.
    _settled_cotag_edges(page, len(COTAGS_DRAWN))
    expect(selection.locator(".atlas-cotags--drawn li")).to_have_text([re.compile(rf"^{name} · \d+ shared releases$") for name in COTAGS_DRAWN])
    expect(selection.locator(".atlas-cotags--listed li")).to_have_text([re.compile(rf"^{name} · \d+ shared releases$") for name in COTAGS_LISTED])
    expect(selection).not_to_contain_text("Co-tagged styles are not served yet")

    # Clearing the selection takes the edges and the list away; selecting it again brings them back.
    page.keyboard.press("Escape")
    expect(selection).to_contain_text("Select a genre or a style")
    _settled_cotag_edges(page, 0)
    expect(selection.locator(".atlas-cotags")).to_have_count(0)
    _select_style(page)
    _settled_cotag_edges(page, len(COTAGS_DRAWN))
    expect(selection.locator(".atlas-cotags--drawn li")).to_have_count(len(COTAGS_DRAWN))

    # The mock app serves synthetic landmark masters, each in its style's cell, so the masters plane
    # counts them and soloing it has nothing to explain.
    expect(page.locator('#genreAtlasMount .strata-plane-label[data-level="2"]')).to_contain_text(str(MASTERS))
    page.keyboard.press("3")
    expect(page.locator(".atlas-message")).to_be_hidden()
    page.keyboard.press("3")
    expect(page.locator(".atlas-message")).to_be_hidden()

    # Switch to the table. It lists the same genres and styles, marks the style just selected, and
    # leaves the scrubber where it was.
    page.locator('[data-atlas-view="table"]').click()
    expect(page.locator('[data-atlas-view="table"]')).to_have_attribute("aria-pressed", "true")
    expect(page.locator(".atlas-stage")).to_be_hidden()
    table = page.locator(".atlas-table")
    expect(table).to_be_visible()
    expect(table.locator("caption")).to_have_text(f"Genres and styles: 156 rows as of {LAST_YEAR}, in outline order.")
    expect(table.locator("tbody tr")).to_have_count(156)
    expect(page.locator(".atlas-year-value")).to_have_text(str(LAST_YEAR))
    selected = _table_row(page, STYLE)
    expect(selected).to_have_attribute("aria-current", "true")
    expect(selected.locator(".atlas-cell-stage").first).to_have_text("Declining")
    expect(selected.locator(".atlas-cell-provisional")).to_have_text("provisional")
    expect(selected.locator(".atlas-cell-stage").nth(2)).to_have_text("Established")
    expect(selected.locator(".atlas-cell-year")).to_have_text("1999")
    expect(selected.locator(".atlas-cell-dominant")).to_have_text(STYLE_GENRE)
    expect(selected.locator(".atlas-cell-parents")).to_contain_text(f"{STYLE_GENRE} 97%")
    expect(selected.locator(".atlas-cell-edges")).to_have_text(f"{STYLE_OTHER_PARENT}: drawn · {STYLE_GENRE}: drawn")
    expect(page.locator(".atlas-table-note")).to_have_text("")

    # A style whose co-tag read fails says so, and the atlas stays usable: the panel still describes
    # the style, the table still answers, and the style selected before is still there to select.
    _table_row(page, FAILING_COTAGS_STYLE).click()
    expect(selection.locator(".strata-selection-title")).to_have_text(FAILING_COTAGS_STYLE)
    expect(selection.locator(".atlas-cotag-state")).to_contain_text("Co-tagged styles could not be loaded")
    expect(selection.locator(".atlas-parents")).to_be_visible()
    expect(table.locator("tbody tr")).to_have_count(156)
    _table_row(page, STYLE).click()
    expect(selection.locator(".strata-selection-title")).to_have_text(STYLE)
    expect(selection.locator(".atlas-cotags--drawn li")).to_have_count(len(COTAGS_DRAWN))

    # The scrubber is shared: a settled year repaints the same rows, and the provisional flag follows.
    _scrub(page, 1990)
    expect(table.locator('th[data-column="stage"] button')).to_have_text("Stage in 1990")
    expect(selected.locator(".atlas-cell-stage").first).to_have_text("Absent")
    expect(selected.locator(".atlas-cell-provisional")).to_have_text("settled")
    _scrub(page, PROVISIONAL_FROM)
    expect(selected.locator(".atlas-cell-provisional")).to_have_text("provisional")
    _scrub(page, LAST_YEAR)

    # Sort: ascending, descending, and the outline order again; each is announced.
    emerged = table.locator('th[data-column="emerged"]')
    emerged.get_by_role("button").click()
    expect(emerged).to_have_attribute("aria-sort", "ascending")
    expect(page.locator("#genreAtlasMount [role=status]").first).to_contain_text("sorted by emerged, ascending")
    expect(table.locator("tbody tr").first.locator(".atlas-cell-year")).to_have_text("1951")
    emerged.get_by_role("button").click()
    expect(emerged).to_have_attribute("aria-sort", "descending")
    expect(table.locator("tbody tr").first.locator(".atlas-cell-year")).to_have_text("2023")
    emerged.get_by_role("button").click()
    expect(emerged).to_have_attribute("aria-sort", "none")
    expect(table.locator("tbody tr").first.locator("th")).to_have_text("Blues")

    # The keyboard: the selected row is the one tab stop. Down and Up move, End and Home jump,
    # PageUp goes to the dominant parent genre, PageDown to a genre's first style, Space selects a
    # row and describes it in the panel, and Escape clears the selection.
    selected.focus()
    expect(selected).to_be_focused()
    page.keyboard.press("PageUp")
    assert _focused_row_name(page) == STYLE_GENRE
    expect(table.locator("tbody tr[tabindex='0']")).to_have_count(1)
    page.keyboard.press("ArrowDown")
    assert _focused_row_name(page) != STYLE_GENRE
    page.keyboard.press("ArrowUp")
    assert _focused_row_name(page) == STYLE_GENRE
    page.keyboard.press("End")
    last = _focused_row_name(page)
    page.keyboard.press("ArrowDown")
    assert _focused_row_name(page) == last
    page.keyboard.press("Home")
    assert _focused_row_name(page) == "Blues"
    page.keyboard.press("PageDown")
    first_style = _focused_row_name(page)
    assert first_style != "Blues"
    page.keyboard.press("Space")
    expect(selection.locator(".strata-selection-title")).to_have_text(first_style)
    expect(table.locator("tbody tr[aria-current='true']")).to_have_count(1)
    page.keyboard.press("Escape")
    expect(table.locator("tbody tr[aria-current]")).to_have_count(0)
    expect(selection).to_contain_text("Select a genre or a style")

    # Back to the 3D view: the loop restarts and the selection made in the table is the 3D one.
    _table_row(page, STYLE).click()
    expect(selection.locator(".strata-selection-title")).to_have_text(STYLE)
    page.locator('[data-atlas-view="strata"]').click()
    expect(page.locator(".atlas-stage")).to_be_visible()
    expect(table).to_be_hidden()
    expect(selection.locator(".strata-selection-title")).to_have_text(STYLE)


@pytest.mark.e2e
def test_genre_atlas_table_opens_where_webgl_does_not(page: Page, explore_url: str) -> None:
    """With no WebGL the 3D view says so and points at the table, which needs none."""
    page.add_init_script(
        """
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
            return /webgl/i.test(String(type)) ? null : getContext.call(this, type, ...rest);
        };
        """
    )
    _open_atlas(page, explore_url)
    expect(page.locator(".atlas-message")).to_have_text(
        "This browser cannot draw the 3D atlas: WebGL is not available. The table lists the same genres and styles."
    )
    page.locator('[data-atlas-view="table"]').click()
    expect(page.locator(".atlas-message")).to_be_hidden()
    expect(page.locator(".atlas-table tbody tr")).to_have_count(156)
