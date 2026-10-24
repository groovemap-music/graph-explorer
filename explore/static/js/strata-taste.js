/**
 * Taste Strata: concept C′ of ADR 0016 (sections 4 to 6), the signed-in collector's items laid on
 * the Genre Atlas. It is a personal layer over the atlas, never part of it.
 *
 * The input is `GET /api/user/taste-projection` (contracts/catalog-api/graph-explorer/v1), and
 * adaptTasteProjection is the one place that reads it. The rule (gm-design-4804 C1, Recommendation
 * for C 1 and 4):
 *   - L0 and L1: an item lands on every genre and every style it carries, so the layer marks the
 *     served genre and style nodes, each with its own counts and collector state. A style is marked
 *     on its primary node and on every ghost copy, since a ghost is the same style under another
 *     parent. Nothing is placed at a centroid or at any position the atlas does not serve;
 *   - L2: a collector master takes a slot in its dominant style's cell by the one slot rule the
 *     landmarks use (strata-master-slots.js, through layoutAtlas). Its dominant style is the style
 *     it is a landmark of, when it is one, so a master that is both sits in the same slot in both
 *     views; otherwise the drawn style among its own that the collector holds most items of, then
 *     by name. A master with no drawn style is counted and not drawn;
 *   - masterless items are counted (`totals.masterless_items`), never drawn.
 *
 * Transaction time is the collector's recorded `date_added`. The projection carries each node's
 * earliest and latest recorded time per state, not a history, so "recorded as of" shows what the
 * collector holds now by when Discogs first recorded it. It cannot replay a removal, and the counts
 * stay today's; the view says so. Scrubbing it moves nothing: a node not yet recorded is unmarked.
 *
 * The module is pure (no DOM, no three.js). Its properties are Vitest tests
 * (__tests__/strata-taste.test.js): collector slots deterministic, inside their cell, and clear of
 * every landmark and other collector master.
 */

import { CollectorState } from './strata-collector.js';

/** The projection's state names, as the collector machine's (and its tokens') names. */
export const TASTE_STATES = Object.freeze({
    owned: CollectorState.OWNED,
    wanted: CollectorState.WANTED,
    wanted_owned: CollectorState.WANTED_OWNED,
});

export const TASTE_SIGN_IN = 'Sign in to see your collection on the atlas: the genres and styles you hold, and your masters on the master plane.';
export const TASTE_FAILED = 'Your collection could not be loaded, so the atlas shows no personal layer. Try again later.';
export const TASTE_EMPTY = 'Your collection and wantlist have no items yet, so nothing of yours is marked.';
export const TASTE_AS_OF_NOTE = 'Shows what you hold now, by the year Discogs first recorded it. Items you have since removed are not replayed, and the counts are today\'s.';

function invalid(message) {
    throw new Error(`invalid taste-projection payload: ${message}`);
}

function count(value, what) {
    if (!Number.isInteger(value) || value < 0) invalid(`${what} is not a count`);
    return value;
}

function name(value, what) {
    if (typeof value !== 'string' || !value) invalid(`${what} is not a name`);
    return value;
}

/** A recorded time as epoch milliseconds, or null when it is missing or not a time. */
function instant(value) {
    if (typeof value !== 'string') return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
}

function span(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object') invalid('a recorded_at span is not an object');
    return { first: instant(raw.first), last: instant(raw.last), undated: Number.isInteger(raw.undated) ? raw.undated : 0 };
}

function spans(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    return { owned: span(value.owned), wanted: span(value.wanted) };
}

function entry(raw, where) {
    const state = TASTE_STATES[raw.state] ?? invalid(`${where}.state is not a collector state`);
    return {
        name: name(raw.id, `${where}.id`),
        items: count(raw.items, `${where}.items`),
        owned: count(raw.owned, `${where}.owned`),
        wanted: count(raw.wanted, `${where}.wanted`),
        state,
        recordedAt: spans(raw.recorded_at),
    };
}

