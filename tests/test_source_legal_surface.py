"""Static guardrails for the source and legal links in the browser application."""

from html.parser import HTMLParser
from pathlib import Path


class _LinkCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_legal_footer = False
        self.links: dict[str, str] = {}
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "footer" and attributes.get("aria-label") == "Source and legal information":
            self.in_legal_footer = True
        if self.in_legal_footer and tag == "a":
            self._href = attributes.get("href")
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.in_legal_footer and tag == "a" and self._href is not None:
            self.links["".join(self._text).strip()] = self._href
            self._href = None
            self._text = []
        if tag == "footer":
            self.in_legal_footer = False


def test_browser_surface_identifies_source_and_legal_materials() -> None:
    parser = _LinkCollector()
    parser.feed((Path(__file__).parent.parent / "explore/static/index.html").read_text())

    assert parser.links == {
        "Source code": "https://github.com/groovemap-music/graph-explorer",
        "AGPL-3.0-only": "https://github.com/groovemap-music/graph-explorer/blob/main/LICENSE",
        "Third-party notices": "vendor/THIRD_PARTY_NOTICES.md",
        "Trademark use": "https://github.com/groovemap-music/design/blob/main/TRADEMARKS.md",
    }
