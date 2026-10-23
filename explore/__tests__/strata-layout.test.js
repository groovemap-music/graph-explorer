// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
    GROUP_GUTTER,
    HULL_PAD,
    MAX_MASTERS_PAGE,
    MAX_PRESSINGS_PAGE,
    PAGE_SIZE,
    PLANE_SIZES,
    UNDATED_X,
    adaptStrataPayload,
    edgeSegment,
    hull,
    hullIntrusions,
    hullPolygons,
    inPoly,
    layoutStrata,
    nodeOverlaps,
    samePlaneCrossings,
    segmentsCross,
    yearToX,
} from '../static/js/strata-layout.js';
import { buildPayload, deepFreeze, generateDiscography, generateEdges, rng } from './strata-fixtures.js';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'js', 'strata-layout.js');

// Budgets as `credits/masters/releases`. 3/12/16 is the route's default, so it is drawn most often.
const BUDGETS = [[3, 12, 16], [3, 12, 16], [3, 12, 16], [6, 12, 16], [6, 12, 25], [12, 24, 32], [4, 8, 12], [2, 5, 8], [3, 4, 4], [1, 1, 1], null];
// Discography sizes in releases, log-uniform from 1 to the cap.
const SIZES = [20, 200, 2000];
// Unbudgeted payloads (every entry a node) are drawn only up to this many releases.
const UNBUDGETED_MAX = 400;

/** Run `property` over `runs` seeds; a failure names its seed so it can be replayed. */
function forAll(runs, firstSeed, property) {
    for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
        try {
            property(rng(seed), seed);
        } catch (error) {
            error.message = `seed ${seed}: ${error.message}`;
            throw error;
        }
    }
}

function generateCase(r) {
    const discography = generateDiscography(r, { maxReleases: r.pick(SIZES) });
    let budget = r.pick(BUDGETS);
    if (!budget && discography.releases.length > UNBUDGETED_MAX) budget = [3, 12, 16];
    const payload = deepFreeze(buildPayload(discography, budget, { signedIn: r.chance(0.5) }));
    const edges = deepFreeze(generateEdges(r, payload));
    return { discography, budget, payload, edges, graph: adaptStrataPayload(payload) };
}

// ---------------------------------------------------------------------------------------------
// Oracles. Each checks an invariant directly, without the module's own readouts.
// ---------------------------------------------------------------------------------------------

function overlaps(layout) {
    let count = 0;
    for (const a of layout.nodes) {
        for (const b of layout.nodes) {
            if (a.id < b.id && a.level === b.level && Math.hypot(a.x - b.x, a.z - b.z) < a.size + b.size) count++;
        }
    }
    return count;
}

// A sufficient condition for no intrusion, stricter than the hull test: every node on a plane lies
// outside the depth range of each other credit's nodes, widened by the hull's whole padding.
function bandIntrusions(layout) {
    let count = 0;
    for (const level of [0, 1, 2]) {
        const nodes = layout.nodes.filter((node) => node.level === level);
        const pad = PLANE_SIZES[level] + HULL_PAD;
        const range = new Map();
        for (const node of nodes) {
            const [lo, hi] = range.get(node.group) || [Infinity, -Infinity];
            range.set(node.group, [Math.min(lo, node.z), Math.max(hi, node.z)]);
        }
        for (const node of nodes) {
            for (const [group, [lo, hi]] of range) if (group !== node.group && node.z >= lo - pad && node.z <= hi + pad) count++;
        }
    }
    return count;
}

function crossings(layout) {
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const drawn = layout.edges.map((edge) => ({ edge, a: byId.get(edge.a), b: byId.get(edge.b) }));
    let count = 0;
    for (const p of drawn) {
        for (const q of drawn) {
            if (p === q || p.a.level !== q.a.level) continue;
            if ([p.a, p.b].some((node) => node === q.a || node === q.b)) continue;
            const s = edgeSegment(p.a, p.b);
            const t = edgeSegment(q.a, q.b);
            if (s && t && segmentsCross(s, t)) count++;
        }
    }
    return count / 2;
}