/** Read a taste-projection body. */
export function adaptTasteProjection(payload) {
    if (!payload || typeof payload !== 'object') invalid('not an object');
    const totals = payload.totals && typeof payload.totals === 'object' ? payload.totals : invalid('no totals');
    const list = (key) => (Array.isArray(payload[key]) ? payload[key] : invalid(`${key} is not a list`));
    const genres = list('genres').map((raw, i) => entry(raw, `genres[${i}]`));
    const styles = list('styles').map((raw, i) => entry(raw, `styles[${i}]`));
    const masters = list('masters').map((raw, i) => {
        const where = `masters[${i}]`;
        const { name: id, ...rest } = entry({ ...raw, id: raw.id == null ? raw.id : String(raw.id) }, where);
        return {
            masterId: id,
            ...rest,
            year: Number.isInteger(raw.year) ? raw.year : null,
            genres: Array.isArray(raw.genres) ? raw.genres.filter((genre) => typeof genre === 'string') : [],
            styles: Array.isArray(raw.styles) ? raw.styles.filter((style) => typeof style === 'string') : [],
        };
    });
    return {
        totals: {
            items: count(totals.items, 'totals.items'),
            owned: count(totals.owned, 'totals.owned'),
            wanted: count(totals.wanted, 'totals.wanted'),
            wantedOwned: count(totals.wanted_owned ?? 0, 'totals.wanted_owned'),
            masterlessItems: count(totals.masterless_items ?? 0, 'totals.masterless_items'),
            genreOnlyItems: count(totals.genre_only_items ?? 0, 'totals.genre_only_items'),
            unplacedItems: count(totals.unplaced_items ?? 0, 'totals.unplaced_items'),
        },
        recordedAt: spans(payload.recorded_at),
        genres: new Map(genres.map((item) => [item.name, item])),
        styles: new Map(styles.map((item) => [item.name, item])),
        masters,
        byMaster: new Map(masters.map((master) => [master.masterId, master])),
    };
}

// ---------------------------------------------------------------------------------------------
// L2: collector masters in their dominant style's cell.
// ---------------------------------------------------------------------------------------------

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A collector master's dominant style on this atlas, or null when none of its styles is drawn.
 * `landmarks` maps a master id to the drawn styles it is a landmark of, `[{style, rank}]`; `drawn`
 * is the set of drawn style names; `held` maps a style name to the collector's items on it.
 *
 * @returns {{style: string, landmark: boolean} | null}
 */
export function dominantStyle(master, { landmarks = new Map(), drawn, held = new Map() }) {
    const listed = landmarks.get(master.masterId);
    if (listed && listed.length) {
        const best = [...listed].sort((a, b) => a.rank - b.rank || byText(a.style, b.style))[0];
        return { style: best.style, landmark: true };
    }
    const candidates = [...new Set(master.styles)].filter((style) => drawn.has(style));
    if (!candidates.length) return null;
    candidates.sort((a, b) => (held.get(b)?.items ?? 0) - (held.get(a)?.items ?? 0) || byText(a, b));
    return { style: candidates[0], landmark: false };
}

/**
 * The atlas with the collector's masters added to the master plane, for layoutAtlas, and what could
 * not be drawn. A collector master that is a landmark is not added again: it is the landmark's node,
 * which paintTaste marks. Every other one joins its dominant style's masters with no rank, so the
 * slot rule gives it a collector slot in that cell, laid out with the cell's landmarks.
 *
 * @param {object} atlas - from adaptAtlasPayload
 * @param {object} taste - from adaptTasteProjection
 * @returns {{atlas: object, placed: number, landmarks: number, notDrawn: number}}
 */
