"""Performance smoke test: the Strata renderer on a 20,000-node synthetic layout.

gm-design-on0x measured the webgl-inst engine unaggregated at 20,000 nodes and chose it because it
alone held the display's frame rate there. This drives the shipped renderer
(``explore/static/js/strata-renderer.js``) over the same scale in Chromium, under the strict policy
the spike used (``script-src 'self'`` plus the importmap's hash, ``style-src 'self'``), and records
time to first frame, frame time while orbiting, the renderer's own work per frame, and the cost of
one resolve pick. The figures land in ``test-results/strata-renderer-perf.json``; the measured
result is in ``docs/strata-renderer.md``.

It is a smoke test, not a regression gate. Frame rate depends on the GPU and on the display, so the
assertions are that the scene builds, every node is drawn, frames keep coming, and no page error or
policy violation occurs. Run it with ``just strata-perf``; ``STRATA_PERF_HEADED=1`` runs a headed
browser instead, as the spike's runs did.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Route, sync_playwright


pytestmark = pytest.mark.benchmark

ROOT = Path(__file__).resolve().parents[2]
HARNESS = Path(__file__).resolve().parent
EXPLORE = ROOT / "explore"
PREFIX = "/__strata_perf__/"
# What the harness may load besides the app's own static files: itself, and the synthetic layout
# generator with the modules it imports.
SERVED = {
    "harness/": HARNESS,
    "explore/__tests__/": EXPLORE / "__tests__",
    "explore/static/js/": EXPLORE / "static" / "js",
}
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
NODES = int(os.environ.get("STRATA_PERF_NODES", "20000"))
ORBIT_MS = int(os.environ.get("STRATA_PERF_ORBIT_MS", "4000"))
RESULT = ROOT / "test-results" / "strata-renderer-perf.json"
HEADED = os.environ.get("STRATA_PERF_HEADED") == "1"
# Headless Chromium rasterises WebGL on the CPU (SwiftShader) unless pointed at a GPU backend. On
# macOS, ANGLE's Metal backend reaches the real GPU headless; elsewhere the default backend stays,
# and the recorded `webgl` string says which one ran. Chromium also paces a headless page's
# animation frames by its own throttles (15 to 60 fps for a 50-node scene on a loaded machine), so
# a headless run lifts the vsync cap and a frame interval is the time a frame costs. A headed run
# keeps the display's cap, as the spike's runs did, and reports frame rate against it.
GPU_ARGS = [
    "--ignore-gpu-blocklist",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    *(["--use-angle=metal"] if sys.platform == "darwin" else []),
    *([] if HEADED else ["--disable-gpu-vsync", "--disable-frame-rate-limit"]),
]


def content_security_policy(html: str) -> str:
    """Return the spike's strict policy, with the hash of the page's one inline importmap."""
    match = re.search(r'<script type="importmap">(.*?)</script>', html, flags=re.DOTALL)
    assert match is not None, "the harness page has no importmap"
    digest = base64.b64encode(hashlib.sha256(match.group(1).encode()).digest()).decode()
    return "; ".join(
        (
            "default-src 'self'",
            f"script-src 'self' 'sha256-{digest}'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        )
    )


def serve(route: Route) -> None:
    """Fulfil a harness request from the allowed directories, never outside them."""
    path = route.request.url.split(PREFIX, 1)[1].split("?", 1)[0]
    for prefix, directory in SERVED.items():
        if not path.startswith(prefix):
            continue
        file = (directory / path.removeprefix(prefix)).resolve()
        if file.is_file() and file.is_relative_to(directory.resolve()):
            body = file.read_text()
            headers = {"Content-Type": f"{TYPES.get(file.suffix, 'text/plain')}; charset=utf-8"}
            if file.suffix == ".html":
                headers["Content-Security-Policy"] = content_security_policy(body)
            route.fulfill(status=200, headers=headers, body=body)
            return
    route.fulfill(status=404, body="not found")


@pytest.mark.timeout(300)
def test_strata_renderer_frame_time_at_20000_nodes(test_server: str) -> None:
    """The renderer draws 20,000 nodes under a strict policy and records its frame time."""
    if not (EXPLORE / "static" / "vendor" / "three.module.js").is_file():
        pytest.fail("three.js is not vendored into explore/static/vendor; run `just web-build` first")
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not HEADED, args=GPU_ARGS)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
            page.add_init_script(
                "window.__csp = []; document.addEventListener('securitypolicyviolation', "
                "(e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));"
            )
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.route(f"**{PREFIX}**", serve)
            page.goto(f"{test_server}{PREFIX}harness/strata-perf.html")
            page.wait_for_function("window.__strataPerf && window.__strataPerf.ready", timeout=30_000)
            result: dict[str, Any] = page.evaluate("(options) => window.__strataPerf.run(options)", {"nodes": NODES, "orbitMs": ORBIT_MS})
            violations: list[str] = page.evaluate("window.__csp")
        finally:
            browser.close()

    result.update(mode="headed, display-capped" if HEADED else "headless, uncapped", cspViolations=violations, pageErrors=errors)
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(
        f"\nStrata renderer, {result['nodes']} nodes {result['perPlane']} on {result['webgl']}"
        f" ({result['mode']}, {result['viewport'][0]}x{result['viewport'][1]} @{result['devicePixelRatio']}x):"
        f"\n  time to first frame {result['ttffMs']:.0f} ms"
        f"\n  frame time median {result['frameMs']['median']:.2f} ms, p95 {result['frameMs']['p95']:.2f} ms"
        f" ({result['fps']['median']:.0f} / {result['fps']['p5']:.0f} fps median / 5th percentile, {result['frames']} frames)"
        f"\n  renderer work per frame median {result['workMs']['median']:.2f} ms, p95 {result['workMs']['p95']:.2f} ms"
        f"\n  resolve pick median {result['pickMs']['median']:.2f} ms, p95 {result['pickMs']['p95']:.2f} ms"
        f"\n  {result['drawCalls']} draw calls; {result['labelsShown']} labels placed, from {result['labelCandidates']} node candidates and the hull tags"
    )

    assert violations == []
    assert errors == []
    assert result["nodes"] == NODES
    assert result["draw"]["instances"] >= NODES
    assert result["frames"] >= 30
    assert result["verticalBuilds"] == 1