/** Every payload entry is held by exactly one drawn node, and the counts add up. */
function expectConserved(graph, layout) {
    const held = new Map();
    for (const node of layout.nodes) for (const id of node.members) held.set(id, (held.get(id) || 0) + 1);
    for (const entry of graph.entries) expect(held.get(entry.id), `${entry.id} held`).toBe(1);
    expect(held.size).toBe(graph.entries.length);
    const sum = (list, field) => list.reduce((total, item) => total + item[field], 0);
    const masterEntries = graph.entries.filter((entry) => entry.level === 1);
    const masterNodes = layout.nodes.filter((node) => node.level === 1);
    expect(sum(masterNodes, 'releases')).toBe(sum(masterEntries, 'releases'));
    expect(sum(masterNodes, 'masters')).toBe(sum(masterEntries, 'masters'));
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const node of masterNodes) {
        const children = node.children.map((id) => byId.get(id));
        if (children.length) expect(sum(children, 'releases'), `${node.id} releases`).toBe(node.releases);
    }
    for (const node of layout.nodes) {
        if (node.level === 0) {
            expect(node.parent).toBeNull();
            expect(node.group).toBe(node.id);
        } else {
            const parent = byId.get(node.parent);
            expect(parent.level).toBe(node.level - 1);
            expect(parent.children).toContain(node.id);
            expect(node.group).toBe(parent.group);
        }
    }
}

/** The no-master lane and the undated strip keep their entries. */
function expectLanes(graph, layout) {
    const holder = new Map();
    for (const node of layout.nodes) for (const id of node.members) holder.set(id, node);
    for (const entry of graph.entries) {
        const node = holder.get(entry.id);
        if (entry.lane) {
            expect(node.lane, `${entry.id} stays a lane`).toBe('nomaster');
            expect(node.level).toBe(1);
        }
        if (entry.undated && node.level === entry.level) {
            expect(node.x, `${entry.id} sits in the undated strip`).toBe(UNDATED_X);
            expect(node.undated).toBe(true);
        }
    }
    if (graph.entries.some((entry) => entry.lane)) expect(layout.nodes.some((node) => node.lane === 'nomaster')).toBe(true);
    for (const node of layout.nodes) {
        if (node.undated) expect(node.x).toBe(UNDATED_X);
        else if (node.level > 0) expect(node.x).toBeGreaterThanOrEqual(layout.axis.fromX);
    }
}

function expectInvariants(graph, layout) {
    expect(layout.depth.fit, 'footprints fit the plane depth').toBeGreaterThanOrEqual(1 - 1e-9);
    expect(overlaps(layout), 'node overlaps').toBe(0);
    expect(bandIntrusions(layout), 'band intrusions').toBe(0);
    for (const level of [0, 1, 2]) {
        expect(hullIntrusions(layout, level), `hull intrusions on plane ${level}`).toBe(0);
        expect(nodeOverlaps(layout, level)).toBe(0);
    }
    expect(crossings(layout), 'same-plane crossings').toBe(0);
    expect(samePlaneCrossings(layout)).toBe(0);
    expectConserved(graph, layout);
    expectLanes(graph, layout);
}

// ---------------------------------------------------------------------------------------------

