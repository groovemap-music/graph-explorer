/**
 * Discography Strata in Explore: concept A of ADR 0016, an artist's credits, masters, and releases
 * on three planes, opened from the Explore pane's view toggle (graph / strata / table).
 *
 * This module is the integration. It fetches `GET /api/explore/strata`, adapts and lays it out
 * (strata-layout.js), hands the layout to the renderer (strata-renderer.js), and owns everything
 * the renderer leaves to its caller:
 *   - drill-down: opening an aggregate is a new request for its cursor (`focus=<id>&page=<n>`),
 *     because the route pages server-side and an aggregate carries no member list;
 *   - both clocks: valid time is the Explore pane's existing year scrubber (`before_year`), and
 *     transaction time is "Recorded as of", over the collector's own Discogs `date_added`;
 *   - search-to-focus and the "only what I collect" filter (gm-design-on0x Recommendation 6);
 *   - keyboard navigation of planes and nodes, bound to the renderer's camera, select, and solo
 *     (ADR 0016 section 1, gm-design-on0x section "Accessibility");
 *   - the table view, the same planes, lanes, aggregates, and server page as rows (strata-table.js),
 *     which needs no WebGL: the renderer is built only when the 3D view is first shown;
 *   - the panel, whose actions are only "Open on Discogs", "Sync now", and "Record an observation"
 *     on an owned copy. GrooveMap never writes a wantlist or a collection; every state change is
 *     observed at Discogs sync (strata-collector.js).
 *
 * The decisions are exported pure functions so Vitest covers them without a GPU. The DOM is built
 * with createElement and textContent only, and styled through classes in strata.css, so the
 * `style-src 'self'` policy the renderer holds still holds here.
 */

import { StrataRenderer } from './strata-renderer.js';
import { adaptStrataPayload, layoutStrata } from './strata-layout.js';
import { COLLECTOR_STATES, CollectorAction, canPerform, hasOwn, hasWant, stateFromFlags, stateLabel } from './strata-collector.js';
import { BLOCKED_REASON, blockedReason, displayLabel } from './strata-scene.js';
import { StrataTable, buildTableRows } from './strata-table.js';

// The blocked-pressing words live with the scene logic so the table can use them without this
// module, which imports the renderer.
export { BLOCKED_REASON, blockedReason };

/** The route's default budget, the one the view draws legibly (gm-design-on0x Recommendation 2). */
export const DEFAULT_BUDGET = '3/12/16';
/** The route refuses a root above this many releases with a 422 (catalog-api api/README.md). */
export const MAX_ROOT_RELEASES = 134051;
/** Observation kinds the panel offers. The route takes any kind; these are the ones ADR 0009 names. */
export const OBSERVATION_KINDS = Object.freeze([
    Object.freeze({ id: 'matrix', label: 'Matrix / runout' }),
    Object.freeze({ id: 'grading', label: 'Grading' }),
    Object.freeze({ id: 'purchase_price', label: 'Purchase price' }),
    Object.freeze({ id: 'note', label: 'Note' }),
]);
const PLANE_NAMES = Object.freeze(['Credit', 'Master', 'Release']);
const DISCOGS = 'https://www.discogs.com';
const DAY_MS = 86_400_000;

export const PAST_REASON = 'History is read-only. Move "Recorded as of" to now to record an observation.';
/** Why "Record an observation" is off when the route sent no copy ids at all (a degraded read). */
export const COPY_UNREAD_REASON = 'GrooveMap could not read the id of your copy just now. Reload the view to try again.';
/** Why it is off when the route sent an empty list: the sync has not minted a copy id yet. */
export const NO_COPY_REASON = 'Your copy has no GrooveMap id yet. Run "Sync now", then reload the view.';

// ---------------------------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------------------------

/**
 * What the view says when the route answers with an error. The 422 and 504 are expected answers
 * for large roots and slow reads, so they get their own words rather than a generic failure.
 */
export function strataErrorMessage({ status, body = null, artistName = null } = {}) {
    const who = artistName || 'This artist';
    if (status === 422 && body && Number.isFinite(body.releases)) {
        const ceiling = (Number.isFinite(body.max_releases) ? body.max_releases : MAX_ROOT_RELEASES).toLocaleString('en-US');
        return `${who} has ${body.releases.toLocaleString('en-US')} releases. Discography Strata draws artists with up to ${ceiling}, so it cannot open this one. The graph view still can.`;
    }
    if (status === 422) return 'The strata view could not read that request.';
    if (status === 504) return 'The strata read took too long and was stopped. Try again in a moment.';
    if (status === 404) return body && typeof body.error === 'string' && body.error.startsWith('focus') ? 'That part of the discography is no longer there. Go back to the overview.' : `${who} is not in the catalog.`;
    if (status === 400) return body && typeof body.error === 'string' ? body.error : 'The strata view sent a request the server refused.';
    if (status === 429) return 'Too many strata requests in a minute. Wait a moment and try again.';
    if (status === 503) return 'Discography Strata is not available right now.';
    return 'Discography Strata could not be loaded. Try again.';
}

// ---------------------------------------------------------------------------------------------
// The two clocks and the collector filter.
// ---------------------------------------------------------------------------------------------

const stateful = (state) => state !== null && state !== 'none';

function statesHaveStateful(states) {
    return !!states && Object.entries(states).some(([state, count]) => state !== 'none' && count > 0);
}

// The server's roll-up for a master or credit: owned if any release is owned, else wanted.
function rollupOf(states) {
    if (states.some((state) => state && hasOwn(state))) return 'owned';
    return states.some((state) => state && hasWant(state)) ? 'wanted' : 'none';
}

function recordedBy(at, asOf) {
    // Discogs may omit `date_added`. An edge without one is observed but undated, so it counts at
    // every point of the transaction axis rather than vanishing from it.
    return at === null || at === undefined || Date.parse(at) <= asOf;
}

