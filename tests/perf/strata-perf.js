// Strata renderer performance smoke test, driven by test_strata_renderer_perf.py.
//
// The method follows gm-design-on0x ("Browsers and measurements"): time to first frame from the
// layout being in memory to the second animation frame after the first render, then frame
// intervals while orbiting at one turn per 8 s. It also records the renderer's own work per frame
// (scene, links, labels; the GPU runs after) and the cost of one resolve pick.

import { StrataRenderer } from '/js/strata-renderer.js';
import { syntheticLayout } from '/__strata_perf__/explore/__tests__/strata-synthetic.js';

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function quantile(values, q) {
    const sorted = values.slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function webglRenderer(gl) {
    const context = gl.getContext();
    const info = context.getExtension('WEBGL_debug_renderer_info');
    return info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
}

async function run({ nodes = 20000, seed = 1, orbitMs = 4000, picks = 50 } = {}) {
    const layout = syntheticLayout({ nodes, seed });
    const stage = document.getElementById('stage');
    const t0 = performance.now();
    const renderer = new StrataRenderer(stage);
    renderer.setLayout(layout);
    renderer.render();
    await frame();
    await frame();
    const ttffMs = performance.now() - t0;

    const deltas = [];
    const work = [];
    const rate = (Math.PI * 2) / 8000;
    let last = null;
    const start = performance.now();
    while (performance.now() - start < orbitMs) {
        const t = await frame();
        if (last !== null) {
            deltas.push(t - last);
            renderer.orbit(rate * (t - last));
            renderer.tick(t);
            work.push(renderer.stats.lastFrameMs);
        }
        last = t;
    }

    const rect = stage.getBoundingClientRect();
    const pickMs = [];
    for (let i = 0; i < picks; i++) {
        const x = rect.left + rect.width * (0.2 + 0.6 * ((i * 0.618) % 1));
        const y = rect.top + rect.height * (0.2 + 0.6 * ((i * 0.382) % 1));
        const p0 = performance.now();
        renderer.pick(x, y);
        pickMs.push(performance.now() - p0);
    }

    const fps = deltas.map((d) => 1000 / d);
    const result = {
        nodes: layout.nodes.length,
        perPlane: [0, 1, 2].map((level) => layout.nodes.filter((n) => n.level === level).length),
        edges: layout.edges.length,
        ttffMs,
        frames: deltas.length,
        frameMs: { median: quantile(deltas, 0.5), p95: quantile(deltas, 0.95), max: Math.max(...deltas) },
        // Frames that took longer than two display intervals at the median rate, and where they fell.
        longFrames: deltas.map((d, i) => [i, d]).filter(([, d]) => d > quantile(deltas, 0.5) * 2).map(([i, d]) => [i, Math.round(d)]),
        fps: { median: quantile(fps, 0.5), p5: quantile(fps, 0.05) },
        workMs: { median: quantile(work, 0.5), p95: quantile(work, 0.95) },
        pickMs: { median: quantile(pickMs, 0.5), p95: quantile(pickMs, 0.95) },
        drawCalls: renderer.gl.info.render.calls,
        draw: renderer.drawCounts(),
        detail: renderer.detail,
        labelCandidates: renderer.stats.labelCandidates,
        labelsShown: renderer.stats.labelsShown,
        verticalBuilds: renderer.stats.verticalBuilds,
        webgl: webglRenderer(renderer.gl),
        viewport: [innerWidth, innerHeight],
        devicePixelRatio,
        userAgent: navigator.userAgent,
    };
    renderer.dispose();
    return result;
}

window.__strataPerf = { run, ready: true };