describe('strata layout properties over generated discographies', () => {
    it('holds every invariant on the default view (1,000 discographies)', () => {
        const seen = { lanes: 0, undated: 0, folded: 0, edges: 0, unbudgeted: 0, wholeBands: 0, otherCredits: 0 };
        forAll(1000, 1, (r) => {
            const { budget, payload, graph, edges } = generateCase(r);
            const releases = graph.entries.filter((entry) => entry.level === 2);
            const selected = releases.length && r.chance(0.5) ? r.pick(releases).id : null;
            const layout = layoutStrata(graph, { edges, selected });
            expectInvariants(graph, layout);
            seen.lanes += layout.nodes.some((node) => node.lane) ? 1 : 0;
            seen.undated += layout.nodes.some((node) => node.undated) ? 1 : 0;
            seen.folded += layout.nodes.some((node) => node.origin === 'fold') ? 1 : 0;
            seen.edges += layout.edges.length;
            seen.unbudgeted += budget ? 0 : 1;
            seen.wholeBands += payload.planes[1].aggregates.some((agg) => agg.kind === 'band') ? 1 : 0;
            seen.otherCredits += layout.nodes.some((node) => node.id === 'fold:credits') ? 1 : 0;
        });
        // The properties are not vacuous: the generator reaches every shape they speak about.
        for (const [shape, count] of Object.entries(seen)) expect(count, shape).toBeGreaterThan(0);
    });

    it('conserves every entry across every page of a drill-down (300 discographies)', () => {
        let paged = 0;
        forAll(300, 10_001, (r) => {
            const { graph, edges } = generateCase(r);
            const counts = new Map();
            for (const entry of graph.entries) if (entry.parent) counts.set(entry.parent, (counts.get(entry.parent) || 0) + 1);
            const targets = graph.entries.filter((entry) => entry.level < 2 && (counts.get(entry.id) || 0) > 1);
            for (const target of [...new Set([r.pick(targets), r.pick(targets), r.pick(targets)])].filter(Boolean)) {
                const max = target.level === 0 ? MAX_MASTERS_PAGE : MAX_PRESSINGS_PAGE;
                for (const per of [undefined, max, r.int(1, 20)]) {
                    const first = layoutStrata(graph, { edges, focus: { id: target.id, per } });
                    if (!first.page) continue;
                    expect(first.page.per).toBe(Math.min(max, Math.max(1, per ?? PAGE_SIZE)));
                    const shownOnce = new Map();
                    for (let page = 0; page < first.page.pages; page++) {
                        const layout = layoutStrata(graph, { edges, focus: { id: target.id, page, per } });
                        expect(layout.page.index).toBe(page);
                        expect(layout.page.shown.length).toBeLessThanOrEqual(layout.page.per);
                        expectInvariants(graph, layout);
                        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
                        for (const id of layout.page.shown) {
                            expect(byId.get(id).members, `${id} drawn on its page`).toEqual([id]);
                            shownOnce.set(id, (shownOnce.get(id) || 0) + 1);
                        }
                        paged++;
                    }
                    // The pages partition the focused entries: each is shown on exactly one page.
                    expect(shownOnce.size).toBe(first.page.size);
                    for (const count of shownOnce.values()) expect(count).toBe(1);
                    const wrapped = layoutStrata(graph, { edges, focus: { id: target.id, page: first.page.pages, per } });
                    expect(wrapped.page.shown).toEqual(first.page.shown);
                    const back = layoutStrata(graph, { edges, focus: { id: target.id, page: -1, per } });
                    expect(back.page.index).toBe(first.page.pages - 1);
                }
            }
        });
        expect(paged).toBeGreaterThan(1000);
    });

    it('is deterministic and never writes to its input (100 discographies)', () => {
        forAll(100, 20_001, (r) => {
            const { graph, edges } = generateCase(r);
            const once = layoutStrata(graph, { edges });
            expect(layoutStrata(graph, { edges })).toEqual(once);
            expect(Object.isFrozen(graph.entries)).toBe(true);
        });
    });
});

// ---------------------------------------------------------------------------------------------

