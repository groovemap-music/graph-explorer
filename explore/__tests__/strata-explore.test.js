/**
 * Discography Strata in Explore (strata-explore.js): the pure decisions (errors, both clocks, the
 * collector filter, actions, keyboard, search) and the view driven over recorded route bodies with
 * a stand-in renderer, against the real markup in index.html.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BLOCKED_REASON,
    COPY_UNREAD_REASON,
    MAX_ROOT_RELEASES,
    NO_COPY_REASON,
    NO_WEBGL_MESSAGE,
    PAST_REASON,
    StrataExplore,
    applyClocks,
    blockedReason,
    copyIdOf,
    describeCursor,
    discogsLinks,
    hitNodeId,
    initStrata,
    nodeActions,
    paintStates,
    recordedSpan,
    searchDrawn,
    stateAsOf,
    strataErrorMessage,
    strataKeyCommand,
} from '../static/js/strata-explore.js';
import { adaptStrataPayload, layoutStrata } from '../static/js/strata-layout.js';
import { COLLECTOR_STATES, CollectorAction, canPerform } from '../static/js/strata-collector.js';
import { TABLE_HELP } from '../static/js/strata-table.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'strata-route.json'), 'utf8'));
const INDEX = readFileSync(resolve(HERE, '..', 'static', 'index.html'), 'utf8');

// The route canonicalises a master or lane cursor to its release aggregate's id.
const canonical = (focus) => (focus === null ? null : focus.replace(/^m:/, 'ra:m:').replace(/^nm:/, 'ra:nm:'));
// A pressing is a cursor that names its own page, so the request's page is ignored for it.
const isPressing = (focus) => typeof focus === 'string' && /^(r|mb):/.test(focus);
function recordedBody(focus, page = 0, signedIn = true) {
    const wanted = isPressing(focus) ? 0 : page;
    const entry = RECORDED.responses.find((item) => item.query.focus === canonical(focus) && item.query.page === wanted && item.query.signed_in === true);
    if (!entry) return null;
    const body = structuredClone(entry.body);
    if (signedIn) return body;
    // What the route sends an anonymous caller: no collector field anywhere.
    body.signed_in = false;
    for (const plane of body.planes) for (const node of [...plane.nodes, ...plane.aggregates]) for (const field of ['state', 'states', 'recorded_at', 'owned_copy_ids']) delete node[field];
    return body;
}
const graphOf = (focus = null, page = 0, signedIn = true) => adaptStrataPayload(recordedBody(focus, page, signedIn));

// ---------------------------------------------------------------------------------------------

describe('strataErrorMessage', () => {
    it('says why a large root is refused, with the ceiling the route sends', () => {
        const message = strataErrorMessage({ status: 422, body: { error: 'x', releases: 1356055, max_releases: 134051 }, artistName: 'Various' });
        expect(message).toBe('Various has 1,356,055 releases. Discography Strata draws artists with up to 134,051, so it cannot open this one. The graph view still can.');
        expect(strataErrorMessage({ status: 422, body: { releases: 200000 } })).toContain(MAX_ROOT_RELEASES.toLocaleString('en-US'));
        expect(strataErrorMessage({ status: 422, body: { detail: [] } })).toBe('The strata view could not read that request.');
    });

    it('words a timeout, an unknown artist or cursor, and the rest', () => {
        expect(strataErrorMessage({ status: 504 })).toBe('The strata read took too long and was stopped. Try again in a moment.');
        expect(strataErrorMessage({ status: 404, body: { error: "focus 'x' names nothing under this artist" } })).toMatch(/no longer there/);
        expect(strataErrorMessage({ status: 404, body: { error: "Artist '9' not found" }, artistName: 'Nobody' })).toBe('Nobody is not in the catalog.');
        expect(strataErrorMessage({ status: 400, body: { error: 'credits must be between 3 and 48' } })).toBe('credits must be between 3 and 48');
        expect(strataErrorMessage({ status: 400 })).toMatch(/refused/);
        expect(strataErrorMessage({ status: 429 })).toMatch(/Too many/);
        expect(strataErrorMessage({ status: 503 })).toMatch(/not available/);
        expect(strataErrorMessage({ status: 0 })).toMatch(/could not be loaded/);
        expect(strataErrorMessage()).toMatch(/could not be loaded/);
    });
});

describe('applyClocks', () => {
    const graph = graphOf();
    const byId = (g) => new Map(g.entries.map((entry) => [entry.id, entry]));

    it('is the identity with both clocks at now and no filter', () => {
        const view = applyClocks(graph);
        expect(view.entries).toEqual(graph.entries.map((entry) => ({ ...entry })));
        expect(view).toMatchObject({ past: false, hidden: 0, focus: graph.focus, rootCredit: graph.rootCredit });
    });

    it('hides what was released after the valid-time year, and everything under it', () => {
        const view = applyClocks(graph, { beforeYear: 2000 });
        const kept = byId(view);
        expect(view.hidden).toBeGreaterThan(0);
        for (const entry of view.entries) {
            const start = entry.agg || entry.level === 0 ? entry.y0 : entry.year;
            if (entry.id !== graph.rootCredit) expect(start === null || start <= 2000, entry.id).toBe(true);
            if (entry.parent !== null) expect(kept.has(entry.parent), `${entry.id}'s parent`).toBe(true);
        }
        expect(kept.has('m:70030')).toBe(false);
        expect(kept.has('r:300099')).toBe(false);
        expect(kept.has('m:70003')).toBe(true);
        // Undated entries stay, in the undated strip.
        expect(kept.has('r:300131')).toBe(true);
        // The root's credit always stays, so the view is never empty.
        expect(applyClocks(graph, { beforeYear: 1900 }).entries.map((entry) => entry.id)).toContain(graph.rootCredit);
        const layout = layoutStrata(view);
        expect(layout.nodes.filter((node) => !node.agg && node.year !== null && node.level > 0).every((node) => node.year <= 2000)).toBe(true);
    });

    it('shows each drawn release as recorded at the transaction time', () => {
        const at = Date.parse('2015-01-01T00:00:00Z');
        const view = byId(applyClocks(graph, { recordedAsOf: at }));
        // Owned since 2026, so not yet owned in 2015.
        expect(view.get('r:300101').state).toBe('none');
        // Owned since 2013.
        expect(view.get('r:300097').state).toBe('owned');
        // Wanted since 2011, owned since 2017: only wanted in 2015.
        expect(view.get('r:300141').state).toBe('wanted');
        // Wanted since 2019.
        expect(view.get('r:300131').state).toBe('none');
        expect(stateAsOf({ state: 'wanted-owned', recordedAt: { owned: null, wanted: '2030-01-01T00:00:00Z' } }, at)).toBe('owned');
        expect(stateAsOf({ state: null, recordedAt: null }, at)).toBeNull();
        expect(stateAsOf({ state: 'owned', recordedAt: null }, null)).toBe('owned');
    });

    it('draws aggregates state-less in the past and rolls masters and credits up from drawn releases', () => {
        const view = applyClocks(graph, { recordedAsOf: Date.parse('2012-06-01T00:00:00Z') });
        const kept = byId(view);
        expect(view.past).toBe(true);
        for (const entry of view.entries.filter((item) => item.agg && !item.lane)) {
            expect([entry.state, entry.states], entry.id).toEqual([null, null]);
        }
        // r:300083 has been owned since January 2012, so its master was owned then.
        expect(kept.get('m:70025').state).toBe('owned');
        // m:70030's releases were all recorded later, and some of them are folded: unknown.
        expect(kept.get('m:70030').state).toBeNull();
        expect(kept.get('c:9001').state).toBe('owned');
        // The lane's drawn releases were wanted by then, and its folded ones are unknown.
        expect(kept.get('nm:c:9001').state).toBe('wanted');
    });

    it('rolls a master up to none only when every release under it is drawn', () => {
        const small = adaptStrataPayload({
            planes: [
                { level: 0, nodes: [{ id: 'c:1', releases: 2, state: 'owned' }] },
                { level: 1, nodes: [{ id: 'm:1', parent: 'c:1', year: 2000, releases: 2, state: 'owned' }] },
                {
                    level: 2,
                    nodes: [
                        { id: 'r:1', parent: 'm:1', year: 2000, state: 'owned', recorded_at: { owned: '2020-01-01T00:00:00Z', wanted: null } },
                        { id: 'r:2', parent: 'm:1', year: 2001, state: 'none', recorded_at: { owned: null, wanted: null } },
                    ],
                },
            ],
        });
        const view = byId(applyClocks(small, { recordedAsOf: Date.parse('2010-01-01T00:00:00Z') }));
        expect(view.get('m:1').state).toBe('none');
        expect(view.get('c:1').state).toBe('none');
    });

    it('keeps only what the collector wants or owns, with its ancestors', () => {
        const view = applyClocks(graph, { onlyCollected: true });
        const kept = byId(view);
        expect(view.hidden).toBeGreaterThan(0);
        for (const entry of view.entries) {
            if (entry.level === 2 && !entry.agg) expect(['wanted', 'owned', 'wanted-owned'], entry.id).toContain(entry.state);
            if (entry.parent !== null) expect(kept.has(entry.parent)).toBe(true);
        }
        expect(kept.has(graph.rootCredit)).toBe(true);
        // Nothing collected as of 2000, so the filter leaves only the root's credit.
        const early = applyClocks(graph, { onlyCollected: true, recordedAsOf: Date.parse('2000-01-01T00:00:00Z') });
        expect(early.entries.map((entry) => entry.id)).toEqual([graph.rootCredit]);
        expectLaysOut(view);
    });

    it('drops edges whose masters are hidden', () => {
        const withEdges = adaptStrataPayload({
            planes: [
                { level: 0, nodes: [{ id: 'c:1' }] },
                { level: 1, nodes: [{ id: 'm:1', parent: 'c:1', year: 1990 }, { id: 'm:2', parent: 'c:1', year: 2010 }], edges: [{ source: 'm:1', target: 'm:2', kind: 'shared_personnel' }] },
                { level: 2 },
            ],
        });
        expect(applyClocks(withEdges).edges).toHaveLength(1);
        expect(applyClocks(withEdges, { beforeYear: 2000 }).edges).toEqual([]);
    });

    function expectLaysOut(view) {
        const layout = layoutStrata(view);
        expect(layout.depth.fit).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(layout.nodes).toHaveLength(view.entries.length);
    }

    it('repaints the past onto a layout of today, so scrubbing the transaction clock moves no node', () => {
        const at = Date.parse('2014-01-01T00:00:00Z');
        const today = layoutStrata(graph);
        const painted = paintStates(today, applyClocks(graph, { recordedAsOf: at }));
        expect(painted.nodes.map((node) => [node.id, node.x, node.z])).toEqual(today.nodes.map((node) => [node.id, node.x, node.z]));
        const byNode = new Map(painted.nodes.map((node) => [node.id, node]));
        expect(byNode.get('r:300083').state).toBe('owned');
        expect(byNode.get('r:300036').state).toBe('none');
        expect(byNode.get('ra:m:70007')).toMatchObject({ state: null, states: null });
        // A count node the layout folded takes its releases' states as recorded then: two owned
        // since 2013, one owned only since 2026, and one wanted only since 2020.
        const fold = painted.nodes.find((node) => node.id === 'fold:m:70030:d');
        expect(fold.states).toEqual({ none: 2, owned: 2 });
        expect(paintStates(today, applyClocks(graph))).toBe(today);
    });

    it('finds the span of recorded dates for the transaction-time control', () => {
        expect(recordedSpan(graph)).toEqual({ from: Date.parse('2011-11-10T00:00:00Z'), to: Date.parse('2026-05-26T00:00:00Z') });
        expect(recordedSpan(graphOf(null, 0, false))).toBeNull();
    });
});

describe('nodeActions', () => {
    const release = (state, extra = {}) => ({ id: 'r:9', level: 2, agg: false, lane: null, provider: 'discogs', releaseId: '9', state, cursor: null, ...extra });

    it('offers exactly what the collector machine allows, for every state', () => {
        for (const state of COLLECTOR_STATES) {
            const ids = nodeActions(release(state), { signedIn: true }).map((action) => action.id);
            expect(ids).toContain('discogs');
            expect(ids.includes(CollectorAction.SYNC_NOW)).toBe(canPerform(state, CollectorAction.SYNC_NOW));
            expect(ids.includes(CollectorAction.RECORD_OBSERVATION), state).toBe(canPerform(state, CollectorAction.RECORD_OBSERVATION));
        }
        expect(nodeActions(release('owned'), { signedIn: true }).map((action) => action.id)).toEqual(['discogs', 'sync-now', 'record-observation']);
        expect(nodeActions(release('wanted'), { signedIn: true }).map((action) => action.id)).toEqual(['discogs', 'sync-now']);
    });

    it('never offers a wantlist or collection write', () => {
        const nodes = [...COLLECTOR_STATES.map((state) => release(state)), release(null, { provider: 'musicbrainz', id: 'mb:x' })];
        for (const node of nodes) {
            for (const action of nodeActions(node, { signedIn: true })) {
                expect(action.label).not.toMatch(/wantlist|add to|remove|mark as|collect/i);
                expect(['open', 'discogs', CollectorAction.SYNC_NOW, CollectorAction.RECORD_OBSERVATION]).toContain(action.id);
            }
        }
    });

    it('keeps history read-only: an observation waits until "Recorded as of" is now', () => {
        const action = nodeActions(release('wanted-owned'), { signedIn: true, past: true }).find((item) => item.id === CollectorAction.RECORD_OBSERVATION);
        expect(action).toMatchObject({ enabled: false, reason: PAST_REASON });
    });

    it('records an observation against the earliest copy the route named, and says why when it named none', () => {
        const record = (node, options) => nodeActions(node, { signedIn: true, ...options }).find((item) => item.id === CollectorAction.RECORD_OBSERVATION);
        expect(copyIdOf(release('owned', { ownedCopyIds: ['copy-a', 'copy-b'] }))).toBe('copy-a');
        expect(record(release('owned', { ownedCopyIds: ['copy-a', 'copy-b'] }))).toEqual({ id: 'record-observation', label: 'Record an observation', enabled: true });
        // Owned, but the sync has not minted a copy: an empty list.
        expect(record(release('owned', { ownedCopyIds: [] }))).toEqual({ id: 'record-observation', label: 'Record an observation', enabled: false, reason: NO_COPY_REASON });
        // The route sent no list at all (the copy-id read degraded): disabled with its own reason.
        expect(record(release('owned', { ownedCopyIds: null }))).toEqual({ id: 'record-observation', label: 'Record an observation', enabled: false, reason: COPY_UNREAD_REASON });
        expect(record(release('owned'))).toMatchObject({ enabled: false, reason: COPY_UNREAD_REASON });
        // History is read-only whatever the copies are.
        expect(record(release('owned', { ownedCopyIds: ['copy-a'] }), { past: true })).toMatchObject({ enabled: false, reason: PAST_REASON });
        for (const reason of [NO_COPY_REASON, COPY_UNREAD_REASON]) expect(reason).not.toMatch(/ADR/);
    });

    it('offers no collector action for a MusicBrainz-only release, or for an anonymous caller', () => {
        const musicbrainz = release(null, { provider: 'musicbrainz', id: 'mb:x', releaseId: 'x' });
        expect(nodeActions(musicbrainz, { signedIn: true })).toEqual([]);
        expect(blockedReason(musicbrainz)).toBe(BLOCKED_REASON);
        expect(blockedReason(release('owned'))).toBeNull();
        expect(nodeActions(release(null), { signedIn: false }).map((action) => action.id)).toEqual(['discogs']);
    });

    it('opens cursors: aggregates, lanes, masters, and pressings the layout folded', () => {
        expect(nodeActions({ id: 'ra:m:1', level: 2, agg: true, cursor: 'ra:m:1' })).toEqual([{ id: 'open', label: 'Show these pressings', enabled: true, cursor: 'ra:m:1' }]);
        expect(nodeActions({ id: 'nm:c:1', level: 1, agg: true, lane: 'nomaster', cursor: 'nm:c:1' })[0].label).toBe('Show these releases');
        expect(nodeActions({ id: 'ma:c:1:all', level: 1, agg: true, cursor: 'ma:c:1:all' })[0].label).toBe('Show these masters');
        expect(nodeActions({ id: 'c:other', level: 0, agg: true, cursor: 'c:other' })[0].label).toBe('Show these credits');
        const master = nodeActions({ id: 'm:5', level: 1, agg: false, masterId: '5', cursor: 'm:5' });
        expect(master).toEqual([
            { id: 'open', label: 'Show its pressings', enabled: true, cursor: 'm:5' },
            { id: 'discogs', label: 'Open on Discogs', enabled: true, href: 'https://www.discogs.com/master/5' },
        ]);
        expect(nodeActions({ id: 'fold:m:5:d', level: 2, agg: true, origin: 'fold', cursor: null, parent: 'm:5' })[0]).toMatchObject({ cursor: 'm:5' });
        expect(nodeActions({ id: 'fold:credits', level: 0, agg: true, origin: 'fold', cursor: null, parent: null })).toEqual([]);
        expect(nodeActions(null)).toEqual([]);
    });

    it('links each artist of a shared credit on Discogs', () => {
        expect(discogsLinks({ level: 0, artists: [{ id: '1', name: 'A' }, { id: '2', name: null }] })).toEqual([
            { label: 'Open A on Discogs', href: 'https://www.discogs.com/artist/1' },
            { label: 'Open 2 on Discogs', href: 'https://www.discogs.com/artist/2' },
        ]);
        expect(discogsLinks({ level: 0, artists: [{ id: '1', name: 'A' }] })).toEqual([{ label: 'Open on Discogs', href: 'https://www.discogs.com/artist/1' }]);
        expect(discogsLinks({ level: 2, provider: 'musicbrainz', releaseId: 'x' })).toEqual([]);
        expect(discogsLinks({ level: 0, agg: true })).toEqual([]);
    });
});

describe('describeCursor', () => {
    const byId = new Map([['c:1', { label: 'Band' }], ['m:5', { label: 'Album' }]]);
    it.each([
        ['c:other', 'other credits'],
        ['ma:c:1:all', 'Band masters'],
        ['ma:c:1:1990s', 'Band masters from the 1990s'],
        ['ma:c:1:undated', 'Band masters without a year'],
        ['ra:m:5', 'pressings of Album'],
        ['m:6', 'pressings of master 6'],
        ['ra:nm:c:1', 'Band releases without a master'],
        ['ra:nm:c:1:1980s', 'Band releases without a master, 1980s'],
        ['ra:nm:c:2:undated', 'credit releases without a master, no year'],
        ['zz', 'zz'],
    ])('describes %s', (cursor, text) => expect(describeCursor(cursor, byId)).toBe(text));
});

describe('strataKeyCommand', () => {
    const layout = layoutStrata(graphOf());
    const nodes = layout.nodes;
    const credits = nodes.filter((node) => node.level === 0).sort((a, b) => a.z - b.z || a.x - b.x);
    const key = (k, view = {}) => strataKeyCommand({ key: k }, { nodes, selected: null, solo: null, ...view });

    it('binds the camera: orbit, tilt, zoom, and reset', () => {
        expect(key('ArrowLeft')).toEqual({ type: 'orbit', radians: 0.12 });
        expect(key('ArrowRight')).toEqual({ type: 'orbit', radians: -0.12 });
        expect(key('ArrowUp')).toEqual({ type: 'tilt', radians: 0.08 });
        expect(key('ArrowDown')).toEqual({ type: 'tilt', radians: -0.08 });
        expect(key('+')).toEqual({ type: 'zoom', direction: 'in' });
        expect(key('=')).toEqual({ type: 'zoom', direction: 'in' });
        expect(key('-')).toEqual({ type: 'zoom', direction: 'out' });
        expect(key('0')).toEqual({ type: 'reset' });
        expect(key('Home')).toEqual({ type: 'reset' });
    });

    it('solos a plane, and the same key shows every plane again', () => {
        expect(key('2')).toEqual({ type: 'solo', level: 1 });
        expect(key('2', { solo: 1 })).toEqual({ type: 'solo', level: null });
        expect(key('Escape', { solo: 2 })).toEqual({ type: 'solo', level: null });
    });

    it('moves the selection across planes and along one', () => {
        expect(key('PageUp')).toEqual({ type: 'select', id: credits[0].id });
        expect(key('PageDown')).toEqual({ type: 'select', id: credits[0].id });
        const credit = credits[0];
        expect(key('PageDown', { selected: credit.id })).toEqual({ type: 'select', id: credit.children[0] });
        expect(key('PageUp', { selected: credit.children[0] })).toEqual({ type: 'select', id: credit.id });
        expect(key(']')).toEqual({ type: 'select', id: credits[0].id });
        expect(key('[')).toEqual({ type: 'select', id: credits.at(-1).id });
        expect(key(']', { selected: credits.at(-1).id })).toEqual({ type: 'select', id: credits[0].id });
        expect(key('[', { selected: credits[0].id })).toEqual({ type: 'select', id: credits.at(-1).id });
        const masters = nodes.filter((node) => node.level === 1).sort((a, b) => a.z - b.z || a.x - b.x);
        expect(key(']', { solo: 1 })).toEqual({ type: 'select', id: masters[0].id });
        expect(key('Escape', { selected: credit.id })).toEqual({ type: 'select', id: null });
    });

    it('opens a selected count node on Enter, and leaves other keys alone', () => {
        expect(key('Enter', { selected: 'ra:m:70025' })).toEqual({ type: 'open', cursor: 'ra:m:70025' });
        expect(key('Enter', { selected: 'r:300099' })).toBeNull();
        expect(key('Enter')).toBeNull();
        expect(key('Escape')).toBeNull();
        expect(key('x')).toBeNull();
        expect(strataKeyCommand({ key: 'ArrowLeft', ctrlKey: true }, { nodes })).toBeNull();
        expect(strataKeyCommand({ key: ']' }, { nodes: [] })).toBeNull();
    });
});

describe('searchDrawn', () => {
    const nodes = layoutStrata(graphOf()).nodes;
    it('ranks exact titles, then prefixes, then substrings, pressings before masters', () => {
        expect(searchDrawn(nodes, 'lantern static').map((node) => node.id)).toEqual(['r:300083', 'm:70025']);
        expect(searchDrawn(nodes, 'willow')[0].id).toBe('m:70030');
        expect(searchDrawn(nodes, 'orbit').map((node) => node.id)).toEqual(['m:70030']);
        expect(searchDrawn(nodes, 'placeholder band')[0].id).toBe('c:9001');
        expect(searchDrawn(nodes, 'remixer two')[0].id).toBe('c:9001+9004+9005');
        expect(searchDrawn(nodes, '   ')).toEqual([]);
        expect(searchDrawn(nodes, 'no such title')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------

class FakeRenderer extends EventTarget {
    constructor(stage) {
        super();
        this.stage = stage;
        this.calls = [];
        this.soloed = null;
        this.selected = null;
        this.layout = null;
    }
    setLayout(layout) {
        this.layout = layout;
        this.calls.push(['setLayout']);
    }
    select(id) {
        if (id === this.selected) return;
        this.selected = id;
        this.dispatchEvent(new CustomEvent('select', { detail: { id } }));
    }
    solo(level) {
        this.soloed = level;
        this.calls.push(['solo', level]);
        this.dispatchEvent(new CustomEvent('solo', { detail: { level } }));
    }
}
for (const method of ['orbit', 'tilt', 'zoom', 'resetCamera', 'refreshColors', 'start', 'stop', 'resize', 'dispose']) {
    FakeRenderer.prototype[method] = function record(...args) {
        this.calls.push([method, ...args]);
    };
}

function mountMarkup() {
    const parsed = new DOMParser().parseFromString(INDEX, 'text/html');
    document.body.replaceChildren(
        document.importNode(parsed.getElementById('exploreViewToggle'), true),
        document.importNode(parsed.getElementById('strataView'), true),
    );
}

function fakeApi() {
    return {
        getStrata: vi.fn(async (artistId, { focus = null, page = 0 } = {}, token = null) => {
            if (artistId === 'huge') return { ok: false, status: 422, body: { error: 'too large', releases: 1356055, max_releases: 134051 } };
            if (artistId === 'slow') return { ok: false, status: 504, body: { error: 'Strata query timed out — try again later' } };
            const body = recordedBody(focus, page, token !== null);
            return body ? { ok: true, status: 200, body } : { ok: false, status: 404, body: { error: `focus '${focus}' names nothing under this artist` } };
        }),
        search: vi.fn(async () => ({ results: [] })),
        triggerSync: vi.fn(async () => ({ ok: true, status: 202, body: {} })),
        // The collection is never read to find a copy; a test that sees this called has found a scan.
        getUserCollection: vi.fn(async () => {
            throw new Error('the strata view must not scan /api/user/collection');
        }),
        createObservation: vi.fn(async () => ({ ok: true, status: 201, body: {} })),
    };
}

describe('StrataExplore', () => {
    let api;
    let auth;
    let strata;
    const renderers = [];

    beforeEach(() => {
        mountMarkup();
        api = fakeApi();
        auth = { isLoggedIn: vi.fn(() => true), getToken: vi.fn(() => 'jwt') };
        strata = new StrataExplore({
            api,
            auth,
            createRenderer: (stage) => {
                const renderer = new FakeRenderer(stage);
                renderers.push(renderer);
                return renderer;
            },
            now: () => Date.parse('2026-10-23T12:00:00Z'),
        });
    });

    afterEach(() => {
        strata.dispose();
        renderers.length = 0;
        document.body.textContent = '';
        document.documentElement.className = '';
    });

    const $ = (id) => document.getElementById(id);
    const open = async (artist = { id: '9001', name: 'The Placeholder Band' }) => {
        strata.setArtist(artist);
        await strata.show();
        return renderers[0];
    };

    it('opens an artist: fetches the overview with the token, lays it out, and draws it', async () => {
        const renderer = await open();
        expect(api.getStrata).toHaveBeenCalledWith('9001', { focus: null, page: 0, budget: '3/12/16' }, 'jwt');
        expect($('strataView').classList.contains('hidden')).toBe(false);
        expect(renderer.calls).toContainEqual(['start']);
        expect(renderer.layout.nodes.length).toBeGreaterThan(10);
        expect($('strataSummary').textContent).toContain('6 credits · 40 masters · 169 releases');
        expect($('strataSummary').textContent).toContain('13 MusicBrainz-only');
        expect($('strataOnlyCollected').disabled).toBe(false);
        expect($('strataRecordedAsOf').disabled).toBe(false);
        expect($('strataRecordedAsOfLabel').textContent).toBe('now');
        expect($('strataTrail').hidden).toBe(true);
        expect($('strataSelection').querySelectorAll('.strata-chip')).toHaveLength(6);
        strata.hide();
        expect($('strataView').classList.contains('hidden')).toBe(true);
        expect(renderer.calls.at(-1)).toEqual(['stop']);
    });

    it('opens anonymously with the collector controls off', async () => {
        auth.isLoggedIn.mockReturnValue(false);
        await open();
        expect(api.getStrata).toHaveBeenCalledWith('9001', expect.anything(), null);
        expect($('strataOnlyCollected').disabled).toBe(true);
        expect($('strataRecordedAsOf').disabled).toBe(true);
        expect($('strataSummary').textContent).toContain('Sign in to see what you want and own.');
    });

    it('drills into a cursor with a new request, pages it on the server, and goes back', async () => {
        const renderer = await open();
        await strata.drill('m:70030');
        expect(api.getStrata).toHaveBeenLastCalledWith('9001', { focus: 'm:70030', page: 0, budget: '3/12/16' }, 'jwt');
        expect(renderer.layout.page).toMatchObject({ cursor: 'ra:m:70030', index: 0, pages: 2 });
        expect($('strataTrail').hidden).toBe(false);
        expect($('strataTrail').textContent).toContain('pressings of Willow Orbit: page 1 of 2 (15 in all)');
        const next = [...$('strataTrail').querySelectorAll('button')].find((button) => button.textContent === 'Next page');
        next.click();
        await vi.waitFor(() => expect(renderer.layout.page.index).toBe(1));
        expect(api.getStrata).toHaveBeenLastCalledWith('9001', { focus: 'ra:m:70030', page: 1, budget: '3/12/16' }, 'jwt');
        await strata.turnPage(1);
        expect(renderer.layout.page.index).toBe(0);
        await strata.turnPage(-1);
        expect(renderer.layout.page.index).toBe(1);
        await strata.back();
        expect(renderer.layout.page).toBeNull();
        expect($('strataTrail').hidden).toBe(true);
        expect(await strata.turnPage(1)).toBe(false);
    });

    it('marks the view busy while a strata request is in flight, and only then', async () => {
        expect($('strataView').getAttribute('aria-busy')).toBe('false');
        let answer;
        api.getStrata.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        strata.setArtist({ id: '9001', name: 'The Placeholder Band' });
        const shown = strata.show();
        expect($('strataView').getAttribute('aria-busy')).toBe('true');
        answer({ ok: true, status: 200, body: recordedBody(null) });
        await shown;
        expect($('strataView').getAttribute('aria-busy')).toBe('false');
        const drill = strata.drill('m:70030');
        expect($('strataView').getAttribute('aria-busy')).toBe('true');
        await drill;
        expect($('strataView').getAttribute('aria-busy')).toBe('false');
        expect($('strataTrail').textContent).toContain('pressings of Willow Orbit');
    });

    it('says why a large root or a slow read did not open', async () => {
        await open({ id: 'huge', name: 'Various' });
        expect($('strataMessage').hidden).toBe(false);
        expect($('strataMessage').textContent).toBe('Various has 1,356,055 releases. Discography Strata draws artists with up to 134,051, so it cannot open this one. The graph view still can.');
        strata.setArtist({ id: 'slow', name: 'Slow' });
        await vi.waitFor(() => expect($('strataMessage').textContent).toMatch(/took too long/));
        expect($('strataLoading').classList.contains('active')).toBe(false);
        strata.setArtist({ id: '9001', name: 'The Placeholder Band' });
        await vi.waitFor(() => expect($('strataMessage').hidden).toBe(true));
    });

    it('keeps a failed drill on the current view and says so', async () => {
        const renderer = await open();
        const before = renderer.layout;
        expect(await strata.drill('ma:c:404:all')).toBe(false);
        expect(renderer.layout).toBe(before);
        expect($('strataMessage').textContent).toMatch(/no longer there/);
        api.getStrata.mockRejectedValueOnce(new Error('offline'));
        expect(await strata.drill('c:other')).toBe(false);
        expect($('strataMessage').textContent).toMatch(/could not be loaded/);
        api.getStrata.mockResolvedValueOnce({ ok: true, status: 200, body: { planes: 'nope' } });
        expect(await strata.drill('c:other')).toBe(false);
        expect($('strataMessage').textContent).toMatch(/could not be read/);
    });

    it('scrubs valid time from the shared scrubber and transaction time from its own control', async () => {
        const renderer = await open();
        strata.setBeforeYear(1995);
        expect($('strataValidTimeLabel').textContent).toBe('to 1995');
        expect(renderer.layout.nodes.filter((node) => !node.agg && node.level > 0 && node.year !== null).every((node) => node.year <= 1995)).toBe(true);
        expect($('strataSummary').textContent).toContain('Releases up to 1995.');
        strata.setBeforeYear(null);
        expect($('strataValidTimeLabel').textContent).toBe('All');
        const input = $('strataRecordedAsOf');
        // r:300083 has been owned since 2012-01-13.
        input.value = String(Date.parse('2012-01-01T00:00:00Z'));
        input.dispatchEvent(new Event('input'));
        expect($('strataRecordedAsOfLabel').textContent).toBe('2012-01-01');
        expect(renderer.layout.nodes.find((node) => node.id === 'r:300083').state).toBe('none');
        expect($('strataSummary').textContent).toContain('States as recorded on 2012-01-01');
        input.value = input.max;
        input.dispatchEvent(new Event('input'));
        expect($('strataRecordedAsOfLabel').textContent).toBe('now');
        expect(renderer.layout.nodes.find((node) => node.id === 'r:300083').state).toBe('owned');
        const toggle = vi.fn();
        strata.onToggleTimeline = toggle;
        $('strataValidTimeBtn').click();
        expect(toggle).toHaveBeenCalled();
    });

    it('filters to what the collector collects', async () => {
        const renderer = await open();
        const all = renderer.layout.nodes.length;
        const box = $('strataOnlyCollected');
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        expect(renderer.layout.nodes.length).toBeLessThan(all);
        for (const node of renderer.layout.nodes.filter((item) => item.level === 2 && !item.agg)) expect(['wanted', 'owned', 'wanted-owned']).toContain(node.state);
        expect($('strataSummary').textContent).toMatch(/hidden by the filters/);
        strata.setOnlyCollected(false);
        expect(renderer.layout.nodes.length).toBe(all);
        expect(box.checked).toBe(false);
    });

    it('binds the keyboard to the camera, solo, and selection, and Enter opens a count node', async () => {
        const renderer = await open();
        const stage = $('strataStage');
        const press = (key) => stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        press('ArrowLeft');
        press('-');
        press('0');
        press('3');
        expect(renderer.calls).toEqual(expect.arrayContaining([['orbit', 0.12], ['zoom', 'out'], ['resetCamera'], ['solo', 2]]));
        expect(document.querySelector('[data-strata-solo="2"]').getAttribute('aria-pressed')).toBe('true');
        press('3');
        expect(renderer.soloed).toBeNull();
        press(']');
        expect(strata.selected).toBe(renderer.layout.nodes.filter((node) => node.level === 0).sort((a, b) => a.z - b.z || a.x - b.x)[0].id);
        expect($('strataSelection').querySelector('.strata-selection-title')).not.toBeNull();
        strata.selectNode('ra:m:70025');
        press('Enter');
        await vi.waitFor(() => expect(renderer.layout.page?.cursor).toBe('ra:m:70025'));
        const unbound = new KeyboardEvent('keydown', { key: 'x', cancelable: true });
        stage.dispatchEvent(unbound);
        expect(unbound.defaultPrevented).toBe(false);
        $('strataResetCameraBtn').click();
        document.querySelector('[data-strata-solo="1"]').click();
        document.querySelector('[data-strata-solo=""]').click();
        expect(renderer.calls.slice(-3)).toEqual([['resetCamera'], ['solo', 1], ['solo', null]]);
    });

    it('re-reads the colors when the theme changes', async () => {
        const renderer = await open();
        document.documentElement.classList.add('dark');
        await vi.waitFor(() => expect(renderer.calls).toContainEqual(['refreshColors']));
    });

    it('shows an owned pressing with its recorded dates and the actions the machine allows', async () => {
        const renderer = await open();
        strata.selectNode('r:300083');
        const panel = $('strataSelection');
        expect(panel.querySelector('.strata-state').textContent).toBe('owned');
        expect(panel.textContent).toContain('owned since 2012-01-13');
        const labels = [...panel.querySelectorAll('.strata-action')].map((node) => node.textContent);
        expect(labels).toEqual(['Open on Discogs', 'Sync now', 'Record an observation']);
        expect(panel.querySelector('a.strata-action').href).toBe('https://www.discogs.com/release/300083');
        panel.querySelector('[data-action="sync-now"]').click();
        await vi.waitFor(() => expect($('strataActionStatus').textContent).toMatch(/Sync started/));
        expect(api.triggerSync).toHaveBeenCalledWith('jwt');
        expect(panel.querySelector('[data-action="record-observation"]').disabled).toBe(false);
        panel.querySelector('[data-action="record-observation"]').click();
        const form = panel.querySelector('form.strata-observation');
        form.querySelector('select').value = 'grading';
        form.querySelector('input').value = '  VG+  ';
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() => expect($('strataActionStatus').textContent).toBe('Observation recorded.'));
        // The copy comes from the node the route drew, and nothing reads the collection to find it.
        expect(api.createObservation).toHaveBeenCalledWith('jwt', 'copy-300083-a', { kind: 'grading', value: 'VG+', source: 'user' });
        expect(api.getUserCollection).not.toHaveBeenCalled();
        // A wanted pressing has no owned copy to observe.
        strata.selectNode('r:300036');
        expect([...panel.querySelectorAll('.strata-action')].map((node) => node.textContent)).toEqual(['Open on Discogs', 'Sync now']);
        expect(renderer.selected).toBe('r:300036');
        // Wanted and owned: both recorded times, and an observation on the owned copy.
        await strata.load({ focus: 'ra:nm:c:9001', page: 1 });
        strata.selectNode('r:300141');
        expect(panel.querySelector('.strata-state').textContent).toBe('wanted + owned');
        expect(panel.textContent).toContain('owned since 2017-05-09, wanted since 2011-11-10');
        expect([...panel.querySelectorAll('.strata-action')].map((node) => node.textContent)).toEqual(['Open on Discogs', 'Sync now', 'Record an observation']);
        // Two copies: the earliest acquired comes first, and that is the one observed.
        expect(strata.byId.get('r:300141').ownedCopyIds).toEqual(['copy-300141-a', 'copy-300141-b']);
        await strata.recordObservation(strata.byId.get('r:300141'), { kind: 'note', value: 'first copy' });
        expect(api.createObservation).toHaveBeenLastCalledWith('jwt', 'copy-300141-a', { kind: 'note', value: 'first copy', source: 'user' });
        expect(api.getUserCollection).not.toHaveBeenCalled();
    });

    it('disables the observation with a reason when the route named no copy, and never scans the collection', async () => {
        await open();
        await strata.load({ focus: 'ra:m:70030', page: 1 });
        const panel = $('strataSelection');
        // Owned, and the sync has minted no copy yet: the route sends an empty list.
        strata.selectNode('r:300097');
        expect(strata.byId.get('r:300097').ownedCopyIds).toEqual([]);
        let button = panel.querySelector('[data-action="record-observation"]');
        expect(button.disabled).toBe(true);
        expect(button.title).toBe(NO_COPY_REASON);
        expect(panel.querySelector('.strata-blocked').textContent).toBe(NO_COPY_REASON);
        // The copy-id read degraded: the field is absent on the node.
        strata.byId.get('r:300103').ownedCopyIds = null;
        strata.selectNode('r:300103');
        button = panel.querySelector('[data-action="record-observation"]');
        expect(button.disabled).toBe(true);
        expect(button.title).toBe(COPY_UNREAD_REASON);
        button.click();
        expect(panel.querySelector('form.strata-observation')).toBeNull();
        // A call that gets past the disabled button says the same and records nothing.
        expect(await strata.recordObservation(strata.byId.get('r:300103'), { kind: 'note', value: 'x' })).toBe(false);
        expect($('strataActionStatus').textContent).toBe(COPY_UNREAD_REASON);
        expect(await strata.recordObservation(strata.byId.get('r:300097'), { kind: 'note', value: 'x' })).toBe(false);
        expect($('strataActionStatus').textContent).toBe(NO_COPY_REASON);
        expect(api.createObservation).not.toHaveBeenCalled();
        expect(api.getUserCollection).not.toHaveBeenCalled();
    });

    it('explains a failed observation, a failed sync, and an empty observation', async () => {
        await open();
        strata.selectNode('r:300083');
        const node = strata.byId.get('r:300083');
        expect(await strata.recordObservation(node, { kind: 'note', value: ' ' })).toBe(false);
        expect($('strataActionStatus').textContent).toMatch(/Write what you observed/);
        api.createObservation.mockResolvedValueOnce({ ok: false, status: 422, body: { detail: 'bad source' } });
        expect(await strata.recordObservation(node, { kind: 'note', value: 'x' })).toBe(false);
        expect($('strataActionStatus').textContent).toBe('bad source');
        api.triggerSync.mockResolvedValueOnce({ ok: false, status: 429, body: null });
        await strata.syncNow();
        expect($('strataActionStatus').textContent).toMatch(/less than a minute/);
        api.triggerSync.mockResolvedValueOnce({ ok: false, status: 400, body: { error: 'Discogs not connected' } });
        await strata.syncNow();
        expect($('strataActionStatus').textContent).toBe('Discogs not connected');
    });

    it('disables observations in the past', async () => {
        await open();
        strata.setRecordedAsOf(Date.parse('2024-01-01T00:00:00Z'));
        strata.selectNode('r:300083');
        const button = $('strataSelection').querySelector('[data-action="record-observation"]');
        expect(button.disabled).toBe(true);
        expect($('strataSelection').textContent).toContain(PAST_REASON);
    });

    it('draws a MusicBrainz-only pressing with its blocked reason and no collector action', async () => {
        const renderer = await open();
        await strata.drill('m:70025');
        const musicbrainz = renderer.layout.nodes.find((node) => node.provider === 'musicbrainz');
        expect(musicbrainz).toMatchObject({ state: null, level: 2 });
        strata.selectNode(musicbrainz.id);
        const panel = $('strataSelection');
        expect(panel.querySelector('.strata-blocked').textContent).toBe(BLOCKED_REASON);
        expect(panel.querySelectorAll('.strata-action')).toHaveLength(0);
        expect(panel.querySelector('.strata-state')).toBeNull();
    });

    it('opens a count node from its panel action', async () => {
        const renderer = await open();
        strata.selectNode('nm:c:9001');
        $('strataSelection').querySelector('[data-action="open"]').click();
        await vi.waitFor(() => expect(renderer.layout.page?.cursor).toBe('ra:nm:c:9001'));
    });

    it('focuses from search: a drawn match, then a named master anywhere in the discography', async () => {
        const renderer = await open();
        expect(await strata.focusSearch('lantern static')).toBe('r:300083');
        expect(await strata.focusSearch('lantern')).toBe('r:300083');
        expect(await strata.focusSearch('placeholder')).toBe('c:9001');
        expect(renderer.selected).toBe('c:9001');
        expect(api.search).not.toHaveBeenCalled();
        expect(await strata.focusSearch('ab')).toBeNull();
        expect($('strataMessage').textContent).toMatch(/three characters/);
        api.search.mockResolvedValueOnce({ results: [{ type: 'master', id: '99999', name: 'Elsewhere' }, { type: 'master', id: '70007', name: 'Drift Parade' }] });
        $('strataSearchInput').value = 'Hollow Saffron';
        $('strataSearchForm').dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() => expect(renderer.layout.page?.cursor).toBe('ra:m:70007'));
        expect(api.search).toHaveBeenCalledWith('Hollow Saffron', ['master', 'release'], [], null, null, 10);
        expect(api.getStrata).toHaveBeenCalledWith('9001', { focus: 'm:99999', page: 0, budget: '3/12/16' }, 'jwt');
        expect(renderer.selected).toBe('m:70007');
        expect($('strataMessage').hidden).toBe(true);
        await strata.back();
        expect(renderer.layout.page).toBeNull();
        // A pressing the view already draws is selected without a request.
        await strata.load({ focus: 'ra:m:70030', page: 0 });
        api.getStrata.mockClear();
        api.search.mockResolvedValueOnce({ results: [{ type: 'release', id: '300099', name: 'x' }] });
        expect(await strata.focusSearch('unmatched pressing')).toBe('r:300099');
        expect(api.getStrata).not.toHaveBeenCalled();
        expect(renderer.selected).toBe('r:300099');
        api.search.mockResolvedValueOnce(null);
        expect(await strata.focusSearch('nothing at all')).toBeNull();
        expect($('strataMessage').textContent).toBe("Nothing named “nothing at all” in The Placeholder Band's masters or pressings.");
    });

    describe('search to a pressing through the release cursor', () => {
        const searching = (...results) => api.search.mockResolvedValueOnce({ results });

        it('opens a pressing the view does not draw, on the page that holds it, and selects it', async () => {
            const renderer = await open();
            // Two pages deep in a master: nothing on the overview draws it.
            expect(strata.byId.has('r:300077')).toBe(false);
            searching({ type: 'release', id: '300077', name: 'Lantern Static' });
            expect(await strata.focusSearch('Lantern Static 2026')).toBe('r:300077');
            expect(api.getStrata).toHaveBeenLastCalledWith('9001', { focus: 'r:300077', page: 0, budget: '3/12/16' }, 'jwt');
            expect(renderer.layout.page).toMatchObject({ cursor: 'ra:m:70025', index: 1, pages: 2 });
            expect(strata.cursor).toEqual({ focus: 'ra:m:70025', page: 1 });
            expect(strata.selected).toBe('r:300077');
            expect(renderer.selected).toBe('r:300077');
            expect($('strataSelection').querySelector('.strata-selection-title').textContent).toBe('Lantern Static');
            expect($('strataMessage').hidden).toBe(true);
            expect(api.getUserCollection).not.toHaveBeenCalled();
        });

        it('reaches a pressing in a no-master lane, and a MusicBrainz-only one through mb:', async () => {
            const renderer = await open();
            searching({ type: 'release', id: '300150', name: 'Cinder Amber EP' });
            expect(await strata.focusSearch('Cinder Amber EP')).toBe('r:300150');
            expect(renderer.layout.page).toMatchObject({ cursor: 'ra:nm:c:9001', index: 1 });
            expect(strata.selected).toBe('r:300150');
            const mbid = '6F1C0030-0000-4000-8000-000000000030';
            searching({ type: 'release', id: mbid, name: 'Willow Orbit (MusicBrainz)' });
            expect(await strata.focusSearch('Willow Orbit (MusicBrainz)')).toBe(`mb:${mbid.toLowerCase()}`);
            expect(api.getStrata).toHaveBeenLastCalledWith('9001', { focus: `mb:${mbid.toLowerCase()}`, page: 0, budget: '3/12/16' }, 'jwt');
            expect(renderer.layout.page).toMatchObject({ cursor: 'ra:m:70030', index: 1 });
            expect(strata.selected).toBe(`mb:${mbid.toLowerCase()}`);
            expect($('strataSelection').querySelector('.strata-blocked').textContent).toBe(BLOCKED_REASON);
        });

        it('moves past a hit that belongs to another artist, and puts the view it left on the trail', async () => {
            const renderer = await open();
            searching({ type: 'release', id: '999001', name: 'Elsewhere' }, { type: 'release', id: '300103', name: 'Willow Orbit' });
            expect(await strata.focusSearch('Willow Orbit 2025')).toBe('r:300103');
            expect(api.getStrata.mock.calls.map(([, query]) => query.focus)).toEqual([null, 'r:999001', 'r:300103']);
            expect(strata.selected).toBe('r:300103');
            // The pressing opened from the overview, so the first trail button goes back to it.
            expect(strata.trail).toEqual([{ focus: null, page: 0 }]);
            expect($('strataTrail').querySelector('.strata-trail-btn').textContent).toBe('Back');
            await strata.back();
            expect(renderer.layout.page).toBeNull();
        });

        it('says nothing was found when every hit is another artist\'s, and leaves the view where it was', async () => {
            const renderer = await open();
            searching({ type: 'release', id: '999001', name: 'Elsewhere' }, { type: 'artist', id: '5', name: 'Not a pressing' });
            expect(await strata.focusSearch('Elsewhere')).toBeNull();
            expect($('strataMessage').textContent).toMatch(/Nothing named “Elsewhere”/);
            expect(renderer.layout.page).toBeNull();
            expect(strata.trail).toEqual([]);
        });

        it('names the node a hit opens', () => {
            expect(hitNodeId({ type: 'master', id: '70007' })).toBe('m:70007');
            expect(hitNodeId({ type: 'release', id: 300077 })).toBe('r:300077');
            expect(hitNodeId({ type: 'release', id: '6F1C0030-0000-4000-8000-000000000030' })).toBe('mb:6f1c0030-0000-4000-8000-000000000030');
            for (const hit of [{ type: 'artist', id: '1' }, { type: 'release' }, { type: 'release', id: '' }, null]) expect(hitNodeId(hit)).toBeNull();
        });
    });

    it('reads Back on the first button of the trail from the first drill onward', async () => {
        const renderer = await open();
        const first = () => $('strataTrail').querySelector('.strata-trail-btn').textContent;
        await strata.drill('m:70030');
        expect(first()).toBe('Back');
        await strata.turnPage(1);
        expect(first()).toBe('Back');
        // Drill again from there: still Back, and Back returns one step at a time.
        await strata.drill('m:70025');
        expect(first()).toBe('Back');
        await strata.back();
        expect(renderer.layout.page).toMatchObject({ cursor: 'ra:m:70030', index: 1 });
        expect(first()).toBe('Back');
        await strata.back();
        expect($('strataTrail').hidden).toBe(true);
    });

    it('starts over for a new artist and does nothing without one', async () => {
        expect(await strata.load()).toBe(false);
        await open();
        await strata.drill('c:other');
        strata.setArtist({ id: '9001', name: 'same' });
        expect(strata.trail).toHaveLength(1);
        strata.setArtist(null);
        expect([strata.graph, strata.trail]).toEqual([null, []]);
        strata.pause();
        strata.resume();
        expect(renderers[0].calls.slice(-2)).toEqual([['stop'], ['start']]);
    });
});

describe('StrataExplore table view', () => {
    let api;
    let strata;
    const renderers = [];

    beforeEach(() => {
        mountMarkup();
        api = fakeApi();
        strata = new StrataExplore({
            api,
            auth: { isLoggedIn: vi.fn(() => true), getToken: vi.fn(() => 'jwt') },
            createRenderer: (stage) => {
                const renderer = new FakeRenderer(stage);
                renderers.push(renderer);
                return renderer;
            },
            now: () => Date.parse('2026-10-23T12:00:00Z'),
        });
    });

    afterEach(() => {
        strata.dispose();
        renderers.length = 0;
        document.body.textContent = '';
        document.documentElement.className = '';
    });

    const $ = (id) => document.getElementById(id);
    const tableIds = () => [...$('strataTable').querySelectorAll('tbody tr')].map((tr) => tr.dataset.id);
    const tableRow = (id) => $('strataTable').querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    const openTable = async (artist = { id: '9001', name: 'The Placeholder Band' }) => {
        strata.setArtist(artist);
        await strata.show({ mode: 'table' });
    };

    it('opens as a table without building a renderer, and shows only the table\'s chrome', async () => {
        await openTable();
        expect(renderers).toHaveLength(0);
        expect(strata.mode).toBe('table');
        expect($('strataView').classList.contains('strata-view--table')).toBe(true);
        expect($('strataTableWrap').hidden).toBe(false);
        expect($('strataStage').hidden).toBe(true);
        expect($('strataKeyHelp').hidden).toBe(true);
        expect($('strataResetCameraBtn').hidden).toBe(true);
        expect(document.querySelector('.strata-planes').hidden).toBe(true);
        // The collector controls, search, and the panel are the 3D view's.
        expect($('strataSearchForm').hidden).toBe(false);
        expect($('strataOnlyCollected').disabled).toBe(false);
        expect($('strataSummary').textContent).toContain('6 credits · 40 masters · 169 releases');
        expect($('strataSelection').textContent).toContain('Select a row');
    });

    it('lists every entry the 3D view holds, drawn or folded, once (conservation against the layout)', async () => {
        await openTable();
        const held = new Map();
        for (const node of strata.layout.nodes) for (const id of node.members) held.set(id, (held.get(id) || 0) + 1);
        expect(tableIds().sort()).toEqual(strata.graph.entries.map((entry) => entry.id).sort());
        expect([...held.values()].every((count) => count === 1)).toBe(true);
        expect(new Set(tableIds())).toEqual(new Set(held.keys()));
        const folded = strata.rows.filter((row) => !row.drawn);
        expect(folded.length).toBeGreaterThan(0);
        expect(folded.every((row) => tableRow(row.id).querySelector('.strata-cell-drawn').textContent.startsWith('in “'))).toBe(true);
        // Switching to the 3D view draws the same layout, and builds the renderer then.
        await strata.show({ mode: 'strata' });
        expect(renderers).toHaveLength(1);
        expect(renderers[0].layout).toBe(strata.layout);
        expect(renderers[0].calls).toContainEqual(['start']);
        expect($('strataTableWrap').hidden).toBe(true);
        expect($('strataStage').hidden).toBe(false);
        expect($('strataResetCameraBtn').hidden).toBe(false);
        expect($('strataView').classList.contains('strata-view--table')).toBe(false);
    });

    it('drills an aggregate with the same focus request as the 3D view, and pages as the server does', async () => {
        await openTable();
        const group = strata.rows.find((row) => row.kind === 'pressingGroup' && row.open);
        const button = tableRow(group.id).querySelector('.strata-table-open');
        expect(button.getAttribute('aria-label')).toBe(`${group.open.label}: ${group.name}`);
        button.click();
        await vi.waitFor(() => expect(strata.graph.focus?.id).toBe(group.id));
        expect(api.getStrata).toHaveBeenLastCalledWith('9001', { focus: group.id, page: 0, budget: '3/12/16' }, 'jwt');
        // The 3D view asked for exactly this and drew exactly these entries.
        expect(tableIds().sort()).toEqual(strata.graph.entries.map((entry) => entry.id).sort());
        expect($('strataTrail').textContent).toContain(`page 1 of ${strata.graph.focus.pages}`);
        expect($('strataTableWrap').textContent).not.toBe('');
        if (strata.graph.focus.pages > 1) {
            [...$('strataTrail').querySelectorAll('button')].find((item) => item.textContent === 'Next page').click();
            await vi.waitFor(() => expect(strata.graph.focus.page).toBe(1));
            expect(api.getStrata).toHaveBeenLastCalledWith('9001', { focus: group.id, page: 1, budget: '3/12/16' }, 'jwt');
            expect(tableIds().sort()).toEqual(strata.graph.entries.map((entry) => entry.id).sort());
        }
        await strata.back();
        expect(strata.graph.focus).toBeNull();
        expect(tableIds()).toHaveLength(strata.graph.entries.length);
    });

    it('opens a master with Enter and keeps keyboard focus in the table', async () => {
        await openTable();
        const master = strata.rows.find((row) => row.kind === 'master' && row.drawn);
        tableRow(master.id).focus();
        tableRow(master.id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(strata.graph.focus?.id).toBe(`ra:${master.id}`));
        expect(api.getStrata).toHaveBeenLastCalledWith('9001', { focus: master.id, page: 0, budget: '3/12/16' }, 'jwt');
        expect(document.activeElement.tagName).toBe('TR');
        expect($('strataTable').contains(document.activeElement)).toBe(true);
    });

    it('describes a selected row in the panel, folded or not, without telling the renderer about a folded one', async () => {
        await openTable();
        await strata.show({ mode: 'strata' });
        await strata.show({ mode: 'table' });
        const renderer = renderers[0];
        const folded = strata.rows.find((row) => !row.drawn && row.kind === 'pressing');
        const select = renderer.calls.length;
        tableRow(folded.id).click();
        expect(strata.selected).toBe(folded.id);
        expect(tableRow(folded.id).getAttribute('aria-current')).toBe('true');
        expect($('strataSelection').querySelector('.strata-selection-title').textContent).toBe(folded.name);
        expect([...$('strataSelection').querySelectorAll('.strata-action')].map((item) => item.textContent)).toContain('Show these pressings');
        expect(renderer.selected).toBeNull();
        expect(renderer.calls.slice(select).filter((call) => call[0] === 'select')).toEqual([]);

        const drawn = strata.rows.find((row) => row.drawn && row.kind === 'master');
        tableRow(drawn.id).click();
        expect($('strataSelection').querySelector('.strata-selection-title').textContent).toBe(drawn.name);
        expect(renderer.selected).toBe(drawn.id);
        // Escape clears it, in the table and in the renderer.
        tableRow(drawn.id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(strata.selected).toBeNull();
        expect(renderer.selected).toBeNull();
        expect($('strataTable').querySelectorAll('[aria-current]')).toHaveLength(0);
    });

    it('shows a blocked pressing\'s reason in its row and in the panel', async () => {
        await openTable();
        await strata.drill('ra:m:70025');
        const blocked = strata.rows.find((row) => row.blocked === BLOCKED_REASON);
        expect(tableRow(blocked.id).querySelector('.strata-cell-blocked').textContent).toBe(BLOCKED_REASON);
        tableRow(blocked.id).querySelector('th').click();
        tableRow(blocked.id).click();
        expect($('strataSelection').querySelector('.strata-blocked').textContent).toBe(BLOCKED_REASON);
        expect($('strataSelection').textContent).not.toContain('Sync now');
    });

    it('filters to the items that cannot change state, with the count read out', async () => {
        await openTable();
        const checkbox = $('strataTableBlockedOnly');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
        const expected = strata.rows.filter((row) => row.blocked !== null).map((row) => row.id);
        expect(tableIds()).toEqual(expected);
        expect($('strataTableStatus').textContent).toBe(`${expected.length} of ${strata.rows.length} rows that cannot change state, in outline order.`);
        // The filter survives a redraw from the clocks.
        strata.setOnlyCollected(true);
        expect(tableIds().every((id) => expected.includes(id))).toBe(true);
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change'));
        expect(tableIds()).toHaveLength(strata.rows.length);
    });

    it('follows both clocks and the collector filter as the 3D view does', async () => {
        await openTable();
        const all = tableIds().length;
        strata.setBeforeYear(1995);
        expect(tableIds().length).toBeLessThan(all);
        expect(tableIds().sort()).toEqual(strata.view.entries.map((entry) => entry.id).sort());
        strata.setBeforeYear(null);
        expect(tableIds()).toHaveLength(all);
        strata.setOnlyCollected(true);
        expect(tableIds().length).toBeLessThan(all);
        strata.setOnlyCollected(false);
        const input = $('strataRecordedAsOf');
        input.value = String(Date.parse('2012-01-01T00:00:00Z'));
        input.dispatchEvent(new Event('input'));
        const group = strata.rows.find((row) => row.kind === 'pressingGroup');
        expect(tableRow(group.id).querySelector('.strata-cell-state').textContent).toBe('not known');
        expect($('strataSummary').textContent).toContain('States as recorded on 2012-01-01');
    });

    it('searches every entry, including one the 3D view folded away', async () => {
        await openTable();
        const folded = strata.rows.find((row) => !row.drawn && row.kind === 'pressing' && row.name);
        const found = await strata.focusSearch(folded.name);
        expect(found).toBe(folded.id);
        expect(strata.selected).toBe(folded.id);
        expect(document.activeElement).toBe(tableRow(folded.id));
        expect($('strataSelection').querySelector('.strata-selection-title').textContent).toBe(folded.name);
        expect(api.search).not.toHaveBeenCalled();
    });

    it('keeps the table selection in sync with a renderer selection', async () => {
        await openTable();
        await strata.show({ mode: 'strata' });
        renderers[0].select('m:70030');
        await strata.show({ mode: 'table' });
        expect(tableRow('m:70030').getAttribute('aria-current')).toBe('true');
        expect(tableRow('m:70030').tabIndex).toBe(0);
    });

    it('drops a folded selection when the 3D view returns, and keeps a drawn one', async () => {
        await openTable();
        const folded = strata.rows.find((row) => !row.drawn && row.kind === 'pressing');
        strata.selectRow(folded.id);
        await strata.show({ mode: 'strata' });
        expect(strata.selected).toBeNull();
        expect($('strataSelection').textContent).toContain('press ] to step through the credits');
        await strata.show({ mode: 'table' });
        const drawn = strata.rows.find((row) => row.drawn && row.kind === 'master');
        strata.selectRow(drawn.id);
        await strata.show({ mode: 'strata' });
        expect(strata.selected).toBe(drawn.id);
        expect(renderers[0].selected).toBe(drawn.id);
    });

    it('leaves the frame loop alone in table mode, and starts it for the 3D view', async () => {
        await openTable();
        strata.resume();
        strata.pause();
        expect(renderers).toHaveLength(0);
        await strata.show({ mode: 'strata' });
        strata.pause();
        strata.resume();
        expect(renderers[0].calls.slice(-2)).toEqual([['stop'], ['start']]);
        await strata.show({ mode: 'table' });
        expect(renderers[0].calls.at(-1)).toEqual(['stop']);
        strata.resume();
        expect(renderers[0].calls.at(-1)).toEqual(['stop']);
    });

    it('names each screen-reader region the table needs', async () => {
        await openTable();
        const table = $('strataTable').querySelector('table');
        expect($(table.getAttribute('aria-describedby')).textContent).toMatch(/PageUp moves to the row's parent/);
        expect(table.querySelector('caption').textContent).toMatch(/^Credits, masters, and pressings: \d+ rows/);
        expect($('strataTableStatus').getAttribute('role')).toBe('status');
        expect(document.querySelector('label:has(#strataTableBlockedOnly)').textContent).toContain('Only what cannot change state');
        expect(table.querySelectorAll('[style]')).toHaveLength(0);
        // The markup in index.html and the module agree on the help text.
        expect($('strataTableHelp').textContent).toBe(TABLE_HELP);
    });

    it('opens the table when the renderer cannot be built', async () => {
        strata.dispose();
        strata = new StrataExplore({
            api,
            auth: { isLoggedIn: () => true, getToken: () => 'jwt' },
            createRenderer: () => { throw new Error('WebGL is not available'); },
        });
        await openTable();
        expect(tableIds()).toHaveLength(strata.graph.entries.length);
        expect($('strataMessage').hidden).toBe(true);
        // The 3D view says why it draws nothing, and points to the table.
        await strata.show({ mode: 'strata' });
        expect($('strataMessage').hidden).toBe(false);
        expect($('strataMessage').textContent).toBe(NO_WEBGL_MESSAGE);
        expect($('strataStage').querySelector('canvas')).toBeNull();
        await strata.show({ mode: 'table' });
        expect($('strataMessage').hidden).toBe(true);
    });

    it('still loads the 3D view without WebGL, and the route\'s own answers come first', async () => {
        strata.dispose();
        strata = new StrataExplore({
            api,
            auth: { isLoggedIn: () => true, getToken: () => 'jwt' },
            createRenderer: () => { throw new Error('WebGL is not available'); },
        });
        strata.setArtist({ id: '9001', name: 'The Placeholder Band' });
        await strata.show({ mode: 'strata' });
        expect(api.getStrata).toHaveBeenCalledTimes(1);
        expect($('strataSummary').querySelector('.strata-summary-title').textContent).toBe('The Placeholder Band');
        expect($('strataMessage').textContent).toBe(NO_WEBGL_MESSAGE);
        // A 422 or a 504 is the answer for this artist whatever the browser can draw.
        strata.setArtist({ id: 'slow', name: 'Slow' });
        await vi.waitFor(() => expect($('strataMessage').textContent).toMatch(/took too long/));
        await strata.show({ mode: 'table' });
        expect($('strataMessage').textContent).toMatch(/took too long/);
    });
});

describe('initStrata', () => {
    afterEach(() => {
        document.body.textContent = '';
    });

    it('attaches the view to the app when the page has one, and toggles the shared scrubber', () => {
        expect(initStrata({ app: {} })).toBeNull();
        mountMarkup();
        const app = { timeline: { toggle: vi.fn() } };
        const strata = initStrata({ app });
        expect(app.strata).toBe(strata);
        strata.onToggleTimeline();
        expect(app.timeline.toggle).toHaveBeenCalled();
        expect(window.StrataInit).toBe(initStrata);
        strata.dispose();
    });
});
