// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
    GROUP_GUTTER,
    HULL_PAD,
    PLANE_SIZES,
    UNDATED_X,
    adaptStrataPayload,
    decadeOf,
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
import { ROUTE_PAGE_SIZE, buildPayload, cursorsOf, deepFreeze, generateDiscography, generateEdges, rng, validBudget } from './strata-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '..', 'static', 'js', 'strata-layout.js');
const RECORDED = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'strata-route.json'), 'utf8'));
const recorded = (focus, page = 0, signedIn = true) =>
    RECORDED.responses.find((entry) => entry.query.focus === focus && entry.query.page === page && entry.query.signed_in === signedIn).body;

// Budgets as `credits/masters/releases`, all of which the route accepts. 3/12/16 is the route's
// default, so it is drawn most often; 12/500/500 is past what the plane can draw, so the footprint
// check folds it.
const BUDGETS = [[3, 12, 16], [3, 12, 16], [3, 12, 16], [6, 12, 16], [6, 12, 25], [12, 24, 32], [4, 8, 12], [3, 6, 4], [12, 500, 500]];
// Discography sizes in releases, log-uniform from 1 to the cap.
const SIZES = [20, 200, 2000];

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
    const catalog = generateDiscography(r, { maxReleases: r.pick(SIZES) });
    const budget = r.pick(BUDGETS);
    const signedIn = r.chance(0.5);
    const payload = deepFreeze(buildPayload(catalog, budget, { signedIn, r }));
    const edges = deepFreeze([...adaptStrataPayload(payload).edges, ...generateEdges(r, payload)]);
    return { catalog, budget, signedIn, payload, edges, graph: adaptStrataPayload(payload) };
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

/**
 * The route's conservation, end to end: every release of the root is drawn, held by a release-plane
 * aggregate, held by a master bucket (whose releases are not drawn below), or held by `c:other`;
 * every master is drawn or held by a master aggregate or `c:other`; every credit is drawn or held
 * by `c:other`.
 */
function expectRouteConserved(graph) {
    const { totals } = graph;
    const on = (level) => graph.entries.filter((entry) => entry.level === level);
    const sum = (list, field) => list.reduce((total, item) => total + item[field], 0);
    const other = on(0).filter((entry) => entry.agg);
    const buckets = on(1).filter((entry) => entry.aggKind === 'masters');
    expect(sum(on(0), 'releases'), 'credit plane holds every release').toBe(totals.releases);
    expect(sum(on(2), 'releases') + sum(buckets, 'releases') + sum(other, 'releases'), 'every release placed once').toBe(totals.releases);
    expect(sum(on(1), 'masters') + sum(other, 'masters'), 'every master placed once').toBe(totals.masters);
    expect(sum(on(0), 'masters'), 'credit plane holds every master').toBe(totals.masters);
    expect(sum(on(0), 'credits')).toBe(totals.credits);
    expect(sum(on(0), 'undatedReleases')).toBe(totals.undatedReleases);
    expect(sum(on(0), 'musicbrainzReleases')).toBe(totals.musicbrainzReleases);
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
    expectRouteConserved(graph);
    expectLanes(graph, layout);
}

// ---------------------------------------------------------------------------------------------