export function withCollectorMasters(atlas, taste) {
    const drawn = new Set(atlas.styles.map((style) => style.style));
    const landmarks = new Map();
    // Every master the atlas already draws, so the collector's copy of one is marked in place and
    // never drawn twice. A served master with no rank sorts after the ranked ones.
    for (const master of atlas.masters || []) {
        if (!drawn.has(master.style)) continue;
        if (!landmarks.has(master.masterId)) landmarks.set(master.masterId, []);
        landmarks.get(master.masterId).push({ style: master.style, rank: master.rank ?? Infinity });
    }
    const added = [];
    let onLandmarks = 0;
    let notDrawn = 0;
    for (const master of taste.masters) {
        const home = dominantStyle(master, { landmarks, drawn, held: taste.styles });
        if (!home) notDrawn++;
        else if (home.landmark) onLandmarks++;
        else added.push({ masterId: master.masterId, title: null, year: master.year, style: home.style, releaseCount: null, rank: null, collector: true });
    }
    return { atlas: { ...atlas, masters: [...(atlas.masters || []), ...added] }, placed: added.length, landmarks: onLandmarks, notDrawn };
}

// ---------------------------------------------------------------------------------------------
// Transaction time and paint.
// ---------------------------------------------------------------------------------------------

/** The years the collector's recorded times span, or null when Discogs recorded none. */
export function recordedYears(taste) {
    const times = [];
    for (const state of ['owned', 'wanted']) {
        const recorded = taste.recordedAt[state];
        if (recorded) for (const at of [recorded.first, recorded.last]) if (at !== null) times.push(at);
    }
    if (!times.length) return null;
    return { first: new Date(Math.min(...times)).getUTCFullYear(), last: new Date(Math.max(...times)).getUTCFullYear() };
}

/**
 * An entry's state as of the end of a year, from when Discogs first recorded each of its states, or
 * null when neither was recorded by then. `year` null is now: the entry's state as served. A state
 * with no recorded time at all is known only now.
 */
export function stateAsOf(item, year) {
    if (year === null || year === undefined) return item.state;
    const end = Date.UTC(year + 1, 0, 1);
    const by = (recorded) => !!recorded && recorded.first !== null && recorded.first < end;
    const owned = by(item.recordedAt.owned);
    const wanted = by(item.recordedAt.wanted);
    if (owned && wanted) return CollectorState.WANTED_OWNED;
    if (owned) return CollectorState.OWNED;
    return wanted ? CollectorState.WANTED : null;
}

/** The taste entry a layout node stands for, or null. */
export function tasteEntry(taste, node) {
    if (!taste) return null;
    if (node.entity === 'genre') return taste.genres.get(node.genre) ?? null;
    if (node.entity === 'style' || node.entity === 'ghost') return taste.styles.get(node.style) ?? null;
    if (node.entity === 'master') return taste.byMaster.get(node.master.masterId) ?? null;
    return null;
}

/**
 * Mark every node the collector holds for a year of transaction time (null for now): `held` is
 * `{state, items, owned, wanted}` when the node's items were recorded by then, else null, and
 * `heldLater` says the node is the collector's but was first recorded after that year. With no
 * taste, every mark is cleared. Nothing moves.
 *
 * @returns {{genres: number, styles: number, masters: number, collectors: number}} the marked
 *   genre and style nodes (primaries only), landmark masters, and collector masters
 */
export function paintTaste(layout, taste, year = null) {
    const marked = { genres: 0, styles: 0, masters: 0, collectors: 0 };
    for (const node of layout.nodes) {
        const item = tasteEntry(taste, node);
        const state = item ? stateAsOf(item, year) : null;
        node.held = state ? { state, items: item.items, owned: item.owned, wanted: item.wanted } : null;
        node.heldLater = !!item && !state;
        if (!state) continue;
        if (node.entity === 'genre') marked.genres++;
        else if (node.entity === 'style') marked.styles++;
        else if (node.entity === 'master') marked[node.master.collector ? 'collectors' : 'masters']++;
    }
    return marked;
}

/** Counts of marked style primaries per collector state, for the legend. */
export function heldCounts(layout) {
    const counts = new Map();
    for (const node of layout.nodes) if (node.entity === 'style' && node.held) counts.set(node.held.state, (counts.get(node.held.state) || 0) + 1);
    return counts;
}