// gm-design-1h2l's example payload, with the masters it trims restored.
const EXAMPLE = {
    root: { type: 'artist', id: 1, name: 'xxxxxxxxxx' },
    budget: { credits: 5, masters: 5, releases: 5 },
    totals: { credits: 2, masters: 4, releases: 8, masterless_releases: 1, releases_only_in_master_aggregates: 0 },
    planes: [
        {
            level: 0,
            kind: 'credit',
            nodes: [
                { id: 'c:1', artists: [{ id: 1, name: 'xxxxxxxxxx' }], releases: 7 },
                { id: 'c:1+2', artists: [{ id: 1, name: 'xxxxxxxxxx' }, { id: 2, name: 'xxxxxxxxxxxxx' }], releases: 1 },
            ],
            aggregates: [],
        },
        {
            level: 1,
            kind: 'master',
            nodes: [
                { id: 'm:501', parent: 'c:1+2', title: 'xxxxxxxxxxx', year: 1971, releases: 4, y0: 1971, y1: 2016, state: 'owned' },
                { id: 'm:502', parent: 'c:1', title: 'xxxxx', year: null, releases: 1, y0: null, y1: null, state: 'none' },
            ],
            aggregates: [
                { id: 'nm:c:1', parent: 'c:1', kind: 'no_master', masters: 0, releases: 1, y0: null, y1: null, states: { none: 1 } },
                { id: 'ma:c:1:1980s', parent: 'c:1', kind: 'masters', masters: 2, releases: 2, y0: 1982, y1: 1989, decade: '1980s', states: { none: 2 } },
            ],
        },
        {
            level: 2,
            kind: 'release',
            nodes: [{ id: 'r:9', parent: 'm:502', title: 'xxxx', year: null, state: 'none', recorded_at: null }],
            aggregates: [
                { id: 'ra:m:501', parent: 'm:501', releases: 4, y0: 1971, y1: 2016, states: { owned: 1, wanted: 1, none: 2 } },
                { id: 'ra:nm:c:1:unknown', parent: 'nm:c:1', releases: 1, y0: null, y1: null, states: { none: 1 } },
            ],
        },
    ],
};