describe('strata layout properties over route-shaped payloads', () => {
    it('only draws budgets the route accepts', () => {
        for (const budget of BUDGETS) expect(validBudget(budget), budget.join('/')).toBe(true);
    });

    it('holds every invariant on the default view (1,000 discographies)', () => {
        const seen = { lanes: 0, undated: 0, folded: 0, edges: 0, musicbrainz: 0, otherCredits: 0, foldCredits: 0, signedIn: 0 };
        forAll(1000, 1, (r) => {
            const { payload, graph, edges, signedIn } = generateCase(r);
            const releases = graph.entries.filter((entry) => entry.level === 2);
            const selected = releases.length && r.chance(0.5) ? r.pick(releases).id : null;
            const layout = layoutStrata(graph, { edges, selected });
            expectInvariants(graph, layout);
            expect(layout.page).toBeNull();
            seen.lanes += layout.nodes.some((node) => node.lane) ? 1 : 0;
            seen.undated += layout.nodes.some((node) => node.undated) ? 1 : 0;
            seen.folded += layout.nodes.some((node) => node.origin === 'fold') ? 1 : 0;
            seen.edges += layout.edges.length;
            seen.musicbrainz += layout.nodes.some((node) => node.provider === 'musicbrainz') ? 1 : 0;
            seen.otherCredits += payload.planes[0].aggregates.length ? 1 : 0;
            seen.foldCredits += layout.nodes.some((node) => node.id === 'fold:credits') ? 1 : 0;
            seen.signedIn += signedIn ? 1 : 0;
        });
        // The properties are not vacuous: the generator reaches every shape they speak about.
        for (const [shape, count] of Object.entries(seen)) expect(count, shape).toBeGreaterThan(0);
    });

    it("conserves every entry across every server page of a cursor, and the pages partition its members (300 discographies)", () => {
        let paged = 0;
        const levels = new Set();
        forAll(300, 10_001, (r) => {
            const { catalog, budget, signedIn, payload } = generateCase(r);
            const cursors = cursorsOf(payload);
            for (const cursor of [...new Set([r.pick(cursors), r.pick(cursors), r.pick(cursors)])].filter(Boolean)) {
                const first = adaptStrataPayload(buildPayload(catalog, budget, { focus: cursor, signedIn }));
                const { pages, members, level, id } = first.focus;
                const shownOnce = new Map();
                for (let page = 0; page < pages; page++) {
                    const graph = adaptStrataPayload(deepFreeze(buildPayload(catalog, budget, { focus: cursor, page, signedIn })));
                    const layout = layoutStrata(graph);
                    expectInvariants(graph, layout);
                    expect(layout.page).toMatchObject({ cursor: id, level, index: page, pages, size: members });
                    expect(layout.page.per).toBeLessThanOrEqual(ROUTE_PAGE_SIZE);
                    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
                    for (const shownId of layout.page.shown) {
                        expect(byId.get(shownId).members, `${shownId} drawn on its page`).toEqual([shownId]);
                        shownOnce.set(shownId, (shownOnce.get(shownId) || 0) + 1);
                    }
                    // The rest of the cursor's members stay in one aggregate under the cursor's id.
                    const remainder = graph.entries.find((entry) => entry.id === id);
                    if (pages > 1) expect(remainder, `${id} holds the rest`).toBeTruthy();
                    paged++;
                }
                levels.add(level);
                // A page of credits may fold when the credit plane cannot hold it whole; a page of
                // masters or releases is always drawn. Either way nothing is lost (expectConserved).
                if (level > 0) {
                    expect(shownOnce.size, `${id}: every member shown once`).toBe(members);
                    for (const count of shownOnce.values()) expect(count).toBe(1);
                }
            }
        });
        expect(paged).toBeGreaterThan(1000);
        expect([...levels].sort()).toEqual([0, 1, 2]);
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

describe('adaptStrataPayload over recorded route bodies', () => {
    it('reads the signed-in default view', () => {
        const body = recorded(null);
        const graph = adaptStrataPayload(body);
        const byId = new Map(graph.entries.map((entry) => [entry.id, entry]));
        expect(graph).toMatchObject({ rootCredit: 'c:9001', signedIn: true, focus: null, budget: { credits: 3, masters: 12, releases: 16 } });
        expect(graph.totals).toEqual({ credits: 6, masters: 40, releases: 169, masterlessReleases: 26, undatedReleases: 9, musicbrainzReleases: 13 });
        expect(byId.get('c:9001+9004+9005')).toMatchObject({ level: 0, label: 'The Placeholder Band, Remixer One, Remixer Two', state: 'owned' });
        expect(byId.get('c:9001+9004+9005').artists.map((artist) => artist.id)).toEqual(['9001', '9004', '9005']);
        expect(byId.get('c:other')).toMatchObject({ agg: true, aggKind: 'credits', credits: 4, releases: 30 });
        // The wire's wanted_owned is strata-collector.js's wanted-owned, in states as in state.
        expect(byId.get('c:9001').states).toMatchObject({ 'wanted-owned': 5, owned: 10, wanted: 4 });
        expect(graph.entries.some((entry) => entry.state === 'wanted_owned' || Object.hasOwn(entry.states || {}, 'wanted_owned'))).toBe(false);
        expect(byId.get('nm:c:9001')).toMatchObject({ aggKind: 'no_master', lane: 'nomaster', decade: null, undatedReleases: 5 });
        expect(byId.get('ma:c:9001:1990s')).toMatchObject({ aggKind: 'masters', decade: '1990s', masters: 8 });
        const master = graph.entries.find((entry) => entry.level === 1 && !entry.agg);
        expect(master).toMatchObject({ masterId: master.id.slice(2), masters: 1 });
        const release = byId.get('r:300101');
        expect(release).toMatchObject({ provider: 'discogs', releaseId: '300101', yearSource: 'release', state: 'owned', recordedAt: { owned: '2026-05-26T12:00:00Z', wanted: null } });
        for (const edge of graph.edges) expect(edge).toMatchObject({ kind: 'personnel', categories: expect.any(Array) });
        expect(graph.edges.length).toBe(body.planes[1].edges.length);
    });

    it('carries MusicBrainz-only releases as state-less, with their provider', () => {
        const bodies = RECORDED.responses.map((entry) => entry.body);
        const musicbrainz = bodies.flatMap((body) => adaptStrataPayload(body).entries.filter((entry) => entry.provider === 'musicbrainz'));
        expect(musicbrainz.length).toBeGreaterThan(0);
        for (const entry of musicbrainz) {
            expect(entry.id.startsWith('mb:')).toBe(true);
            expect(entry.state).toBeNull();
            expect(entry.musicbrainzReleases).toBe(1);
        }
        const layout = layoutStrata(adaptStrataPayload(bodies.find((body) => body.planes[2].nodes.some((node) => node.provider === 'musicbrainz'))));
        const drawn = layout.nodes.filter((node) => node.provider === 'musicbrainz');
        expect(drawn.length).toBeGreaterThan(0);
        for (const node of drawn) expect(node).toMatchObject({ state: null, states: null });
    });

    it('reads an anonymous view with no collector field', () => {
        const graph = adaptStrataPayload(recorded(null, 0, false));
        expect(graph.signedIn).toBe(false);
        for (const entry of graph.entries) expect([entry.state, entry.states, entry.recordedAt]).toEqual([null, null, null]);
    });

    it('reads a focused page, and lays out every recorded response within its invariants', () => {
        const graph = adaptStrataPayload(recorded('ra:m:70030', 1));
        expect(graph.focus).toEqual({ id: 'ra:m:70030', level: 2, page: 1, pages: 2, pageSize: 8, members: 15 });
        const layout = layoutStrata(graph);
        expect(layout.page).toMatchObject({ cursor: 'ra:m:70030', index: 1, pages: 2, per: 8, size: 15, parent: 'm:70030' });
        expect(layout.page.shown).toHaveLength(7);
        for (const { body } of RECORDED.responses) {
            const recordedGraph = adaptStrataPayload(body);
            expectInvariants(recordedGraph, layoutStrata(recordedGraph));
        }
    });

    it('finds each kind of page: masters by decade, a lane by decade, and other credits', () => {
        const decadePage = layoutStrata(adaptStrataPayload(recorded('ma:c:9001:1990s', 1)));
        const byId = new Map(decadePage.nodes.map((node) => [node.id, node]));
        expect(decadePage.page.shown).toHaveLength(1);
        for (const id of decadePage.page.shown) expect(decadeOf(byId.get(id).year)).toBe('1990s');
        const lane = layoutStrata(adaptStrataPayload(recorded('ra:nm:c:9001', 0)));
        expect(lane.page).toMatchObject({ parent: 'nm:c:9001', per: 8 });
        expect(lane.page.shown).toHaveLength(8);
        const credits = layoutStrata(adaptStrataPayload(recorded('c:other', 2)));
        expect(credits.page).toMatchObject({ level: 0, index: 2, size: 5, parent: null });
        expect(credits.page.shown).toHaveLength(1);
        expect(credits.nodes.filter((node) => node.level === 0).map((node) => node.id)).toContain('c:other');
    });
});

// A small route-shaped payload, written out by hand.
const EXAMPLE = {
    root: { type: 'artist', id: '1', name: 'xxxxxxxxxx' },
    budget: { credits: 3, masters: 12, releases: 16 },
    focus: null,
    signed_in: true,
    totals: { credits: 2, masters: 4, releases: 9, masterless_releases: 1, undated_releases: 2, musicbrainz_releases: 1 },
    planes: [
        {
            level: 0,
            kind: 'credit',
            nodes: [
                { id: 'c:1', artists: [{ id: '1', name: 'xxxxxxxxxx' }], masters: 3, masterless: 1, releases: 5, undated_releases: 2, musicbrainz_releases: 0, y0: 1982, y1: 1989, states: { none: 5 }, state: 'none' },
                { id: 'c:1+2', artists: [{ id: '1', name: 'xxxxxxxxxx' }, { id: '2', name: 'xxxxxxxxxxxxx' }], masters: 1, masterless: 0, releases: 4, undated_releases: 0, musicbrainz_releases: 1, y0: 1971, y1: 2016, states: { owned: 1, wanted_owned: 1, none: 1 }, state: 'owned' },
            ],
            aggregates: [],
        },
        {
            level: 1,
            kind: 'master',
            nodes: [
                { id: 'm:501', parent: 'c:1+2', master_id: '501', title: 'xxxxxxxxxxx', year: 1971, year_source: 'master', undated: false, releases: 4, undated_releases: 0, musicbrainz_releases: 1, y0: 1971, y1: 2016, states: { owned: 1, wanted_owned: 1, none: 1 }, state: 'owned' },
                { id: 'm:502', parent: 'c:1', master_id: '502', title: 'xxxxx', year: null, year_source: null, undated: true, releases: 1, undated_releases: 1, musicbrainz_releases: 0, y0: null, y1: null, states: { none: 1 }, state: 'none' },
            ],
            aggregates: [
                { id: 'nm:c:1', parent: 'c:1', kind: 'no_master', decade: null, masters: 0, releases: 1, undated_releases: 1, musicbrainz_releases: 0, y0: null, y1: null, states: { none: 1 } },
                { id: 'ma:c:1:1980s', parent: 'c:1', kind: 'masters', decade: '1980s', masters: 2, releases: 3, undated_releases: 0, musicbrainz_releases: 0, y0: 1982, y1: 1989, states: { none: 3 } },
            ],
            edges: [{ source: 'm:501', target: 'm:502', kind: 'shared_personnel', categories: ['Production'], people: 1 }],
        },
        {
            level: 2,
            kind: 'release',
            nodes: [
                { id: 'r:9', parent: 'm:502', provider: 'discogs', release_id: '9', title: 'xxxx', year: null, year_source: null, undated: true, state: 'none', recorded_at: { owned: null, wanted: null } },
                { id: 'r:10', parent: 'm:501', provider: 'discogs', release_id: '10', title: 'xxxx', year: 1971, year_source: 'release', undated: false, state: 'wanted_owned', recorded_at: { owned: '2019-04-01T00:00:00Z', wanted: '2015-01-01T00:00:00Z' } },
                { id: 'mb:0f9e', parent: 'm:501', provider: 'musicbrainz', release_id: '0f9e', title: 'xxxx', year: 1972, year_source: 'release', undated: false, state: null, recorded_at: null },
            ],
            aggregates: [
                { id: 'ra:m:501', parent: 'm:501', releases: 2, undated_releases: 0, musicbrainz_releases: 0, y0: 1980, y1: 2016, states: { owned: 1, none: 1 } },
                { id: 'ra:nm:c:1:undated', parent: 'nm:c:1', decade: 'undated', releases: 1, undated_releases: 1, musicbrainz_releases: 0, y0: null, y1: null, states: { none: 1 } },
            ],
        },
    ],
};

describe('adaptStrataPayload', () => {
    it('reads a hand-written route payload', () => {
        const graph = adaptStrataPayload(EXAMPLE);
        expect(graph.rootCredit).toBe('c:1');
        expect(graph.totals.releases).toBe(9);
        expect(graph.edges).toEqual([{ a: 'm:501', b: 'm:502', kind: 'personnel', categories: ['Production'], people: 1 }]);
        const byId = new Map(graph.entries.map((entry) => [entry.id, entry]));
        expect(byId.get('c:1+2')).toMatchObject({ level: 0, kind: 'credit', parent: null, label: 'xxxxxxxxxx, xxxxxxxxxxxxx', credits: 1 });
        expect(byId.get('m:501')).toMatchObject({ year: 1971, yearSource: 'master', releases: 4, masters: 1, state: 'owned', undated: false, masterId: '501' });
        expect(byId.get('m:502')).toMatchObject({ undated: true });
        expect(byId.get('nm:c:1')).toMatchObject({ agg: true, aggKind: 'no_master', lane: 'nomaster', undated: false, masters: 0 });
        expect(byId.get('ma:c:1:1980s')).toMatchObject({ aggKind: 'masters', masters: 2, y0: 1982, y1: 1989, decade: '1980s' });
        expect(byId.get('r:9')).toMatchObject({ releases: 1, undated: true, y0: null, undatedReleases: 1 });
        expect(byId.get('r:10')).toMatchObject({ state: 'wanted-owned', recordedAt: { owned: '2019-04-01T00:00:00Z', wanted: '2015-01-01T00:00:00Z' } });
        expect(byId.get('mb:0f9e')).toMatchObject({ provider: 'musicbrainz', state: null, recordedAt: null, releaseId: '0f9e' });
        expect(byId.get('ra:m:501')).toMatchObject({ aggKind: 'releases', states: { owned: 1, none: 1 } });
        expect(byId.get('ra:nm:c:1:undated')).toMatchObject({ decade: 'undated', undated: true });
        expect(Object.isFrozen(byId.get('r:9'))).toBe(true);
    });

    it('lays the example out with both lanes, the payload cursors, and the route edges', () => {
        const layout = layoutStrata(adaptStrataPayload(EXAMPLE));
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        expect(layout.nodes.map((node) => node.level)).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
        expect(byId.get('nm:c:1')).toMatchObject({ lane: 'nomaster', undated: true, x: UNDATED_X, cursor: 'nm:c:1' });
        expect(byId.get('m:502')).toMatchObject({ undated: true, x: UNDATED_X, cursor: 'm:502' });
        expect(byId.get('m:501').x).toBeCloseTo(yearToX(layout.axis, 1971));
        expect(byId.get('ra:m:501')).toMatchObject({ cursor: 'ra:m:501', origin: 'payload', states: { owned: 1, none: 1 } });
        expect(byId.get('mb:0f9e')).toMatchObject({ provider: 'musicbrainz', cursor: null, state: null });
        expect(byId.get('c:1+2').x).toBeCloseTo(yearToX(layout.axis, 1971));
        // Shared personnel across credits stays in the panel: the planar rule draws none.
        expect(layout.edges).toEqual([]);
        expect(layout.depth.fit).toBeGreaterThan(1);
        expect(layout.page).toBeNull();
        expectInvariants(adaptStrataPayload(EXAMPLE), layout);
    });

    it('accepts an anonymous payload with empty planes and no aggregate lists', () => {
        const graph = adaptStrataPayload({ planes: [{ level: 2 }, { level: 1, nodes: [] }, { level: 0, nodes: [{ id: 'c:1' }] }] });
        expect(graph).toMatchObject({ root: null, budget: null, totals: null, focus: null, signedIn: false, rootCredit: 'c:1', edges: [] });
        const layout = layoutStrata(graph);
        expect(layout.nodes).toHaveLength(1);
        expect(layout.nodes[0]).toMatchObject({ x: UNDATED_X, label: null, states: null });
        expect(layoutStrata(adaptStrataPayload({ planes: [{ level: 0 }, { level: 1 }, { level: 2 }] }))).toMatchObject({ nodes: [], rootCredit: null });
    });

    it('reads a one-sided span, drops non-numeric state counts, and places a lane by its span', () => {
        const graph = adaptStrataPayload({
            planes: [
                { level: 0, nodes: [{ id: 'c:1' }] },
                { level: 1, aggregates: [{ id: 'nm:c:1', parent: 'c:1', kind: 'no_master', releases: 3, y0: 1990, states: { none: 3, owned: 'x' } }], edges: [null, { kind: 'other', source: 'a', target: 'b' }] },
                { level: 2 },
            ],
        });
        expect(graph.entries[1]).toMatchObject({ y0: 1990, y1: 1990, states: { none: 3 } });
        expect(graph.edges).toEqual([]);
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
    const master = { id: 'm:1', parent: 'c:1', year: 1990 };
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
        ['an unknown aggregate kind', payloadWith([credit], [], [], [{ id: 'x:1', parent: 'c:1', kind: 'band' }]), /unknown aggregate kind/],
        ['a non-numeric year', payloadWith([credit], [{ id: 'm:1', parent: 'c:1', year: '1990' }]), /non-numeric year/],
        ['a negative count', payloadWith([credit], [{ id: 'm:1', parent: 'c:1', releases: -1 }]), /invalid releases count/],
        ['an undated flag that contradicts the year', payloadWith([credit], [{ ...master, undated: true }]), /says undated/],
        ['an unknown collector state', payloadWith([credit], [{ ...master, state: 'collected' }]), /unknown collector state/],
        ['an unknown state count', payloadWith([{ id: 'c:1', states: { owned_wanted: 1 } }]), /unknown collector state/],
        ['a MusicBrainz release with a state', payloadWith([credit], [master], [{ id: 'mb:x', parent: 'm:1', provider: 'musicbrainz', state: 'owned' }]), /MusicBrainz-only/],
        ['an unknown provider', payloadWith([credit], [master], [{ id: 'x:1', parent: 'm:1', provider: 'spotify' }]), /unknown provider/],
        ['a provider its id contradicts', payloadWith([credit], [master], [{ id: 'r:1', parent: 'm:1', provider: 'musicbrainz' }]), /is a discogs id/],
        ['a recorded_at that is not an object', payloadWith([credit], [master], [{ id: 'r:1', parent: 'm:1', recorded_at: '2020-01-01' }]), /recorded_at/],
        ['a focus with no cursor', { ...payloadWith([credit]), focus: { plane: 'master' } }, /focus has no cursor/],
        ['a focus on an unknown plane', { ...payloadWith([credit]), focus: { id: 'c:other', plane: 'credits' } }, /unknown plane/],
        ['a focus past its last page', { ...payloadWith([credit]), focus: { id: 'c:other', plane: 'credit', page: 2, pages: 2, page_size: 1, members: 2 } }, /page 2 of 2/],
        ['a focus with a bad page size', { ...payloadWith([credit]), focus: { id: 'c:other', plane: 'credit', page: 0, pages: 1, page_size: 0, members: 2 } }, /invalid page_size/],
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

    // Credits holding 30 masters of 30 pressings each, at the route's largest budget: far past what
    // the plane can draw, so the footprint check folds it.
    function largeDiscography({ credits = 1, signedIn = false, focus = null, page = 0 } = {}) {
        const releases = [];
        const masterYears = new Map();
        const marks = new Map();
        let id = 1;
        for (let c = 0; c < credits; c++) {
            const credit = c ? `1+${c + 1}` : '1';
            for (let m = 0; m < 30; m++) {
                const masterId = String(1000 * (c + 1) + m);
                masterYears.set(masterId, m % 7 === 0 ? null : 1960 + m);
                for (let k = 0; k < 30; k++) {
                    const releaseId = String(id++);
                    releases.push({ id: releaseId, masterId, year: k % 5 === 0 ? null : 1960 + m + k, credit, provider: 'discogs', title: null });
                    if (k === 3) marks.set(releaseId, { owned: true, wanted: false, ownedAt: '2020-01-01T00:00:00Z', wantedAt: null });
                }
                releases.push({ id: String(id++), masterId: null, year: m % 2 ? null : 1990, credit, provider: 'discogs', title: null });
            }
        }
        const catalog = { rootId: '1', releases, masterYears, marks };
        return adaptStrataPayload(buildPayload(catalog, [Math.max(3, credits), 500, 500], { signedIn, focus, page }));
    }

    it('folds a large budget until it fits, pressings without state first', () => {
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

    it("pins the route's page of pressings while folding everything else", () => {
        const graph = largeDiscography({ credits: 3, focus: 'm:2000', page: 1 });
        const layout = layoutStrata(graph);
        expectInvariants(graph, layout);
        expect(layout.page).toMatchObject({ cursor: 'ra:m:2000', level: 2, index: 1, pages: 4, per: ROUTE_PAGE_SIZE, size: 30, parent: 'm:2000' });
        expect(layout.page.shown).toHaveLength(ROUTE_PAGE_SIZE);
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        for (const id of layout.page.shown) expect(byId.get(id)).toMatchObject({ parent: 'm:2000', members: [id] });
        expect(byId.get('ra:m:2000')).toMatchObject({ releases: 30 - ROUTE_PAGE_SIZE, cursor: 'ra:m:2000' });
        expect(layout.nodes.some((node) => node.id === 'fold:credits')).toBe(false);
    });

    it("pins the route's page of masters, leaving the credit's lane in place", () => {
        const graph = largeDiscography({ credits: 2, focus: 'ma:c:1+2:all' });
        const layout = layoutStrata(graph);
        expectInvariants(graph, layout);
        expect(layout.page).toMatchObject({ cursor: 'ma:c:1+2:all', level: 1, per: ROUTE_PAGE_SIZE, size: 30, pages: 4, parent: 'c:1+2' });
        expect(layout.page.shown).toHaveLength(ROUTE_PAGE_SIZE);
        const credit = layout.nodes.find((node) => node.id === 'c:1+2');
        expect(credit.children).toContain('nm:c:1+2');
        expect(credit.children).toContain('ma:c:1+2:all');
    });

    it('folds a page of credits only when the credit plane cannot hold it', () => {
        const graph = largeDiscography({ credits: 12, focus: 'c:other' });
        expect(graph.focus).toMatchObject({ level: 0, pageSize: 8 });
        const layout = layoutStrata(graph);
        expectInvariants(graph, layout);
        expect(layout.page.shown.length).toBeLessThan(ROUTE_PAGE_SIZE);
        const small = adaptStrataPayload(recorded('c:other', 0));
        expect(layoutStrata(small).page.shown).toHaveLength(small.focus.pageSize);
    });

    it('draws no page for a focus whose members it cannot find', () => {
        const graph = adaptStrataPayload({ ...EXAMPLE, focus: { id: 'ra:m:999', plane: 'release', page: 0, pages: 1, page_size: 1, members: 1 } });
        expect(layoutStrata(graph).page).toMatchObject({ cursor: 'ra:m:999', shown: [], parent: null });
        const unknown = adaptStrataPayload({ ...EXAMPLE, focus: { id: 'zz:1', plane: 'master', page: 0, pages: 1, page_size: 1, members: 1 } });
        expect(layoutStrata(unknown).page.shown).toEqual([]);
        const plain = layoutStrata(adaptStrataPayload(EXAMPLE));
        expect(layoutStrata(unknown).nodes).toEqual(plain.nodes);
    });

    it('draws only the planar subset of lateral edges', () => {
        const masters = Array.from({ length: 5 }, (_, i) => ({ id: `m:${i}`, parent: 'c:1', year: 1970 + i, releases: 1 }));
        const releases = masters.map((m, i) => ({ id: `r:${i}`, parent: m.id, year: 1970 + i }));
        const graph = adaptStrataPayload({
            planes: [
                { level: 0, nodes: [{ id: 'c:1' }, { id: 'c:1+2' }, { id: 'c:1+3' }] },
                { level: 1, nodes: masters, edges: [{ source: 'm:2', target: 'm:3', kind: 'shared_personnel', categories: [], people: 1 }] },
                { level: 2, nodes: releases, aggregates: [{ id: 'ra:x', parent: 'm:0', releases: 0 }] },
            ],
        });
        expect(layoutStrata(graph).edges).toEqual([{ a: 'm:2', b: 'm:3', kind: 'personnel' }]);
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
