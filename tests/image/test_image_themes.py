"""Packaged-image theme check: run the built container and read its themes in a real browser.

The source-level browser tests serve the working tree, so they cannot see a published image that
still carries an older theme (v0.2.2 served the Deep Space navy/cyan theme after brass/oxblood
landed in 8fc32cf). This module runs the image itself, loads it in headless Chromium under both
prefers-color-scheme values, and asserts the computed design tokens the page really resolved.

GRAPH_EXPLORER_IMAGE selects the image under test (default graph-explorer:local, the `just image`
tag); GRAPH_EXPLORER_PLATFORM adds --platform for an image of another architecture. The same assertions run against any image, so pointing them at a published tag is the
negative proof that they detect the regression. Screenshots go to test-results/image-themes/.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

import httpx
import pytest
from playwright.sync_api import Page, sync_playwright


if TYPE_CHECKING:
    from collections.abc import Iterator


pytestmark = pytest.mark.image

ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("GRAPH_EXPLORER_IMAGE", "graph-explorer:local")
# Set when the image is not built for the host architecture (the published tags are linux/amd64).
PLATFORM = os.environ.get("GRAPH_EXPLORER_PLATFORM", "")
SCREENSHOTS = ROOT / "test-results" / "image-themes"

# Canonical brass/oxblood tokens, from explore/static/brand/tokens.css and the :root blocks of
# explore/static/css/styles.css. Dark is the brass-on-vinyl palette, light is oxblood on bone.
CANONICAL = {
    "dark": {
        "--groovemap-brass": "#b8962a",
        "--groovemap-oxblood": "#4d0018",
        "--groovemap-void": "#0e0d0b",
        "--groovemap-text": "#f2ede4",
        "--groovemap-light-background": "#eeeae3",
        "--bg-void": "#0a0908",
        "--bg-deep": "#0e0d0b",
        "--card-bg": "#12110e",
        "--text-high": "#f2ede4",
        "--cyan-500": "#b8962a",
        "--blue-accent": "#b8962a",
        "--on-accent": "#0e0d0b",
    },
    "light": {
        "--groovemap-brass": "#b8962a",
        "--groovemap-oxblood": "#4d0018",
        "--groovemap-void": "#0e0d0b",
        "--groovemap-text": "#f2ede4",
        "--groovemap-light-background": "#eeeae3",
        "--bg-void": "#eeeae3",
        "--bg-deep": "#f7f4ee",
        "--card-bg": "#fbf9f5",
        "--text-high": "#1a1714",
        "--cyan-500": "#4d0018",
        "--blue-accent": "#4d0018",
        "--on-accent": "#ffffff",
    },
}

# The page background and text the user sees (body, as rgb()), per scheme.
CANONICAL_SURFACE = {
    "dark": {"background-color": "rgb(14, 13, 11)", "color": "rgb(242, 237, 228)"},
    "light": {"background-color": "rgb(247, 244, 238)", "color": "rgb(26, 23, 20)"},
}

# Values of the two themes brass/oxblood replaced, none of which may resolve in any custom property
# in either scheme. Deep Space (navy, cyan, purple) is what v0.2.2 serves:
# git show 18aa8438:explore/static/brand/tokens.css and css/styles.css. Lagoon/Mint is the
# intermediate theme, a4657fc..8fc32cf.
PREVIOUS_THEME_VALUES = {
    "#00bcd4": "deep space cyan",
    "#00e5ff": "deep space cyan glow",
    "#80f0ff": "deep space cyan bright",
    "#007c91": "deep space cyan (light)",
    "#7c4dff": "deep space purple",
    "#b388ff": "deep space purple light",
    "#060a12": "deep space void",
    "#0a1018": "deep space deep",
    "#0f1a2e": "deep space card",
    "#1e3050": "deep space border",
    "#f0f4f8": "deep space text / light background",
    "#e7ebf0": "deep space light void",
    "#10192b": "deep space light text",
    "#0d1b2a": "deep space light text (brand)",
    "#4a5e78": "deep space muted text",
    "#0d353f": "lagoon",
    "#a8fff2": "mint",
    "#d4fff9": "mint tint",
    "#2a7a85": "lagoon 700 (dark)",
    "#1d5560": "lagoon 700 (light)",
    "#071211": "old void",
    "#0a1514": "old deep",
    "#1e3533": "old border",
    "#e8f4f1": "old text",
    "#8aa5a0": "old muted text",
    "#f2f7f6": "old light background",
    "#0b1716": "old light text",
    "#4e6461": "old light muted text",
}
PREVIOUS_THEME_TOKENS = (
    "--groovemap-lagoon",
    "--groovemap-mint",
    "--groovemap-cyan",
    "--groovemap-cyan-glow",
    "--groovemap-purple",
    "--groovemap-purple-light",
)

COLLECT_CUSTOM_PROPERTIES = """() => {
    const names = new Set();
    const visit = (rules) => {
        for (const rule of rules) {
            if (rule.style) {
                for (const name of rule.style) if (name.startsWith('--')) names.add(name);
            }
            if (rule.cssRules) visit(rule.cssRules);
        }
    };
    for (const sheet of document.styleSheets) {
        try { visit(sheet.cssRules); } catch (error) { /* cross-origin sheet */ }
    }
    const computed = getComputedStyle(document.documentElement);
    const values = {};
    for (const name of names) values[name] = computed.getPropertyValue(name).trim().toLowerCase();
    const body = getComputedStyle(document.body);
    return {
        values,
        surface: {'background-color': body.backgroundColor, color: body.color},
        dark_class: document.documentElement.classList.contains('dark'),
    };
}"""


def _docker(*args: str) -> str:
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True, timeout=120).stdout.strip()  # noqa: S603, S607


@pytest.fixture(scope="module")
def image_url() -> Iterator[str]:
    """Run the image with no catalog backend: the UI is static, so it serves without one."""
    name = f"graph-explorer-themes-{uuid.uuid4().hex[:8]}"
    # Port 9 (discard) refuses connections, so any API call fails fast instead of reaching a real host.
    platform = ["--platform", PLATFORM] if PLATFORM else []
    _docker("run", "--detach", "--rm", *platform, "--name", name, "--publish", "127.0.0.1::8006", "--env", "API_BASE_URL=http://127.0.0.1:9", IMAGE)
    try:
        host_port = _docker("port", name, "8006/tcp").splitlines()[0].rsplit(":", 1)[1]
        url = f"http://127.0.0.1:{host_port}"
        deadline = time.monotonic() + 60
        while True:
            try:
                if httpx.get(f"{url}/health", timeout=2.0).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True, check=False)  # noqa: S603, S607
                pytest.fail(f"{IMAGE} did not serve /health within 60s\n{logs.stdout}{logs.stderr}")
            time.sleep(0.5)
        yield url
    finally:
        subprocess.run(["docker", "rm", "--force", name], capture_output=True, check=False)  # noqa: S603, S607


@pytest.fixture(scope="module")
def headless_chromium() -> Iterator[object]:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        yield browser
        browser.close()


def _load(browser: object, url: str, scheme: str) -> tuple[Page, dict]:
    context = browser.new_context(color_scheme=scheme, viewport={"width": 1280, "height": 900})  # type: ignore[attr-defined]
    page = context.new_page()
    page.goto(url, wait_until="load")
    # tokens.css and styles.css are linked stylesheets: wait until a brand token has resolved.
    page.wait_for_function("getComputedStyle(document.documentElement).getPropertyValue('--bg-void').trim() !== ''", timeout=15_000)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    label = re.sub(r"[^A-Za-z0-9_.-]+", "_", IMAGE)
    page.screenshot(path=str(SCREENSHOTS / f"{label}-{scheme}.png"))
    return page, page.evaluate(COLLECT_CUSTOM_PROPERTIES)


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_image_serves_canonical_theme(headless_chromium: object, image_url: str, scheme: str) -> None:
    page, snapshot = _load(headless_chromium, image_url, scheme)
    values = snapshot["values"]

    assert snapshot["dark_class"] is (scheme == "dark")
    wrong = {token: (values.get(token), expected) for token, expected in CANONICAL[scheme].items() if values.get(token) != expected}
    assert not wrong, f"{IMAGE} {scheme}: token -> (served, canonical) mismatches: {wrong}"
    assert snapshot["surface"] == CANONICAL_SURFACE[scheme], f"{IMAGE} {scheme}: body surface/text colors"
    page.context.close()


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_image_has_no_previous_theme_values(headless_chromium: object, image_url: str, scheme: str) -> None:
    page, snapshot = _load(headless_chromium, image_url, scheme)
    values = snapshot["values"]

    leaked = {name: value for name, value in values.items() if any(old in value for old in PREVIOUS_THEME_VALUES)}
    assert not leaked, f"{IMAGE} {scheme}: custom properties carrying pre-brass Deep Space / Lagoon / Mint values: {leaked}"
    assert not [token for token in PREVIOUS_THEME_TOKENS if token in values], f"{IMAGE} {scheme}: previous-theme brand tokens are still defined"
    page.context.close()