/** A release's collector state as it was recorded at `asOf` (ms since the epoch). */
export function stateAsOf(entry, asOf) {
    if (entry.state === null || asOf === null) return entry.state;
    const recorded = entry.recordedAt || { owned: null, wanted: null };
    return stateFromFlags({
        wanted: hasWant(entry.state) && recordedBy(recorded.wanted, asOf),
        owned: hasOwn(entry.state) && recordedBy(recorded.owned, asOf),
    });
}

function startYear(entry) {
    return entry.agg || entry.level === 0 ? entry.y0 : entry.year;
}

/**
 * Apply both clocks and the collector filter to an adapted graph, before layout.
 *
 * - Valid time (`beforeYear`): an entry released after the year is hidden, and so is everything
 *   under it. Undated entries stay, in the undated strip. The root's credit always stays.
 * - Transaction time (`recordedAsOf`, ms since the epoch, or null for now): each drawn release
 *   shows the state its recorded `date_added` gives at that time. Aggregate counts are the current
 *   ones and say nothing about the past, so in the past an aggregate is drawn state-less, and a
 *   master or credit rolls up from its drawn releases: owned or wanted when one of them was, none
 *   when every release under it is drawn and none was, and unknown otherwise.
 * - `onlyCollected`: only entries holding a wanted or owned release stay, with their ancestors.
 *
 * @returns {object} a graph of the same shape for layoutStrata, plus `past` and `hidden`
 */
export function applyClocks(graph, { beforeYear = null, recordedAsOf = null, onlyCollected = false } = {}) {
    const visible = new Map();
    for (const entry of graph.entries) {
        const parentShown = entry.level === 0 || visible.has(entry.parent);
        const start = startYear(entry);
        const inTime = entry.id === graph.rootCredit || beforeYear === null || start === null || start <= beforeYear;
        if (parentShown && inTime) visible.set(entry.id, { ...entry });
    }
    const past = recordedAsOf !== null;
    const children = new Map();
    for (const entry of visible.values()) {
        if (entry.parent === null) continue;
        if (!children.has(entry.parent)) children.set(entry.parent, []);
        children.get(entry.parent).push(entry);
    }
    if (past) {
        // Bottom-up: releases first, then their holders.
        const drawn = new Map();
        for (const level of [2, 1, 0]) {
            for (const entry of visible.values()) {
                if (entry.level !== level) continue;
                if (level === 2 && !entry.agg) {
                    entry.state = stateAsOf(entry, recordedAsOf);
                    drawn.set(entry.id, { states: entry.state === null ? [] : [entry.state], releases: 1, exact: true });
                    continue;
                }
                const under = (children.get(entry.id) || []).map((child) => drawn.get(child.id) || { states: [], releases: 0, exact: false });
                const states = under.flatMap((item) => item.states);
                const releases = under.reduce((sum, item) => sum + item.releases, 0);
                const exact = under.length > 0 && under.every((item) => item.exact) && releases === entry.releases;
                drawn.set(entry.id, { states, releases, exact });
                entry.states = null;
                if (entry.agg && !entry.lane) entry.state = null;
                else if (states.some(stateful)) entry.state = rollupOf(states);
                else entry.state = exact ? 'none' : null;
            }
        }
    }
    let kept = visible;
    if (onlyCollected) {
        const collected = new Set();
        for (const entry of visible.values()) {
            if (!(stateful(entry.state) || statesHaveStateful(entry.states))) continue;
            for (let at = entry; at && !collected.has(at.id); at = at.parent === null ? null : visible.get(at.parent)) collected.add(at.id);
        }
        if (graph.rootCredit !== null && visible.has(graph.rootCredit)) collected.add(graph.rootCredit);
        kept = new Map([...visible].filter(([id]) => collected.has(id)));
    }
    const entries = [...kept.values()];
    return {
        ...graph,
        entries,
        edges: (graph.edges || []).filter((edge) => kept.has(edge.a) && kept.has(edge.b)),
        past,
        hidden: graph.entries.length - entries.length,
    };
}

/**
 * Paint the states a clock-applied view shows onto a layout made from today's states. The layout
 * folds by collector state, so laying out the past view itself would move nodes as the
 * transaction clock moves; laying out today's and repainting keeps every node in place while the
 * colors change. A count node the layout folded takes the past states of the releases it holds.
 */
export function paintStates(layout, view) {
    if (!view.past) return layout;
    const byId = new Map(view.entries.map((entry) => [entry.id, entry]));
    const nodes = layout.nodes.map((node) => {
        if (node.origin === 'payload') {
            const entry = byId.get(node.id);
            return { ...node, state: entry.state, states: entry.states ? { ...entry.states } : null };
        }
        let states = null;
        for (const id of node.members) {
            const entry = byId.get(id);
            if (!entry || entry.level !== 2 || entry.agg || entry.state === null) continue;
            states = states || {};
            states[entry.state] = (states[entry.state] || 0) + 1;
        }
        return { ...node, state: null, states };
    });
    return { ...layout, nodes };
}

/** The span of recorded `date_added` in a graph, as day-aligned ms, or null when there is none. */
export function recordedSpan(graph) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const entry of graph.entries) {
        for (const at of [entry.recordedAt?.owned, entry.recordedAt?.wanted]) {
            const ms = typeof at === 'string' ? Date.parse(at) : NaN;
            if (!Number.isFinite(ms)) continue;
            lo = Math.min(lo, ms);
            hi = Math.max(hi, ms);
        }
    }
    return Number.isFinite(lo) ? { from: Math.floor(lo / DAY_MS) * DAY_MS, to: Math.floor(hi / DAY_MS) * DAY_MS } : null;
}

