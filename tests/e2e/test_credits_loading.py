"""E2E: a person's credits panels render as they settle, and a superseded load stops asking.

The credits pane loads four things for a person: profile, timeline, connections, and every credit,
500 to a page. For a 60,000-credit person that is 120 pages, minutes at the API's 60 requests a minute,
so the other three panels must not wait for the last page, and picking another person must stop the old
paging at once rather than let it spend the same rate-limit bucket and the catalog's Neo4j reads.

The catalog API is stood in for with Playwright routes, so what is counted here is what the real
browser really sent: its own fetch, its own AbortController, its own network stack.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from playwright.sync_api import Page, Route, expect


PAGE_SIZE = 500
BIG_TOTAL = 60_000
BIG_PERSON = "Big Catalog Engineer"
OTHER_PERSON = "Ann Other"
# The big person's pages the mock answers before it stops answering, as a slow API does.
PAGES_ANSWERED = 3


def _credit(index: int) -> dict[str, Any]:
    return {"year": 2000, "title": f"Release {index}", "artists": ["A"], "role": "Mastering", "category": "mastering"}


def _json(route: Route, body: dict[str, Any], status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def _install_credits_api(page: Page, *, total_for: dict[str, int], hold_big_after_pages: bool) -> dict[str, Any]:
    """Route the credits endpoints; return what the browser asked, and the requests left unanswered."""
    seen: dict[str, Any] = {"pages": [], "held": [], "failed": []}

    def person(route: Route) -> None:
        url = route.request.url
        name = re.search(r"/api/credits/person/([^/?]+)", url)
        who = name.group(1).replace("%20", " ") if name else ""
        if "/profile" in url:
            _json(route, {"name": who, "total_credits": total_for[who], "role_breakdown": [{"category": "mastering", "count": total_for[who]}]})
        elif "/timeline" in url:
            _json(route, {"timeline": [{"year": 2000, "count": 5}]})
        else:
            offset = int(re.search(r"offset=(\d+)", url).group(1))  # type: ignore[union-attr]
            seen["pages"].append((who, offset))
            if hold_big_after_pages and who == BIG_PERSON and offset >= PAGES_ANSWERED * PAGE_SIZE:
                seen["held"].append(route)  # never answered: the browser's request stays open until it aborts it
                return
            end = min(offset + PAGE_SIZE, total_for[who])
            _json(
                route,
                {
                    "credits": [_credit(i) for i in range(offset, end)],
                    "total_credits": total_for[who],
                    "limit": PAGE_SIZE,
                    "offset": offset,
                    "has_more": end < total_for[who],
                },
            )

    page.route(re.compile(r".*/api/credits/person/[^/]+(/profile|/timeline)?(\?.*)?$"), person)
    page.route(re.compile(r".*/api/credits/connections/.*"), lambda route: _json(route, {"connections": []}))
    page.route(re.compile(r".*/api/credits/autocomplete.*"), lambda route: _json(route, {"results": [{"name": BIG_PERSON}, {"name": OTHER_PERSON}]}))
    page.route(re.compile(r".*/api/credits/role/.*"), lambda route: _json(route, {"entries": []}))
    page.on("requestfailed", lambda request: seen["failed"].append(request.url))
    return seen


def _until(page: Page, condition: Any, what: str, timeout_ms: int = 10_000) -> None:
    """Poll a Python condition while the browser keeps running (the sync API has no ``expect.poll``)."""
    waited = 0
    while not condition():
        if waited >= timeout_ms:
            pytest.fail(f"timed out waiting for {what}")
        page.wait_for_timeout(50)
        waited += 50


def _pick(page: Page, name: str) -> None:
    box = page.locator("#creditsSearchInput")
    box.fill(name[:3])
    page.locator(f'.autocomplete-item[data-name="{name}"]').click()


def _open_credits(page: Page, explore_url: str) -> None:
    page.goto(explore_url)
    page.locator('[data-pane="credits"]').click()
    expect(page.locator("#creditsPane")).to_be_visible()


@pytest.mark.e2e
def test_panels_render_while_credits_page_and_picking_another_person_stops_the_old_paging(page: Page, explore_url: str) -> None:
    seen = _install_credits_api(page, total_for={BIG_PERSON: BIG_TOTAL, OTHER_PERSON: 40}, hold_big_after_pages=True)
    _open_credits(page, explore_url)

    _pick(page, BIG_PERSON)

    # Profile and timeline are up while the credits are still paging, with progress shown.
    expect(page.locator("#creditsPersonName")).to_have_text(BIG_PERSON)
    expect(page.locator("#creditsTimelineSection")).to_be_visible()
    expect(page.locator("#creditsReleaseSection")).to_be_hidden()  # a partial list is never drawn
    expect(page.locator("#creditsLoading")).to_be_visible()
    expect(page.locator("#creditsLoadingText")).to_have_text(f"Loading credits... {PAGES_ANSWERED * PAGE_SIZE:,} of {BIG_TOTAL:,}")
    _until(page, lambda: len(seen["held"]) > 0, "the open request for the next page")
    big_requests_before = sum(1 for who, _ in seen["pages"] if who == BIG_PERSON)
    assert big_requests_before == PAGES_ANSWERED + 1  # three answered pages and the one still open

    _pick(page, OTHER_PERSON)

    # The open request for the first person's next page is aborted by the browser, and nothing more is asked.
    _until(page, lambda: any("offset=1500" in url and "Big" in url for url in seen["failed"]), "the browser to abort the open page request")
    expect(page.locator("#creditsPersonName")).to_have_text(OTHER_PERSON)
    expect(page.locator("#creditsReleaseCount")).to_have_text("(40)")
    expect(page.locator("#creditsLoading")).to_be_hidden()
    page.wait_for_timeout(1_000)
    assert sum(1 for who, _ in seen["pages"] if who == BIG_PERSON) == big_requests_before
    assert sum(1 for who, _ in seen["pages"] if who == OTHER_PERSON) == 1


@pytest.mark.e2e
def test_every_credit_still_loads(page: Page, explore_url: str) -> None:
    total = 3_200
    seen = _install_credits_api(page, total_for={BIG_PERSON: total, OTHER_PERSON: 1}, hold_big_after_pages=False)
    _open_credits(page, explore_url)

    _pick(page, BIG_PERSON)

    expect(page.locator("#creditsReleaseCount")).to_have_text(f"({total:,})", timeout=15_000)
    expect(page.locator("#creditsLoading")).to_be_hidden()
    assert [offset for who, offset in seen["pages"] if who == BIG_PERSON] == list(range(0, total, PAGE_SIZE))
    assert seen["failed"] == []


@pytest.mark.e2e
def test_a_failed_load_renders_no_partial_list(page: Page, explore_url: str) -> None:
    seen = _install_credits_api(page, total_for={BIG_PERSON: 2_000, OTHER_PERSON: 1}, hold_big_after_pages=False)
    # The third page fails with a server error after two good ones.
    page.route(
        re.compile(r".*/api/credits/person/Big[^/]*\?limit=500&offset=1000$"),
        lambda route: (seen["pages"].append((BIG_PERSON, 1000)), _json(route, {"error": "boom"}, status=500)),
    )
    _open_credits(page, explore_url)

    _pick(page, BIG_PERSON)

    expect(page.locator("#creditsPersonName")).to_have_text(BIG_PERSON)  # the other panels still render
    expect(page.locator("#creditsLoading")).to_be_hidden()
    expect(page.locator("#creditsReleaseSection")).to_be_hidden()
    expect(page.locator(".credits-release-row")).to_have_count(0)
    assert (BIG_PERSON, 1000) in seen["pages"]  # the failing page was really asked for