describe('adaptStrataPayload', () => {
    it("reads gm-design-1h2l's example payload", () => {
        const graph = adaptStrataPayload(EXAMPLE);
        expect(graph.rootCredit).toBe('c:1');
        expect(graph.totals.releases).toBe(8);
        const byId = new Map(graph.entries.map((entry) => [entry.id, entry]));
        expect(byId.get('c:1+2')).toMatchObject({ level: 0, kind: 'credit', parent: null, label: 'xxxxxxxxxx, xxxxxxxxxxxxx', credits: 1 });
        expect(byId.get('m:501')).toMatchObject({ year: 1971, releases: 4, masters: 1, state: 'owned', undated: false });
        expect(byId.get('m:502')).toMatchObject({ undated: true });
        expect(byId.get('nm:c:1')).toMatchObject({ agg: true, aggKind: 'no_master', lane: 'nomaster', undated: false, masters: 0 });
        expect(byId.get('ma:c:1:1980s')).toMatchObject({ aggKind: 'masters', masters: 2, y0: 1982, y1: 1989 });
        expect(byId.get('r:9')).toMatchObject({ releases: 1, undated: true, y0: null });
        expect(byId.get('ra:m:501')).toMatchObject({ aggKind: 'releases', states: { owned: 1, wanted: 1, none: 2 } });
        expect(Object.isFrozen(byId.get('r:9'))).toBe(true);
    });

    it('lays the example out with both lanes and the payload cursors', () => {
        const layout = layoutStrata(adaptStrataPayload(EXAMPLE));
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        expect(layout.nodes.map((node) => node.level)).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 2]);
        expect(byId.get('nm:c:1')).toMatchObject({ lane: 'nomaster', undated: true, x: UNDATED_X });
        expect(byId.get('m:502')).toMatchObject({ undated: true, x: UNDATED_X });
        expect(byId.get('m:501').x).toBeCloseTo(yearToX(layout.axis, 1971));
        expect(byId.get('ra:m:501')).toMatchObject({ cursor: 'ra:m:501', origin: 'payload', states: { owned: 1, wanted: 1, none: 2 } });
        expect(byId.get('c:1+2').x).toBeCloseTo(yearToX(layout.axis, 1971));
        expect(layout.depth.fit).toBeGreaterThan(1);
        expect(layout.page).toBeNull();
        expectInvariants(adaptStrataPayload(EXAMPLE), layout);
    });

    it('accepts an anonymous payload with empty planes and no aggregate lists', () => {
        const graph = adaptStrataPayload({ planes: [{ level: 2 }, { level: 1, nodes: [] }, { level: 0, nodes: [{ id: 'c:1' }] }] });
        expect(graph).toMatchObject({ root: null, budget: null, totals: null, rootCredit: 'c:1' });
        const layout = layoutStrata(graph);
        expect(layout.nodes).toHaveLength(1);
        expect(layout.nodes[0]).toMatchObject({ x: UNDATED_X, label: null, states: null });
        expect(layoutStrata(adaptStrataPayload({ planes: [{ level: 0 }, { level: 1 }, { level: 2 }] }))).toMatchObject({ nodes: [], rootCredit: null });
    });

    it('reads a one-sided span, drops non-numeric state counts, and places a lane by its span', () => {
        const graph = adaptStrataPayload({
            planes: [
                { level: 0, nodes: [{ id: 'c:1' }] },
                { level: 1, aggregates: [{ id: 'nm:c:1', parent: 'c:1', kind: 'no_master', releases: 3, y0: 1990, states: { none: 3, owned: 'x' } }] },
                { level: 2 },
            ],
        });
        expect(graph.entries[1]).toMatchObject({ y0: 1990, y1: 1990, states: { none: 3 } });
        const layout = layoutStrata(graph, { edges: null });
        expect(layout.nodes[1]).toMatchObject({ lane: 'nomaster', undated: false });
        expect(layout.nodes[1].x).toBeCloseTo(yearToX(layout.axis, 1990));
        expect(layout.edges).toEqual([]);
    });

    const plane = (level, nodes, aggregates = []) => ({ level, nodes, aggregates });
    const payloadWith = (credits, masters = [], releases = [], masterAggs = []) => ({
        planes: [plane(0, credits), plane(1, masters, masterAggs), plane(2, releases)],
    });
    const credit = { id: 'c:1' };
    it.each([
        ['a missing payload', null, /planes array/],
        ['a missing plane', { planes: [plane(0, []), plane(1, [])] }, /plane 2 is missing/],
        ['a plane of the wrong kind', { planes: [{ level: 0, kind: 'master' }, plane(1, []), plane(2, [])] }, /not the credit plane/],
        ['a non-array entry list', { planes: [{ level: 0, nodes: {} }, plane(1, []), plane(2, [])] }, /non-array/],
        ['a non-object entry', payloadWith([7]), /non-object/],
        ['an entry without an id', payloadWith([{ id: '' }]), /without a string id/],
        ['a reserved id', payloadWith([{ id: 'fold:credits' }]), /reserves/],
        ['a credit with a parent', payloadWith([{ id: 'c:1', parent: 'c:0' }]), /names a parent/],
        ['an entry with no parent', payloadWith([credit], [{ id: 'm:1', year: 1990 }]), /names no parent/],
        ['a duplicate id', payloadWith([credit, credit]), /duplicate id c:1/],
        ['an unknown parent', payloadWith([credit], [{ id: 'm:1', parent: 'c:9' }]), /not on the plane above/],
        ['a parent two planes up', payloadWith([credit], [], [{ id: 'r:1', parent: 'c:1' }]), /not on the plane above/],
        ['an unknown aggregate kind', payloadWith([credit], [], [], [{ id: 'x:1', parent: 'c:1', kind: 'decade' }]), /unknown aggregate kind/],
        ['a non-numeric year', payloadWith([credit], [{ id: 'm:1', parent: 'c:1', year: '1990' }]), /non-numeric year/],
        ['a negative count', payloadWith([credit], [{ id: 'm:1', parent: 'c:1', releases: -1 }]), /invalid releases count/],
    ])('rejects %s', (_, payload, message) => {
        expect(() => adaptStrataPayload(payload)).toThrow(message);
    });
});