// ---------------------------------------------------------------------------------------------
// The panel's actions.
// ---------------------------------------------------------------------------------------------

/** Where "Open on Discogs" goes for a node, or null when it has no Discogs page. */
export function discogsLinks(node) {
    if (!node || node.agg || node.lane) return [];
    if (node.level === 2) return node.provider === 'discogs' && node.releaseId ? [{ label: 'Open on Discogs', href: `${DISCOGS}/release/${encodeURIComponent(node.releaseId)}` }] : [];
    if (node.level === 1) return node.masterId ? [{ label: 'Open on Discogs', href: `${DISCOGS}/master/${encodeURIComponent(node.masterId)}` }] : [];
    const artists = node.artists || [];
    return artists.map((artist) => ({
        label: artists.length > 1 ? `Open ${artist.name || artist.id} on Discogs` : 'Open on Discogs',
        href: `${DISCOGS}/artist/${encodeURIComponent(artist.id)}`,
    }));
}

/** The copy an observation is recorded against: the caller's earliest-acquired copy, or null. */
export function copyIdOf(node) {
    const [first] = node?.ownedCopyIds || [];
    return first ?? null;
}

/**
 * What a selected node offers, following the collector machine (strata-collector.js): opening a
 * cursor, "Open on Discogs", and on a Discogs release for a signed-in collector "Sync now" and,
 * for an owned copy only, "Record an observation". A MusicBrainz-only release offers no collector
 * action. Nothing here writes a wantlist or a collection.
 *
 * @returns {Array<{id: string, label: string, enabled: boolean, reason?: string, href?: string,
 *                  cursor?: string}>}
 */
export function nodeActions(node, { signedIn = false, past = false } = {}) {
    if (!node) return [];
    const actions = [];
    if (node.cursor) {
        const label = node.level === 1 && !node.agg ? 'Show its pressings' : node.level === 0 ? 'Show these credits' : node.lane ? 'Show these releases' : node.level === 1 ? 'Show these masters' : 'Show these pressings';
        actions.push({ id: 'open', label, enabled: true, cursor: node.cursor });
    } else if (node.origin === 'fold' && node.level === 2 && node.parent && /^(m|nm):/.test(node.parent)) {
        // Folded here so the plane fits: its master or lane is the cursor that pages it.
        actions.push({ id: 'open', label: 'Show these pressings', enabled: true, cursor: node.parent });
    }
    for (const link of discogsLinks(node)) actions.push({ id: 'discogs', label: link.label, enabled: true, href: link.href });
    if (node.level !== 2 || node.agg || node.provider !== 'discogs' || !signedIn || !node.state) return actions;
    if (canPerform(node.state, CollectorAction.SYNC_NOW)) actions.push({ id: CollectorAction.SYNC_NOW, label: 'Sync now', enabled: true });
    if (canPerform(node.state, CollectorAction.RECORD_OBSERVATION)) {
        const record = { id: CollectorAction.RECORD_OBSERVATION, label: 'Record an observation' };
        // The route names the copy on the node (earliest acquired first). Without the list there is
        // nothing to record against, and the collection is never scanned to find one.
        if (past) actions.push({ ...record, enabled: false, reason: PAST_REASON });
        else if (!copyIdOf(node)) actions.push({ ...record, enabled: false, reason: node.ownedCopyIds ? NO_COPY_REASON : COPY_UNREAD_REASON });
        else actions.push({ ...record, enabled: true });
    }
    return actions;
}

/** A cursor in words, for the drill-down trail. */
export function describeCursor(cursor, byId = new Map()) {
    if (cursor === 'c:other') return 'other credits';
    let match = /^ma:(c:[^:]+):([^:]+)$/.exec(cursor);
    if (match) return `${byId.get(match[1])?.label || 'credit'} masters${match[2] === 'all' ? '' : match[2] === 'undated' ? ' without a year' : ` from the ${match[2]}`}`;
    match = /^(?:ra:)?m:(.+)$/.exec(cursor);
    if (match) return `pressings of ${byId.get(`m:${match[1]}`)?.label || `master ${match[1]}`}`;
    match = /^(?:ra:)?nm:(c:[^:]+)(?::([^:]+))?$/.exec(cursor);
    if (match) return `${byId.get(match[1])?.label || 'credit'} releases without a master${!match[2] ? '' : match[2] === 'undated' ? ', no year' : `, ${match[2]}`}`;
    return cursor;
}

// ---------------------------------------------------------------------------------------------
// Keyboard and search.
// ---------------------------------------------------------------------------------------------

export const KEYBOARD_HELP = 'Arrow keys orbit and tilt, plus and minus zoom, 0 resets the camera. 1, 2, and 3 show one plane, and 1, 2, or 3 again shows all. PageUp and PageDown move to the parent or first child, [ and ] move along a plane, Enter opens a count node, and Escape clears the selection.';

function planeOrder(nodes, level) {
    return nodes.filter((node) => node.level === level).sort((a, b) => a.z - b.z || a.x - b.x);
}

/**
 * The command a key means in the strata view, or null when the key is not the view's. The spike's
 * scheme (gm-design-on0x web/ui.mjs) plus plane solo on 1 to 3.
 *
 * @param {{key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
 * @param {{nodes: object[], selected: string|null, solo: number|null}} view
 */
