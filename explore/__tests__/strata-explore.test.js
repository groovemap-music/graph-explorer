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
    MAX_ROOT_RELEASES,
    PAST_REASON,
    StrataExplore,
    applyClocks,
    blockedReason,
    describeCursor,
    discogsLinks,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'strata-route.json'), 'utf8'));
const INDEX = readFileSync(resolve(HERE, '..', 'static', 'index.html'), 'utf8');

// The route canonicalises a master or lane cursor to its release aggregate's id.
const canonical = (focus) => (focus === null ? null : focus.replace(/^m:/, 'ra:m:').replace(/^nm:/, 'ra:nm:'));
function recordedBody(focus, page = 0, signedIn = true) {
    const entry = RECORDED.responses.find((item) => item.query.focus === canonical(focus) && item.query.page === page && item.query.signed_in === signedIn);
    return entry ? structuredClone(entry.body) : null;
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
        findOwnedCopy: vi.fn(async () => 'copy-1'),
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
        panel.querySelector('[data-action="record-observation"]').click();
        const form = panel.querySelector('form.strata-observation');
        form.querySelector('select').value = 'grading';
        form.querySelector('input').value = '  VG+  ';
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() => expect($('strataActionStatus').textContent).toBe('Observation recorded.'));
        expect(api.findOwnedCopy).toHaveBeenCalledWith('jwt', '300083', { pageSize: 200, maxPages: 10 });
        expect(api.createObservation).toHaveBeenCalledWith('jwt', 'copy-1', { kind: 'grading', value: 'VG+', source: 'user' });
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
    });

    it('explains a missing copy, a failed sync, and an empty observation', async () => {
        await open();
        strata.selectNode('r:300083');
        const node = strata.byId.get('r:300083');
        expect(await strata.recordObservation(node, { kind: 'note', value: ' ' })).toBe(false);
        expect($('strataActionStatus').textContent).toMatch(/Write what you observed/);
        api.findOwnedCopy.mockResolvedValueOnce(null);
        expect(await strata.recordObservation(node, { kind: 'note', value: 'x' })).toBe(false);
        expect($('strataActionStatus').textContent).toMatch(/no GrooveMap id yet/);
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
        api.search.mockResolvedValueOnce({ results: [{ type: 'release', id: '300036', name: 'x' }] });
        expect(await strata.focusSearch('unmatched pressing')).toBe('r:300036');
        api.search.mockResolvedValueOnce(null);
        expect(await strata.focusSearch('nothing at all')).toBeNull();
        expect($('strataMessage').textContent).toMatch(/A pressing opens through its master/);
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
