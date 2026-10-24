/**
 * A synthetic, unaggregated strata layout for the renderer's tests and its performance smoke test.
 *
 * layoutStrata() folds a large discography until each plane's footprints fit, so it never hands the
 * renderer 20,000 nodes. The renderer must still hold its frame rate there (gm-design-on0x measured
 * webgl-inst unaggregated at 20,000 nodes), so this builds a layout-shaped object directly, at the
 * shape of gm-design-on0x's 20,000-node Discogs band: about √n / 2 credits, 7.4% of nodes on the
 * master plane (one no-master lane per credit), and the rest pressings. Nodes may overlap; only the
 * renderer is under test. Names are placeholders.
 *
 * The browser smoke test (tests/perf/test_strata_renderer_perf.py) imports this file as a module,
 * so it imports only relative paths.
 */

import { PLANE_KINDS, PLANE_SIZES, UNDATED_X, WORLD_DEPTH, WORLD_WIDTH, yearToX } from '../static/js/strata-layout.js';
import { rng } from './strata-fixtures.js';

const STATES = ['none', 'none', 'none', 'wanted', 'owned', 'wanted-owned'];

export function syntheticLayout({ nodes = 20000, seed = 1 } = {}) {
    const r = rng(seed);
    const creditCount = Math.max(1, Math.round(Math.sqrt(nodes) / 2));
    const masterCount = Math.max(creditCount, Math.round(nodes * 0.074));
    const releaseCount = Math.max(0, nodes - creditCount - masterCount);
    const axis = { y0: 1950, y1: 2026, fromX: UNDATED_X + 8, toX: WORLD_WIDTH / 2 - 6, undatedX: UNDATED_X };
    const band = (WORLD_DEPTH - 6) / creditCount;
    const out = [];
    const node = (fields) => {
        const made = {
            parent: null,
            children: [],
            agg: false,
            aggKind: null,
            lane: null,
            undated: false,
            year: null,
            y0: null,
            y1: null,
            releases: 0,
            masters: 0,
            credits: 0,
            state: null,
            states: null,
            recordedAt: null,
            label: null,
            members: [],
            cursor: null,
            pageOf: null,
            origin: 'payload',
            ...fields,
            kind: PLANE_KINDS[fields.level],
            size: PLANE_SIZES[fields.level],
        };
        out.push(made);
        return made;
    };
    const credits = [];
    for (let i = 0; i < creditCount; i++) {
        const z0 = -WORLD_DEPTH / 2 + 3 + i * band;
        credits.push(node({ id: `c:${i}`, level: 0, group: `c:${i}`, x: 0, z: z0 + band / 2, credits: 1, label: `Credit ${i}`, z0 }));
    }
    const masters = [];
    for (let i = 0; i < masterCount; i++) {
        // The first master of each credit is its no-master lane; the rest fall on a Zipf-like curve.
        const credit = i < creditCount ? credits[i] : credits[Math.min(creditCount - 1, Math.floor(creditCount * r() * r()))];
        const lane = i < creditCount;
        const year = r.chance(0.07) ? null : r.int(1955, 2025);
        const master = node({
            id: `m:${i}`,
            level: 1,
            parent: credit.id,
            group: credit.id,
            lane: lane ? 'nomaster' : null,
            agg: lane || r.chance(0.04),
            aggKind: lane ? 'no_master' : null,
            undated: !lane && year === null,
            year: lane ? null : year,
            y0: year,
            y1: year,
            masters: 1,
            label: lane ? null : `Master ${i}`,
            x: year === null || lane ? UNDATED_X : yearToX(axis, year),
            z: credit.z0 + 1 + r() * (band - 2),
        });
        if (master.agg && !lane) master.aggKind = 'masters';
        credit.children.push(master.id);
        masters.push(master);
    }
    for (let i = 0; i < releaseCount; i++) {
        const master = masters[Math.floor(masters.length * r() * r())];
        const year = master.year === null ? (r.chance(0.5) ? null : r.int(1955, 2025)) : Math.min(2026, master.year + r.int(0, 20));
        const agg = r.chance(0.03);
        const release = node({
            id: `r:${i}`,
            level: 2,
            parent: master.id,
            group: master.group,
            agg,
            aggKind: agg ? 'releases' : null,
            undated: year === null,
            year,
            y0: year,
            y1: year,
            releases: agg ? r.int(2, 40) : 1,
            state: agg ? null : r.pick(STATES),
            states: agg ? { none: r.int(1, 10), owned: r.int(0, 2) } : null,
            label: agg ? null : `Pressing ${i}`,
            x: year === null ? UNDATED_X : yearToX(axis, year),
            z: master.z + (r() - 0.5) * 3,
        });
        master.children.push(release.id);
        master.releases++;
    }
    for (const credit of credits) delete credit.z0;
    const edges = [];
    for (let i = 1; i < creditCount; i++) edges.push({ a: credits[0].id, b: credits[i].id, kind: i % 3 ? 'collab' : 'member' });
    for (const credit of credits) {
        const chain = masters.filter((m) => m.parent === credit.id && !m.lane).sort((a, b) => a.x - b.x || a.z - b.z);
        for (let i = 1; i < chain.length; i += 3) edges.push({ a: chain[i - 1].id, b: chain[i].id, kind: 'personnel' });
    }
    return { nodes: out, edges, axis, depth: { usable: WORLD_DEPTH, required: WORLD_DEPTH, fit: 1 }, page: null, rootCredit: credits[0].id };
}