export function strataKeyCommand(event, { nodes = [], selected = null, solo = null } = {}) {
    if (event.altKey || event.ctrlKey || event.metaKey) return null;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const current = selected === null ? null : byId.get(selected) || null;
    switch (event.key) {
        case 'ArrowLeft': return { type: 'orbit', radians: 0.12 };
        case 'ArrowRight': return { type: 'orbit', radians: -0.12 };
        case 'ArrowUp': return { type: 'tilt', radians: 0.08 };
        case 'ArrowDown': return { type: 'tilt', radians: -0.08 };
        case '+':
        case '=': return { type: 'zoom', direction: 'in' };
        case '-':
        case '_': return { type: 'zoom', direction: 'out' };
        case '0':
        case 'Home': return { type: 'reset' };
        case '1':
        case '2':
        case '3': {
            const level = Number(event.key) - 1;
            return { type: 'solo', level: solo === level ? null : level };
        }
        case 'PageUp': {
            const target = current && current.parent ? current.parent : planeOrder(nodes, 0)[0]?.id;
            return target ? { type: 'select', id: target } : null;
        }
        case 'PageDown': {
            const target = current ? current.children[0] : planeOrder(nodes, 0)[0]?.id;
            return target ? { type: 'select', id: target } : null;
        }
        case '[':
        case ']': {
            const list = planeOrder(nodes, current ? current.level : solo ?? 0);
            if (!list.length) return null;
            const at = current ? list.findIndex((node) => node.id === current.id) : -1;
            const step = event.key === ']' ? 1 : list.length - 1;
            return { type: 'select', id: list[at < 0 ? (event.key === ']' ? 0 : list.length - 1) : (at + step) % list.length].id };
        }
        case 'Enter': return current && current.cursor ? { type: 'open', cursor: current.cursor } : null;
        case 'Escape': return current ? { type: 'select', id: null } : solo !== null ? { type: 'solo', level: null } : null;
        default: return null;
    }
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The strata cursor and node id a search hit names: `m:<id>` for a master, `r:<id>` for a Discogs
 * pressing, `mb:<mbid>` for a MusicBrainz-only one. Null for any other kind of hit.
 */
export function hitNodeId(hit) {
    if (!hit || hit.id === undefined || hit.id === null || hit.id === '') return null;
    const id = String(hit.id);
    if (hit.type === 'master') return `m:${id}`;
    if (hit.type !== 'release') return null;
    return MBID.test(id) ? `mb:${id.toLowerCase()}` : `r:${id}`;
}

function searchText(node) {
    if (node.level === 0 && node.artists) return node.artists.map((artist) => artist.name || '').join(' ');
    return node.label || '';
}

/** Drawn nodes whose title or artist names match, best first: exact, then prefix, then substring. */
export function searchDrawn(nodes, query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const ranked = [];
    for (const node of nodes) {
        if (node.agg || node.lane) continue;
        const text = searchText(node).toLowerCase();
        const rank = text === q ? 0 : text.startsWith(q) ? 1 : text.includes(q) ? 2 : null;
        if (rank !== null) ranked.push({ node, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || b.node.level - a.node.level || (a.node.id < b.node.id ? -1 : 1));
    return ranked.map((item) => item.node);
}

// ---------------------------------------------------------------------------------------------
// The view.
// ---------------------------------------------------------------------------------------------

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function formatDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function spanText(node) {
    if (!node.agg && node.year !== null) return String(node.year);
    if (node.y0 === null) return 'no year';
    return node.y0 === node.y1 ? String(node.y0) : `${node.y0}–${node.y1}`;
}

/**
 * The strata view in the Explore pane. `elements` maps each role to its element (see index.html);
 * every other dependency is injectable for tests.
 */
export class StrataExplore {
    constructor({
        doc = globalThis.document,
        api = globalThis.apiClient,
        auth = globalThis.authManager,
        createRenderer = (stage) => new StrataRenderer(stage),
        now = () => Date.now(),
        onToggleTimeline = null,
        observeTheme = true,
    } = {}) {
        this.doc = doc;
        this.api = api;
        this.auth = auth;
        this.createRenderer = createRenderer;
        this.now = now;
        this.onToggleTimeline = onToggleTimeline;
        const $ = (id) => doc.getElementById(id);
        this.ui = {
            view: $('strataView'),
            stage: $('strataStage'),
            loading: $('strataLoading'),
            message: $('strataMessage'),
            summary: $('strataSummary'),
            trail: $('strataTrail'),
            selection: $('strataSelection'),
            searchForm: $('strataSearchForm'),
            searchInput: $('strataSearchInput'),
            onlyCollected: $('strataOnlyCollected'),
            validTime: $('strataValidTimeBtn'),
            validTimeLabel: $('strataValidTimeLabel'),
            recorded: $('strataRecordedAsOf'),
            recordedLabel: $('strataRecordedAsOfLabel'),
            reset: $('strataResetCameraBtn'),
            planes: [...doc.querySelectorAll('[data-strata-solo]')],
            stageOnly: [...doc.querySelectorAll('[data-strata-only="stage"]')],
            stageHelp: $('strataKeyHelp'),
            tableWrap: $('strataTableWrap'),
            table: $('strataTable'),
            tableBlockedOnly: $('strataTableBlockedOnly'),
            tableStatus: $('strataTableStatus'),
        };
        this.mode = 'strata';
        this.rows = [];
        this.rowById = new Map();
        this.table = this.ui.table
            ? new StrataTable({
                doc,
                host: this.ui.table,
                onSelect: (id) => this.selectRow(id),
                onOpen: (cursor) => this.drill(cursor),
                onStatus: (text) => this.setTableStatus(text),
            })
            : null;
        this.artist = null;
        this.cursor = { focus: null, page: 0 };
        this.trail = [];
        this.graph = null;
        this.view = null;
        this.layout = null;
        this.selected = null;
        this.beforeYear = null;
        this.recordedAsOf = null;
        this.onlyCollected = false;
        this.axisHint = null;
        this.renderer = null;
        this.active = false;
        this.requestId = 0;
        this.bind();
        if (observeTheme && typeof MutationObserver === 'function') {
            this.themeObserver = new MutationObserver(() => this.refreshColors());
            this.themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
        }
    }

    bind() {
        const { ui } = this;
        ui.searchForm?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.focusSearch(ui.searchInput.value);
        });
        ui.onlyCollected?.addEventListener('change', () => this.setOnlyCollected(ui.onlyCollected.checked));
        ui.validTime?.addEventListener('click', () => this.onToggleTimeline?.());
        ui.recorded?.addEventListener('input', () => {
            const value = Number(ui.recorded.value);
            this.setRecordedAsOf(value >= Number(ui.recorded.max) ? null : value);
        });
        ui.reset?.addEventListener('click', () => this.renderer?.resetCamera());
        for (const button of ui.planes) {
            button.addEventListener('click', () => this.renderer?.solo(button.dataset.strataSolo === '' ? null : Number(button.dataset.strataSolo)));
        }
        ui.stage?.addEventListener('keydown', (event) => this.handleKey(event));
        ui.tableBlockedOnly?.addEventListener('change', () => this.table?.setFilter({ blockedOnly: ui.tableBlockedOnly.checked }));
    }

    get signedIn() {
        return !!this.auth?.isLoggedIn?.();
    }

    /** The artist the view opens on: `{id, name}` from Explore's center node, or null. */
    setArtist(artist) {
        const next = artist && artist.id != null ? { id: String(artist.id), name: artist.name || null } : null;
        if (next?.id === this.artist?.id) return;
        this.artist = next;
        this.cursor = { focus: null, page: 0 };
        this.trail = [];
        this.graph = null;
        this.selected = null;
        this.axisHint = null;
        this.recordedAsOf = null;
        if (this.active && next) this.load();
    }

    /**
     * Show the view as the 3D strata or as the table. The table builds no renderer, so it opens
     * where WebGL does not.
     */
    show({ mode = 'strata' } = {}) {
        this.active = true;
        this.setMode(mode);
        this.ui.view?.classList.remove('hidden');
        if (this.mode === 'strata') this.startRenderer();
        if (this.artist && !this.graph) return this.load();
        return Promise.resolve();
    }

    startRenderer() {
        if (!this.renderer && this.ui.stage) {
            this.renderer = this.createRenderer(this.ui.stage);
            this.renderer.addEventListener('select', (event) => this.onSelect(event.detail.id));
            this.renderer.addEventListener('solo', (event) => this.onSolo(event.detail.level));
            // A view loaded in the table before the 3D view was first shown.
            if (this.layout) this.renderer.setLayout(this.layout);
        }
        this.renderer?.start();
        this.renderer?.resize?.();
        this.syncRendererSelection();
    }

    setMode(mode) {
        const next = mode === 'table' ? 'table' : 'strata';
        const { ui } = this;
        this.mode = next;
        const table = next === 'table';
        ui.view?.classList.toggle('strata-view--table', table);
        if (ui.stage) ui.stage.hidden = table;
        if (ui.stageHelp) ui.stageHelp.hidden = table;
        if (ui.tableWrap) ui.tableWrap.hidden = !table;
        for (const item of ui.stageOnly) item.hidden = table;
        if (table) this.renderer?.stop();
        else if (this.selected && !this.byId?.has(this.selected)) this.selected = null;
        if (this.graph) {
            this.renderTable();
            this.renderSelection();
        }
    }

    hide() {
        this.active = false;
        this.ui.view?.classList.add('hidden');
        this.renderer?.stop();
    }

    /** Stop the frame loop while the Explore pane is hidden, and start it again when it is back. */
    pause() {
        this.renderer?.stop();
    }

    resume() {
        if (this.active && this.mode === 'strata') this.renderer?.start();
    }

    refreshColors() {
        this.renderer?.refreshColors();
        this.renderSelection();
    }

    dispose() {
        this.themeObserver?.disconnect();
        this.renderer?.dispose();
        this.renderer = null;
    }

    // -- Fetching ---------------------------------------------------------------------------

    async fetchView({ focus = null, page = 0 } = {}) {
        const token = this.signedIn ? this.auth.getToken() : null;
        return this.api.getStrata(this.artist.id, { focus, page, budget: DEFAULT_BUDGET }, token);
    }

    /**
     * Load the overview, or a page of a cursor. Returns whether the view changed. `from` is the
     * cursor being left: it goes on the trail when the load succeeds, before the view is drawn, so
     * the trail's first button already reads "Back" on the first drill.
     */
    async load({ focus = null, page = 0 } = {}, { quiet = false, from = null } = {}) {
        if (!this.artist) return false;
        const requestId = ++this.requestId;
        this.setLoading(true);
        let result;
        try {
            result = await this.fetchView({ focus, page });
        } catch {
            result = { ok: false, status: 0, body: null };
        }
        if (requestId !== this.requestId) return false;
        this.setLoading(false);
        if (!result || !result.ok) {
            if (!quiet) this.showMessage(strataErrorMessage({ status: result?.status, body: result?.body, artistName: this.artist.name }));
            return false;
        }
        let graph;
        try {
            graph = adaptStrataPayload(result.body);
        } catch (error) {
            this.showMessage(`The strata response could not be read: ${error.message}`);
            return false;
        }
        this.showMessage(null);
        this.graph = graph;
        if (from) this.trail.push(from);
        this.cursor = { focus: graph.focus ? graph.focus.id : null, page: graph.focus ? graph.focus.page : 0 };
        this.render();
        return true;
    }

    /** Open a cursor: an aggregate, a lane, or a master. The current view goes on the trail. */
    async drill(cursor) {
        return this.load({ focus: cursor, page: 0 }, { from: { ...this.cursor } });
    }

    /** Move through the focused cursor's pages. The route wraps them. */
    async turnPage(delta) {
        const focus = this.graph?.focus;
        if (!focus) return false;
        return this.load({ focus: focus.id, page: (((focus.page + delta) % focus.pages) + focus.pages) % focus.pages });
    }

    async back() {
        const previous = this.trail.pop() || { focus: null, page: 0 };
        return this.load(previous);
    }

    // -- Clocks and filter ------------------------------------------------------------------

    setBeforeYear(year) {
        this.beforeYear = Number.isFinite(year) ? year : null;
        if (this.ui.validTimeLabel) this.ui.validTimeLabel.textContent = this.beforeYear === null ? 'All' : `to ${this.beforeYear}`;
        this.render();
    }

    setRecordedAsOf(ms) {
        this.recordedAsOf = Number.isFinite(ms) ? ms : null;
        this.render();
    }

    setOnlyCollected(on) {
        this.onlyCollected = !!on;
        if (this.ui.onlyCollected) this.ui.onlyCollected.checked = this.onlyCollected;
        this.render();
    }

    // -- Drawing ----------------------------------------------------------------------------

    render() {
        if (!this.graph) return;
        this.view = applyClocks(this.graph, { beforeYear: this.beforeYear, recordedAsOf: this.recordedAsOf, onlyCollected: this.onlyCollected });
        const today = new Map(this.graph.entries.map((entry) => [entry.id, entry]));
        const steady = { ...this.view, entries: this.view.entries.map((entry) => ({ ...entry, state: today.get(entry.id).state, states: today.get(entry.id).states })) };
        this.layout = paintStates(layoutStrata(steady, { selected: this.selected, axis: this.axisHint }), this.view);
        // Keep the year axis steady while the clocks and pages move.
        if (!this.axisHint) this.axisHint = { y0: this.layout.axis.y0, y1: this.layout.axis.y1 };
        this.byId = new Map(this.layout.nodes.map((node) => [node.id, node]));
        this.rows = buildTableRows(this.view, this.layout, { signedIn: this.graph.signedIn, openAction: (node) => nodeActions(node).find((action) => action.id === 'open') ?? null });
        this.rowById = new Map(this.rows.map((row) => [row.id, row]));
        if (this.selected && !this.nodeFor(this.selected)) this.selected = null;
        this.renderer?.setLayout(this.layout);
        this.syncRendererSelection();
        this.renderTable();
        this.renderControls();
        this.renderSummary();
        this.renderTrail();
        this.renderSelection();
    }

    /**
     * The node the panel describes for an id: the one the layout drew, or, in the table, an entry
     * the layout folded into a count node, which has no node of its own.
     */
    nodeFor(id) {
        return this.byId?.get(id) ?? this.rowById.get(id)?.node ?? null;
    }

    // The renderer knows drawn nodes only; a folded entry selected in the table is not one.
    syncRendererSelection() {
        if (!this.renderer) return;
        if (this.selected && this.byId?.has(this.selected)) this.renderer.select(this.selected);
    }

    renderTable() {
        if (!this.table || this.mode !== 'table') return;
        this.table.setRows(this.rows, { selected: this.selected });
    }

    setTableStatus(text) {
        if (this.ui.tableStatus) this.ui.tableStatus.textContent = text;
    }

    renderControls() {
        const { ui, graph } = this;
        const signedIn = graph.signedIn;
        if (ui.onlyCollected) {
            ui.onlyCollected.disabled = !signedIn;
            ui.onlyCollected.title = signedIn ? '' : 'Sign in to see what you collect';
        }
        if (ui.recorded) {
            const span = signedIn ? recordedSpan(graph) : null;
            const today = Math.floor(this.now() / DAY_MS) * DAY_MS;
            ui.recorded.disabled = !span;
            ui.recorded.min = String(span ? Math.min(span.from, today) : today);
            ui.recorded.max = String(today);
            ui.recorded.step = String(DAY_MS);
            ui.recorded.value = String(this.recordedAsOf ?? today);
            ui.recordedLabel.textContent = this.recordedAsOf === null ? 'now' : formatDate(this.recordedAsOf);
        }
    }

    renderSummary() {
        const { doc, graph, view } = this;
        const box = this.ui.summary;
        if (!box) return;
        const title = el(doc, 'h3', 'strata-summary-title', graph.root?.name || this.artist?.name || 'Discography');
        const parts = [];
        const t = graph.totals;
        if (t) {
            parts.push(`${t.credits} credits · ${t.masters} masters · ${t.releases} releases`);
            const notes = [];
            if (t.masterlessReleases) notes.push(`${t.masterlessReleases} without a master`);
            if (t.undatedReleases) notes.push(`${t.undatedReleases} undated`);
            if (t.musicbrainzReleases) notes.push(`${t.musicbrainzReleases} MusicBrainz-only`);
            if (notes.length) parts.push(notes.join(' · '));
        }
        if (!graph.signedIn) parts.push('Sign in to see what you want and own.');
        if (view.past) parts.push(`States as recorded on ${formatDate(this.recordedAsOf)}. Counts in folded nodes are today's, so those are drawn without a state.`);
        if (this.beforeYear !== null) parts.push(`Releases up to ${this.beforeYear}.`);
        if (view.hidden) parts.push(`${view.hidden} of ${graph.entries.length} drawn entries hidden by the filters.`);
        box.replaceChildren(title, ...parts.map((text) => el(doc, 'p', 'strata-summary-line', text)));
    }

    renderTrail() {
        const { doc, graph } = this;
        const box = this.ui.trail;
        if (!box) return;
        const items = [];
        const byEntry = new Map(graph.entries.map((entry) => [entry.id, entry]));
        if (graph.focus || this.trail.length) {
            const back = el(doc, 'button', 'strata-trail-btn', this.trail.length ? 'Back' : 'Overview');
            back.type = 'button';
            back.addEventListener('click', () => this.back());
            items.push(back);
        }
        if (graph.focus) {
            const { focus } = graph;
            items.push(el(doc, 'span', 'strata-trail-label', `${describeCursor(focus.id, byEntry)}: page ${focus.page + 1} of ${focus.pages} (${focus.members} in all)`));
            if (focus.pages > 1) {
                for (const [label, delta] of [['Previous page', -1], ['Next page', 1]]) {
                    const button = el(doc, 'button', 'strata-trail-btn', label);
                    button.type = 'button';
                    button.addEventListener('click', () => this.turnPage(delta));
                    items.push(button);
                }
            }
        }
        box.replaceChildren(...items);
        box.hidden = !items.length;
    }

    renderSelection() {
        const { doc } = this;
        const box = this.ui.selection;
        if (!box || !this.layout) return;
        const node = this.selected ? this.nodeFor(this.selected) : null;
        if (!node) {
            box.replaceChildren(
                el(doc, 'p', 'strata-hint', this.mode === 'table' ? 'Select a row, or use the keyboard: focus a row and press Space to describe it here.' : 'Select a node, or use the keyboard: focus the view and press ] to step through the credits.'),
                el(doc, 'p', 'strata-hint', 'Red-ringed pressings exist only in MusicBrainz and have no collector state.'),
                this.legend(),
            );
            return;
        }
        const parts = [el(doc, 'h4', 'strata-selection-title', displayLabel(node)), el(doc, 'p', 'strata-selection-plane', `${PLANE_NAMES[node.level]}${node.agg ? ' group' : ''} · ${spanText(node)}`)];
        const facts = [];
        if (node.agg || node.level < 2) facts.push(`${node.releases} release${node.releases === 1 ? '' : 's'}`);
        if (node.undatedReleases && (node.agg || node.level < 2)) facts.push(`${node.undatedReleases} undated`);
        if (node.musicbrainzReleases && (node.agg || node.level < 2)) facts.push(`${node.musicbrainzReleases} MusicBrainz-only`);
        if (node.yearSource === 'master' && node.level === 2) facts.push("year from its master");
        if (facts.length) parts.push(el(doc, 'p', 'strata-selection-facts', facts.join(' · ')));
        if (node.state && COLLECTOR_STATES.includes(node.state)) {
            const state = el(doc, 'p', `strata-state strata-state--${node.state}`, stateLabel(node.state));
            parts.push(state);
            const at = node.recordedAt;
            if (at && node.level === 2) {
                const dates = [];
                if (hasOwn(node.state) || at.owned) dates.push(`owned since ${at.owned ? at.owned.slice(0, 10) : 'a date Discogs did not record'}`);
                if (hasWant(node.state) || at.wanted) dates.push(`wanted since ${at.wanted ? at.wanted.slice(0, 10) : 'a date Discogs did not record'}`);
                if (dates.length) parts.push(el(doc, 'p', 'strata-selection-facts', `Recorded at Discogs: ${dates.join(', ')}`));
            }
        } else if (node.states && statesHaveStateful(node.states)) {
            const counts = Object.entries(node.states).filter(([state, count]) => state !== 'none' && count > 0).map(([state, count]) => `${count} ${stateLabel(state)}`);
            parts.push(el(doc, 'p', 'strata-selection-facts', counts.join(' · ')));
        }
        const reason = blockedReason(node);
        if (reason) parts.push(el(doc, 'p', 'strata-blocked', reason));
        const actions = el(doc, 'div', 'strata-actions');
        for (const action of nodeActions(node, { signedIn: this.graph.signedIn, past: this.view.past })) {
            if (action.href) {
                const link = el(doc, 'a', 'strata-action', action.label);
                link.href = action.href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                actions.append(link);
                continue;
            }
            const button = el(doc, 'button', 'strata-action', action.label);
            button.type = 'button';
            button.dataset.action = action.id;
            button.disabled = !action.enabled;
            if (action.reason) button.title = action.reason;
            button.addEventListener('click', () => this.perform(action, node));
            actions.append(button);
            if (action.reason) actions.append(el(doc, 'p', 'strata-blocked', action.reason));
        }
        parts.push(actions);
        const status = el(doc, 'p', 'strata-action-status');
        status.setAttribute('role', 'status');
        status.id = 'strataActionStatus';
        parts.push(status);
        box.replaceChildren(...parts);
    }

    legend() {
        const { doc } = this;
        const list = el(doc, 'ul', 'strata-legend');
        list.setAttribute('aria-label', 'Collector states');
        for (const state of COLLECTOR_STATES) list.append(el(doc, 'li', `strata-chip strata-chip--${state}`, stateLabel(state)));
        list.append(el(doc, 'li', 'strata-chip strata-chip--stateless', 'no state'));
        list.append(el(doc, 'li', 'strata-chip strata-chip--blocked', 'MusicBrainz-only'));
        return list;
    }

    setLoading(on) {
        this.ui.loading?.classList.toggle('active', on);
    }

    showMessage(text) {
        const box = this.ui.message;
        if (!box) return;
        box.textContent = text || '';
        box.hidden = !text;
    }

    setStatus(text) {
        const box = this.doc.getElementById('strataActionStatus');
        if (box) box.textContent = text;
    }

    // -- Interaction ------------------------------------------------------------------------

    onSelect(id) {
        this.selected = id ?? null;
        this.table?.select(this.selected);
        this.renderSelection();
    }

    onSolo(level) {
        for (const button of this.ui.planes) {
            const value = button.dataset.strataSolo === '' ? null : Number(button.dataset.strataSolo);
            button.setAttribute('aria-pressed', String(value === level));
        }
    }

    selectNode(id) {
        this.selected = id;
        if (id === null || this.byId?.has(id)) this.renderer?.select(id);
        this.table?.select(id, { focus: this.mode === 'table' });
        this.renderSelection();
    }

    /** A row chosen in the table, or the selection cleared. */
    selectRow(id) {
        this.selected = id;
        if (this.renderer && (id === null || this.byId?.has(id))) this.renderer.select(id);
        this.table?.select(id);
        this.renderSelection();
    }

    handleKey(event) {
        if (!this.layout || event.target !== this.ui.stage) return;
        const command = strataKeyCommand(event, { nodes: this.layout.nodes, selected: this.selected, solo: this.renderer?.soloed ?? null });
        if (!command) return;
        event.preventDefault();
        const renderer = this.renderer;
        switch (command.type) {
            case 'orbit': renderer?.orbit(command.radians); break;
            case 'tilt': renderer?.tilt(command.radians); break;
            case 'zoom': renderer?.zoom(command.direction); break;
            case 'reset': renderer?.resetCamera(); break;
            case 'solo': renderer?.solo(command.level); break;
            case 'select': this.selectNode(command.id); break;
            case 'open': this.drill(command.cursor); break;
        }
    }

    perform(action, node) {
        if (action.id === 'open') return this.drill(action.cursor);
        if (action.id === CollectorAction.SYNC_NOW) return this.syncNow();
        if (action.id === CollectorAction.RECORD_OBSERVATION) return this.openObservationForm(node);
        return null;
    }

    async syncNow() {
        const token = this.auth?.getToken?.();
        this.setStatus('Starting a Discogs sync…');
        const result = await this.api.triggerSync(token);
        if (result?.ok) this.setStatus('Sync started. States change only when Discogs reports them; reopen the view when it finishes.');
        else if (result?.status === 429) this.setStatus('A sync started less than a minute ago. Try again shortly.');
        else this.setStatus(result?.body?.error || result?.body?.detail || 'The sync could not be started. Is Discogs connected?');
    }

    openObservationForm(node) {
        const { doc } = this;
        const form = el(doc, 'form', 'strata-observation');
        form.setAttribute('aria-label', 'Record an observation about your copy');
        const kindLabel = el(doc, 'label', 'strata-field', 'What');
        const kind = el(doc, 'select', 'form-input-dark');
        kind.name = 'kind';
        for (const option of OBSERVATION_KINDS) {
            const item = el(doc, 'option', null, option.label);
            item.value = option.id;
            kind.append(item);
        }
        kindLabel.append(kind);
        const valueLabel = el(doc, 'label', 'strata-field', 'Observed');
        const value = el(doc, 'input', 'form-input-dark');
        value.name = 'value';
        value.required = true;
        valueLabel.append(value);
        const save = el(doc, 'button', 'strata-action', 'Save observation');
        save.type = 'submit';
        form.append(kindLabel, valueLabel, save);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            save.disabled = true;
            await this.recordObservation(node, { kind: kind.value, value: value.value });
            save.disabled = false;
        });
        this.ui.selection?.querySelector('.strata-observation')?.remove();
        this.ui.selection?.querySelector('.strata-actions')?.after(form);
        value.focus?.();
        return form;
    }

    /**
     * Record an observation about the caller's own copy: the earliest-acquired copy the route
     * named on the release node. The collection is never read to find it.
     */
    async recordObservation(node, { kind, value }) {
        const text = String(value || '').trim();
        if (!text) {
            this.setStatus('Write what you observed first.');
            return false;
        }
        const copyId = copyIdOf(node);
        if (!copyId) {
            this.setStatus(node.ownedCopyIds ? NO_COPY_REASON : COPY_UNREAD_REASON);
            return false;
        }
        const token = this.auth?.getToken?.();
        const result = await this.api.createObservation(token, copyId, { kind, value: text, source: 'user' });
        this.setStatus(result?.ok ? 'Observation recorded.' : result?.body?.detail || result?.body?.error || 'The observation could not be recorded.');
        return !!result?.ok;
    }

    /**
     * Search-to-focus (gm-design-on0x Recommendation 6): select a drawn match, or open the view on
     * what a hit names. A master opens through its `m:<id>` cursor and a pressing through the
     * route's `r:<id>` or `mb:<mbid>` cursor, which resolves to the page that holds it however deep
     * it sits, so the pressing is drawn and selected. A hit that belongs to another artist is a 404
     * for the cursor and the next hit is tried.
     */
    async focusSearch(query) {
        const q = String(query || '').trim();
        if (!q || !this.layout) return null;
        // The table can reach an entry the 3D view folded into a count node.
        const [drawn] = searchDrawn(this.mode === 'table' ? this.rows.map((row) => row.node) : this.layout.nodes, q);
        if (drawn) {
            this.selectNode(drawn.id);
            this.showMessage(null);
            return drawn.id;
        }
        if (q.length < 3) {
            this.showMessage('Type at least three characters to search the whole discography.');
            return null;
        }
        const results = await this.api.search(q, ['master', 'release'], [], null, null, 10);
        for (const hit of results?.results || []) {
            const id = hitNodeId(hit);
            if (!id) continue;
            if (!id.startsWith('m:') && this.byId.has(id)) {
                this.selectNode(id);
                return id;
            }
            if (await this.load({ focus: id, page: 0 }, { quiet: true, from: { ...this.cursor } })) {
                this.selectNode(this.byId.has(id) ? id : null);
                return id;
            }
        }
        this.showMessage(`Nothing named “${q}” in ${this.graph.root?.name || 'this discography'}'s masters or pressings.`);
        return null;
    }
}

/** Wire the strata view into Explore. app.js calls this once the app exists. */
export function initStrata({ app, doc = globalThis.document } = {}) {
    if (!doc.getElementById('strataView')) return null;
    const strata = new StrataExplore({ doc, onToggleTimeline: () => app?.timeline?.toggle() });
    if (app) app.strata = strata;
    return strata;
}

if (typeof window !== 'undefined') {
    window.StrataInit = initStrata;
}