describe('layoutStrata', () => {
    it('is pure: no DOM, no three.js, and no imports', () => {
        const source = readFileSync(SOURCE, 'utf8');
        expect(source).not.toMatch(/^\s*import\s/m);
        expect(source).not.toMatch(/\bimport\(|\brequire\(/);
        expect(source).not.toMatch(/\b(document|window|navigator|globalThis|requestAnimationFrame|HTMLElement|THREE)\b/);
    });

    it('keeps the hull clear of the next credit band by construction', () => {
        // A node sits size + 0.3 inside its band; its hull reaches size + HULL_PAD past it.
        for (const size of PLANE_SIZES) expect(GROUP_GUTTER + size + 0.3).toBeGreaterThan(HULL_PAD - 0.3);
        // An undated disc and a dated disc never touch, at any depth.
        const layout = layoutStrata(adaptStrataPayload(EXAMPLE));
        expect(layout.axis.fromX - UNDATED_X).toBeGreaterThan(2 * PLANE_SIZES[1]);
    });

    // One credit holding 30 masters of 30 pressings each, every entry a node: far past what the
    // plane can draw, so the footprint check folds it.
    function largeDiscography({ credits = 1, signedIn = false } = {}) {
        const releases = [];
        const masters = new Map();
        let id = 1;
        for (let c = 0; c < credits; c++) {
            for (let m = 0; m < 30; m++) {
                const mid = 1000 * (c + 1) + m;
                masters.set(mid, { id: mid, year: m % 7 === 0 ? null : 1960 + m });
                for (let k = 0; k < 30; k++) {
                    releases.push({ id: id++, masterId: mid, isMain: k === 0, year: k % 5 === 0 ? null : 1960 + m + k, credit: c ? [1, c + 1] : [1], state: k === 3 ? 'owned' : 'none' });
                }
                releases.push({ id: id++, masterId: null, isMain: false, year: m % 2 ? null : 1990, credit: c ? [1, c + 1] : [1], state: 'none' });
            }
        }
        return adaptStrataPayload(buildPayload({ rootId: 1, releases, masters }, null, { signedIn }));
    }

    it('folds an unbudgeted discography until it fits, pressings without state first', () => {
        const graph = largeDiscography({ signedIn: true });
        const layout = layoutStrata(graph);
        expectInvariants(graph, layout);
        const folds = layout.nodes.filter((node) => node.origin === 'fold');
        expect(folds.length).toBeGreaterThan(0);
        for (const fold of folds) {
            expect(fold.cursor).toBeNull();
            expect(fold.pageOf).toBe(fold.parent);
            expect(fold.agg).toBe(true);
        }
        // Folded pressings keep their collector state as counts.
        const owned = layout.nodes.filter((node) => node.level === 2).reduce((sum, node) => sum + ((node.states && node.states.owned) || 0) + (node.state === 'owned' ? 1 : 0), 0);
        const masterOwned = layout.nodes.filter((node) => node.level === 1 && !node.children.length).reduce((sum, node) => sum + ((node.states && node.states.owned) || 0), 0);
        expect(owned + masterOwned).toBe(30);
    });

    it('folds the credits other than the root last, merging their no-master lanes', () => {
        const graph = largeDiscography({ credits: 9 });
        const layout = layoutStrata(graph);
        expectInvariants(graph, layout);
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        expect(layout.nodes.filter((node) => node.level === 0).map((node) => node.id)).toEqual(['c:1', 'fold:credits']);
        expect(byId.get('fold:credits')).toMatchObject({ agg: true, aggKind: 'credits', credits: 8, origin: 'fold', cursor: null });
        expect(byId.get('fold:credits:nm')).toMatchObject({ lane: 'nomaster', parent: 'fold:credits' });
        expect(byId.get('fold:credits:nm').members).toHaveLength(8);
    });

    it('pages a master and pins the page while folding everything else', () => {
        const graph = largeDiscography({ credits: 3 });
        const target = 'm:2000';
        const layout = layoutStrata(graph, { focus: { id: target, page: 1 } });
        expectInvariants(graph, layout);
        expect(layout.page).toMatchObject({ parent: target, index: 1, pages: 4, per: PAGE_SIZE, size: 30 });
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        for (const id of layout.page.shown) expect(byId.get(id).parent).toBe(target);
        const more = layout.nodes.filter((node) => node.origin === 'page');
        expect(more.map((node) => node.id).sort()).toEqual([`page:${target}:d`, `page:${target}:u`]);
        expect(more.reduce((sum, node) => sum + node.releases, 0)).toBe(30 - PAGE_SIZE);
        expect(byId.get(`page:${target}:u`)).toMatchObject({ undated: true, x: UNDATED_X, pageOf: target });
        expect(layout.nodes.some((node) => node.id === 'fold:credits')).toBe(false);
    });

    it('pages a credit eight masters at a time, leaving its lane in place', () => {
        const graph = largeDiscography({ credits: 2 });
        const layout = layoutStrata(graph, { focus: { id: 'c:1+2', per: 50 } });
        expectInvariants(graph, layout);
        expect(layout.page).toMatchObject({ parent: 'c:1+2', per: MAX_MASTERS_PAGE, size: 30, pages: 4 });
        const credit = layout.nodes.find((node) => node.id === 'c:1+2');
        expect(credit.children).toContain('nm:c:1+2');
    });

    it('ignores a focus it cannot page', () => {
        const graph = adaptStrataPayload(EXAMPLE);
        const plain = layoutStrata(graph);
        expect(layoutStrata(graph, { focus: { id: 'nope' } })).toEqual(plain);
        expect(layoutStrata(graph, { focus: { id: 'r:9' } }).page).toBeNull();
        expect(layoutStrata(graph, { focus: { id: 'ma:c:1:1980s' } }).page).toBeNull();
        const onlyLane = layoutStrata(adaptStrataPayload({
            planes: [
                { level: 0, nodes: [{ id: 'c:1' }] },
                { level: 1, aggregates: [{ id: 'nm:c:1', parent: 'c:1', kind: 'no_master', releases: 0 }] },
                { level: 2 },
            ],
        }), { focus: { id: 'c:1' } });
        expect(onlyLane.page).toBeNull();
        expect(onlyLane.nodes[1]).toMatchObject({ lane: 'nomaster', x: UNDATED_X });
        const odd = layoutStrata(graph, { focus: { id: 'c:1', page: Number.NaN, per: 0 } });
        expect(odd.page).toMatchObject({ index: 0, per: 1 });
    });

    it('draws only the planar subset of lateral edges', () => {
        const masters = Array.from({ length: 5 }, (_, i) => ({ id: `m:${i}`, parent: 'c:1', year: 1970 + i, releases: 1 }));
        const releases = masters.map((master, i) => ({ id: `r:${i}`, parent: master.id, year: 1970 + i }));
        const graph = adaptStrataPayload({
            planes: [
                { level: 0, nodes: [{ id: 'c:1' }, { id: 'c:1+2' }, { id: 'c:1+3' }] },
                { level: 1, nodes: masters },
                { level: 2, nodes: releases, aggregates: [{ id: 'ra:x', parent: 'm:0', releases: 0 }] },
            ],
        });
        const edges = [
            { a: 'c:1', b: 'c:1+2', kind: 'member' },
            { a: 'c:1+3', b: 'c:1', kind: 'collab' },
            { a: 'c:1+2', b: 'c:1+3', kind: 'collab' },
            { a: 'm:0', b: 'm:1', kind: 'personnel' },
            { a: 'm:1', b: 'm:0', kind: 'personnel' },
            { a: 'm:0', b: 'm:3', kind: 'personnel' },
            { a: 'r:0', b: 'r:4', kind: 'company' },
            { a: 'r:1', b: 'r:2', kind: 'company' },
            { a: 'm:0', b: 'r:0', kind: 'personnel' },
            { a: 'r:0', b: 'ra:x', kind: 'company' },
            { a: 'm:2', b: 'm:2', kind: 'personnel' },
            { a: 'm:2', b: 'm:3', kind: 'shared' },
            { a: 'c:1', b: 'missing', kind: 'member' },
            null,
        ];
        expect(layoutStrata(graph, { edges }).edges).toEqual([
            { a: 'c:1', b: 'c:1+2', kind: 'member' },
            { a: 'c:1+3', b: 'c:1', kind: 'collab' },
            { a: 'm:0', b: 'm:1', kind: 'personnel' },
        ]);
        const selected = layoutStrata(graph, { edges, selected: 'r:4' });
        expect(selected.edges).toContainEqual({ a: 'r:0', b: 'r:4', kind: 'company' });
        expect(selected.edges).not.toContainEqual({ a: 'r:1', b: 'r:2', kind: 'company' });
    });

    it('keeps a requested year axis and widens it to hold the view', () => {
        const graph = adaptStrataPayload(EXAMPLE);
        expect(layoutStrata(graph, { axis: { y0: 1900, y1: 2100 } }).axis).toMatchObject({ y0: 1900, y1: 2100 });
        expect(layoutStrata(graph, { axis: { y0: 1980, y1: 2000 } }).axis).toMatchObject({ y0: 1969, y1: 2017 });
        expect(layoutStrata(graph, { axis: { y0: 2000, y1: 1990 } }).axis).toMatchObject({ y0: 1953, y1: 2027 });
    });
});

describe('ported geometry', () => {
    it('behaves as the mockup', () => {
        expect(hull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]])).toHaveLength(4);
        expect(hull([[0, 0], [1, 1]])).toHaveLength(2);
        expect(inPoly([1, 1], [[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(true);
        expect(inPoly([3, 1], [[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(false);
        expect(segmentsCross([0, 0, 2, 2], [0, 2, 2, 0])).toBe(true);
        expect(segmentsCross([0, 0, 1, 0], [2, 0, 3, 0])).toBe(false);
        expect(segmentsCross([0, 0, 2, 0], [1, 0, 3, 0])).toBe(true);
        expect(segmentsCross([1, 0, 3, 0], [0, 0, 2, 0])).toBe(true);
        expect(segmentsCross([0, 0, 3, 0], [1, 0, 2, 0])).toBe(true);
        expect(segmentsCross([1, 0, 2, 0], [0, 0, 3, 0])).toBe(true);
        expect(segmentsCross([0, 0, 0, 2], [1, 0, 1, 2])).toBe(false);
    });

    it('stops ribbons short of the discs and skips discs too close for one', () => {
        expect(edgeSegment({ x: 0, z: 0, size: 1 }, { x: 10, z: 0, size: 1 })).toEqual([1.1, 0, 8.75, 0]);
        expect(edgeSegment({ x: 0, z: 0, size: 1 }, { x: 2, z: 0, size: 1 })).toBeNull();
        expect(edgeSegment({ x: 0, z: 0, size: 1 }, { x: 0, z: 0, size: 1 })).toBeNull();
    });

    it('counts intrusions, overlaps, and crossings when they exist', () => {
        const node = (id, group, x, z, level = 1) => ({ id, group, x, z, level, size: PLANE_SIZES[level] });
        const layout = {
            nodes: [node('a', 'A', 0, 0), node('b', 'A', 10, 10), node('c', 'B', 5, 5), node('d', 'B', 0, 10), node('e', 'A', 10, 0)],
            edges: [{ a: 'a', b: 'b', kind: 'personnel' }, { a: 'd', b: 'e', kind: 'personnel' }],
        };
        expect(hullPolygons(layout, 1).map((entry) => entry.group)).toEqual(['A', 'B']);
        expect(hullIntrusions(layout, 1)).toBeGreaterThan(0);
        expect(nodeOverlaps({ nodes: [node('a', 'A', 0, 0), node('b', 'A', 1, 0)] }, 1)).toBe(1);
        expect(samePlaneCrossings(layout)).toBe(1);
        expect(crossings(layout)).toBe(1);
    });
});
