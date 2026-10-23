/**
 * Discography Strata layout: where every entry of a strata route payload sits on the credit,
 * master, and release planes.
 *
 * The module is pure. It has no DOM and no three.js, so the renderer only draws what it returns,
 * and these invariants are Vitest properties (__tests__/strata-layout.test.js):
 *   - no node sits inside another credit's hull, on any plane;
 *   - no two nodes on one plane overlap;
 *   - no two drawn edges on one plane cross;
 *   - every payload entry is held by exactly one drawn node, on every page;
 *   - the no-master lane and the undated strip keep their entries.
 *
 * Ported from the design spike gm-design-on0x (docs/spikes/gm-design-on0x/lib/layout.mjs and
 * view.mjs): the spaced time icicle, hull, roundedHull, inPoly, segmentsCross, the planar edge
 * rule, paged drill-down, and fitView's footprint check. The input is gm-design-1h2l's draft
 * strata payload (section 6 of docs/spikes/gm-design-1h2l-strata-ladder.md), and
 * adaptStrataPayload is the one place that reads it.
 */

export const WORLD_WIDTH = 120;
export const WORLD_DEPTH = 84;
export const PLANE_KINDS = Object.freeze(['credit', 'master', 'release']);
export const PLANE_SIZES = Object.freeze([4.2, 2.4, 1.35]);
// A node claims 2 * size + FOOTPRINT_GAP of depth, so two discs on one plane never touch.
const FOOTPRINT_GAP = 0.6;
// A credit's hull is the rounded hull of its nodes, padded by the plane's node size plus HULL_PAD.
export const HULL_PAD = 2.2;
const DEPTH_MARGIN = 3;
// Undated entries sit in a strip at the left edge, outside the year axis, which starts
// UNDATED_GAP further right. The gap is wider than two master discs, so an undated node and a
// dated node never overlap, whatever their depth.
export const UNDATED_X = -WORLD_WIDTH / 2 + 4;
const UNDATED_GAP = 8;
const AXIS_TO_X = WORLD_WIDTH / 2 - 6;
// Depth between credit bands. A node sits at least size + FOOTPRINT_GAP / 2 inside its band, and
// its hull reaches size + HULL_PAD past it, so the hull stays out of the next band while the gutter
// exceeds HULL_PAD - FOOTPRINT_GAP - size on every plane: 0.25 on the release plane.
export const GROUP_GUTTER = 0.5;
// Drill-down pages (gm-design-on0x Recommendation 2): 8 pressings, at most 12, or 8 masters, at
// most 8. Larger pages break the footprint guarantee.
export const PAGE_SIZE = 8;
export const MAX_PRESSINGS_PAGE = 12;
export const MAX_MASTERS_PAGE = 8;
const AXIS_FROM_YEAR = 1953;
const AXIS_TO_YEAR = 2027;
const EPSILON = 1e-9;
const MASTER_AGGREGATES = new Set(['no_master', 'masters', 'band']);
// Ids the layout mints for its own count nodes.
const RESERVED_ID = /^(fold|page):/;

const footprint = (level) => 2 * PLANE_SIZES[level] + FOOTPRINT_GAP;
const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function invalid(message) {
    return new TypeError(`strata payload: ${message}`);
}

function readYear(value, id, field) {
    if (value === undefined || value === null) return null;
    if (!Number.isFinite(value)) throw invalid(`${id} has a non-numeric ${field}`);
    return value;
}

function readCount(value, id, field) {
    if (value === undefined || value === null) return 0;
    if (!Number.isInteger(value) || value < 0) throw invalid(`${id} has an invalid ${field} count`);
    return value;
}

function readStates(value) {
    if (!value || typeof value !== 'object') return null;
    const states = {};
    for (const [state, count] of Object.entries(value)) if (Number.isFinite(count)) states[state] = count;
    return states;
}

function readEntry(raw, level, isAggregate) {
    if (!raw || typeof raw !== 'object') throw invalid(`plane ${level} holds a non-object entry`);
    const { id } = raw;
    if (typeof id !== 'string' || !id) throw invalid(`plane ${level} holds an entry without a string id`);
    if (RESERVED_ID.test(id)) throw invalid(`${id} uses a prefix the layout reserves`);
    if (level === 0 && raw.parent != null) throw invalid(`credit ${id} names a parent`);
    if (level > 0 && typeof raw.parent !== 'string') throw invalid(`${id} names no parent`);
    let aggKind = null;
    if (isAggregate) {
        aggKind = ['credits', raw.kind, 'releases'][level];
        if (level === 1 && !MASTER_AGGREGATES.has(aggKind)) throw invalid(`${id} has unknown aggregate kind ${raw.kind}`);
    }
    const lane = aggKind === 'no_master' ? 'nomaster' : null;
    const year = isAggregate || level === 0 ? null : readYear(raw.year, id, 'year');
    let y0 = readYear(raw.y0, id, 'y0');
    let y1 = readYear(raw.y1, id, 'y1');
    if (level === 2 && !isAggregate) [y0, y1] = [year, year];
    if (y0 !== null && y1 === null) y1 = y0;
    let label = null;
    if (level === 0 && Array.isArray(raw.artists)) {
        label = raw.artists.map((artist) => artist && artist.name).filter((name) => typeof name === 'string').join(', ');
    } else if (!isAggregate && typeof raw.title === 'string') {
        label = raw.title;
    }
    return Object.freeze({
        id,
        level,
        kind: PLANE_KINDS[level],
        parent: level === 0 ? null : raw.parent,
        agg: isAggregate,
        aggKind,
        lane,
        // Undated by its own data. A lane is placed by its pressings, never by a year of its own.
        undated: level > 0 && !lane && (isAggregate ? y0 === null : year === null),
        year,
        y0,
        y1,
        releases: level === 2 && !isAggregate ? 1 : readCount(raw.releases, id, 'releases'),
        masters: level === 1 ? (isAggregate ? readCount(raw.masters, id, 'masters') : 1) : 0,
        credits: level === 0 ? (isAggregate ? readCount(raw.credits, id, 'credits') : 1) : 0,
        state: typeof raw.state === 'string' ? raw.state : null,
        states: readStates(raw.states),
        recordedAt: typeof raw.recorded_at === 'string' ? raw.recorded_at : null,
        label,
    });
}

/**
 * The one adapter from the strata route payload to the layout's input. Everything that knows the
 * route's field names is here, so promoting the catalog-api contract (gm-catalog-api-absv) means
 * reconciling this function and its tests, not the layout.
 *
 * The payload is gm-design-1h2l's draft, GET /api/strata/artist/{artist_id}:
 *
 *   {
 *     root:   { type: 'artist', id, name },
 *     budget: { credits, masters, releases } | null,
 *     totals: { credits, masters, releases, masterless_releases, releases_only_in_master_aggregates },
 *     planes: [
 *       { level: 0, kind: 'credit',
 *         nodes:      [{ id: 'c:1', artists: [{ id, name }], releases }],
 *         aggregates: [{ id: 'c:other', credits, releases }] },
 *       { level: 1, kind: 'master',
 *         nodes:      [{ id: 'm:501', parent, title, year, releases, y0, y1, state? }],
 *         aggregates: [{ id, parent, kind: 'no_master' | 'masters' | 'band', masters, releases,
 *                        y0, y1, decade?, states? }] },
 *       { level: 2, kind: 'release',
 *         nodes:      [{ id: 'r:9', parent, title, year, state?, recorded_at? }],
 *         aggregates: [{ id, parent, releases, y0, y1, states? }] },
 *     ],
 *   }
 *
 * What the layout relies on:
 * - ids are unique strings, and every entry below the credit plane names a parent on the plane
 *   directly above;
 * - the root's own credit is the first credit node;
 * - a `no_master` aggregate is the credit's no-master lane: the parent of its masterless releases;
 * - a release-plane entry's `releases` is 1 for a node and the count it holds for an aggregate, and
 *   a master-plane entry's `releases` counts every release under it, drawn or not;
 * - a year is a number or null. Null means undated, and an aggregate with a null `y0` holds only
 *   undated entries;
 * - aggregate ids are the route's `focus` cursors, kept as `cursor` on the drawn count node.
 *
 * `state`, `states`, and `recorded_at` appear only for a signed-in caller and are passed through.
 * A malformed payload throws a TypeError naming the entry.
 *
 * @param {object} payload - the strata route response body
 * @returns {{root: object|null, budget: object|null, totals: object|null, rootCredit: string|null,
 *            entries: ReadonlyArray<object>}} a frozen graph for layoutStrata
 */
export function adaptStrataPayload(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.planes)) {
        throw invalid('expected an object with a planes array');
    }
    const entries = [];
    const byId = new Map();
    for (let level = 0; level < 3; level++) {
        const plane = payload.planes.find((candidate) => candidate && candidate.level === level);
        if (!plane) throw invalid(`plane ${level} is missing`);
        if (plane.kind !== undefined && plane.kind !== PLANE_KINDS[level]) throw invalid(`plane ${level} is not the ${PLANE_KINDS[level]} plane`);
        for (const [list, isAggregate] of [[plane.nodes, false], [plane.aggregates, true]]) {
            if (list === undefined || list === null) continue;
            if (!Array.isArray(list)) throw invalid(`plane ${level} has a non-array entry list`);
            for (const raw of list) {
                const entry = readEntry(raw, level, isAggregate);
                if (byId.has(entry.id)) throw invalid(`duplicate id ${entry.id}`);
                byId.set(entry.id, entry);
                entries.push(entry);
            }
        }
    }
    for (const entry of entries) {
        if (entry.level === 0) continue;
        const parent = byId.get(entry.parent);
        if (!parent || parent.level !== entry.level - 1) throw invalid(`${entry.id} names ${entry.parent}, which is not on the plane above`);
    }
    const firstCredit = entries.find((entry) => entry.level === 0 && !entry.agg);
    return Object.freeze({
        root: payload.root ?? null,
        budget: payload.budget ?? null,
        totals: payload.totals ?? null,
        rootCredit: firstCredit ? firstCredit.id : null,
        entries: Object.freeze(entries),
    });
}

// ---------------------------------------------------------------------------------------------
// The view tree: payload entries, then the page and the count nodes the footprint check folds.
// ---------------------------------------------------------------------------------------------

function fromEntry(entry) {
    return {
        id: entry.id,
        level: entry.level,
        parent: null,
        children: [],
        agg: entry.agg,
        aggKind: entry.aggKind,
        lane: entry.lane,
        undated: entry.undated,
        year: entry.year,
        y0: entry.y0,
        y1: entry.y1,
        releases: entry.releases,
        masters: entry.masters,
        credits: entry.credits,
        state: entry.state,
        states: entry.states,
        recordedAt: entry.recordedAt,
        label: entry.label,
        members: [entry.id],
        cursor: entry.agg ? entry.id : null,
        pageOf: null,
        origin: 'payload',
        pinned: false,
        w: 0,
        cls: 'm',
        x: 0,
        z: 0,
    };
}

function buildTree(graph) {
    const byId = new Map();
    const roots = [];
    for (const entry of graph.entries) byId.set(entry.id, fromEntry(entry));
    for (const entry of graph.entries) {
        const node = byId.get(entry.id);
        if (entry.level === 0) {
            roots.push(node);
            continue;
        }
        node.parent = byId.get(entry.parent);
        node.parent.children.push(node);
    }
    const root = roots.find((node) => node.id === graph.rootCredit);
    if (root) roots.unshift(...roots.splice(roots.indexOf(root), 1));
    return { roots, byId, pageTarget: null };
}

function hasState(node) {
    if (node.state && node.state !== 'none') return true;
    return !!node.states && Object.entries(node.states).some(([state, count]) => state !== 'none' && count > 0);
}

function mergeStates(list) {
    let merged = null;
    for (const states of list) {
        if (!states) continue;
        merged = merged || {};
        for (const [state, count] of Object.entries(states)) merged[state] = (merged[state] || 0) + count;
    }
    return merged;
}

// Collector state counted per release, for a count node's colour.
function statesOf(node) {
    if (node.states) return node.states;
    if (node.level === 2 && node.state) return { [node.state]: 1 };
    return node.children.length ? mergeStates(node.children.map(statesOf)) : null;
}

function membersOf(node, out) {
    out.push(...node.members);
    for (const child of node.children) membersOf(child, out);
    return out;
}

// The year a node is drawn at on the axis: its own, or the middle of a count node's span.
function axisYear(node) {
    if (node.agg) return node.y0 === null ? null : (node.y0 + node.y1) / 2;
    return node.year;
}

function yearSpan(nodes) {
    let lo = null;
    let hi = null;
    for (const node of nodes) {
        const from = node.agg ? node.y0 : node.year;
        const to = node.agg ? node.y1 : node.year;
        if (from !== null && (lo === null || from < lo)) lo = from;
        if (to !== null && (hi === null || to > hi)) hi = to;
    }
    return [lo, hi];
}

// The column a node is drawn in: 'u' for the undated strip, 'd' for the year axis. A lane sits on
// the axis when any of its pressings does.
function column(node) {
    if (!node.lane) return node.undated ? 'u' : 'd';
    if (node.children.length) return node.children.every((child) => column(child) === 'u') ? 'u' : 'd';
    return node.y0 === null ? 'u' : 'd';
}

// A count node holding `items`, all siblings in one column, with everything under them.
function countNode(parent, items, id, origin) {
    const [y0, y1] = yearSpan(items);
    const level = items[0].level;
    return {
        ...fromEntry({
            id,
            level,
            agg: true,
            aggKind: level === 1 ? 'masters' : 'releases',
            lane: null,
            undated: column(items[0]) === 'u',
            year: null,
            y0,
            y1,
            releases: items.reduce((sum, item) => sum + item.releases, 0),
            masters: items.reduce((sum, item) => sum + item.masters, 0),
            credits: 0,
            state: null,
            states: mergeStates(items.map(statesOf)),
            recordedAt: null,
            label: null,
        }),
        parent,
        members: items.flatMap((item) => membersOf(item, [])),
        cursor: null,
        pageOf: parent.id,
        origin,
    };
}

function byColumn(nodes) {
    const groups = new Map();
    for (const node of nodes) {
        const key = column(node);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
    }
    return groups;
}

// Fold the eligible children of `parent` into one count node per column. A count node never mixes
// dated and undated entries, so the undated strip keeps its entries. Returns whether anything
// folded.
function foldChildren(parent, eligible) {
    let changed = false;
    for (const [key, group] of byColumn(parent.children.filter(eligible))) {
        if (group.length < 2) continue;
        const folded = countNode(parent, group, `fold:${parent.id}:${key}`, 'fold');
        const drop = new Set(group);
        parent.children = parent.children.filter((child) => !drop.has(child));
        parent.children.push(folded);
        measureNode(folded);
        changed = true;
    }
    return changed;
}

function byAxis(a, b) {
    const ya = axisYear(a);
    const yb = axisYear(b);
    if (ya !== yb) return (ya ?? -Infinity) - (yb ?? -Infinity);
    return compareIds(a.id, b.id);
}

function pin(node) {
    for (let at = node; at; at = at.parent) at.pinned = true;
}

// Drill-down: show one page of a credit's masters or a master's pressings, and fold the rest into
// one "more" node per column. Pages wrap, and the more node holds every entry not on the page,
// earlier pages included, so nothing leaves the view while paging.
function applyPage(tree, focus) {
    const target = tree.byId.get(focus.id);
    if (!target || target.level === 2) return null;
    const ofMasters = target.level === 0;
    const candidates = target.children.filter((child) => !(ofMasters && child.lane)).sort(byAxis);
    if (!candidates.length) return null;
    const max = ofMasters ? MAX_MASTERS_PAGE : MAX_PRESSINGS_PAGE;
    const requested = Number.isFinite(focus.per) ? Math.floor(focus.per) : PAGE_SIZE;
    const per = Math.min(max, Math.max(1, requested));
    const pages = Math.ceil(candidates.length / per);
    const asked = Number.isFinite(focus.page) ? Math.floor(focus.page) : 0;
    const index = ((asked % pages) + pages) % pages;
    const shown = candidates.slice(index * per, index * per + per);
    const onPage = new Set(shown);
    const rest = candidates.filter((child) => !onPage.has(child));
    const folded = new Set(rest);
    pin(target);
    shown.forEach(pin);
    target.children = target.children.filter((child) => !folded.has(child));
    for (const [key, group] of byColumn(rest)) {
        const more = countNode(target, group, `page:${target.id}:${key}`, 'page');
        more.pinned = true;
        target.children.push(more);
    }
    tree.pageTarget = target;
    return { parent: target.id, index, pages, per, size: candidates.length, shown: shown.map((child) => child.id) };
}

// ---------------------------------------------------------------------------------------------
// The footprint check. Every node needs its footprint of depth, and its children need theirs
// inside it. Children whose whole subtree is on the axis and children whose whole subtree is in
// the undated strip can share depth, because the strip is wider apart from the axis than two
// discs. Everything else is stacked. A view fits when the credit bands fit the plane's depth.
// ---------------------------------------------------------------------------------------------

function measureNode(node) {
    let mixed = 0;
    let dated = 0;
    let undated = 0;
    const own = node.level === 0 ? null : column(node);
    let pure = own !== null;
    for (const child of node.children) {
        if (child.cls === 'm') mixed += child.w;
        else if (child.cls === 'u') undated += child.w;
        else dated += child.w;
        if (child.cls !== own) pure = false;
    }
    node.w = Math.max(footprint(node.level), mixed + Math.max(dated, undated));
    node.cls = pure ? own : 'm';
}

function measureTree(node) {
    node.children.forEach(measureTree);
    measureNode(node);
}

function usableDepth(roots) {
    return WORLD_DEPTH - 2 * DEPTH_MARGIN - GROUP_GUTTER * Math.max(0, roots.length - 1);
}

function requiredDepth(roots) {
    return roots.reduce((sum, root) => sum + root.w, 0);
}

function remeasureUp(node) {
    for (let at = node; at; at = at.parent) measureNode(at);
}

// Fold the other credits into one count node: their masters, and one merged no-master lane.
function foldCredits(tree) {
    const [root, ...rest] = tree.roots;
    const items = rest.filter((credit) => !credit.pinned);
    if (items.length < 2) return;
    const node = {
        ...fromEntry({
            id: 'fold:credits',
            level: 0,
            agg: true,
            aggKind: 'credits',
            lane: null,
            undated: false,
            year: null,
            y0: null,
            y1: null,
            releases: items.reduce((sum, item) => sum + item.releases, 0),
            masters: 0,
            credits: items.reduce((sum, item) => sum + item.credits, 0),
            state: null,
            states: null,
            recordedAt: null,
            label: null,
        }),
        members: items.flatMap((item) => item.members),
        cursor: null,
        origin: 'fold',
    };
    const lanes = items.flatMap((item) => item.children.filter((child) => child.lane));
    const masters = items.flatMap((item) => item.children.filter((child) => !child.lane));
    let lane = lanes[0] || null;
    if (lanes.length > 1) {
        const [y0, y1] = yearSpan(lanes);
        lane = {
            ...fromEntry({ ...lanes[0], id: 'fold:credits:nm', y0, y1, releases: lanes.reduce((sum, item) => sum + item.releases, 0), states: mergeStates(lanes.map((item) => item.states)), recordedAt: null, label: null }),
            members: lanes.flatMap((item) => item.members),
            children: lanes.flatMap((item) => item.children),
            cursor: null,
            origin: 'fold',
        };
        for (const child of lane.children) child.parent = lane;
    }
    node.children = lane ? [lane, ...masters] : masters;
    for (const child of node.children) child.parent = node;
    if (lane) foldChildren(lane, () => true);
    foldChildren(node, (child) => !child.lane);
    measureTree(node);
    const folded = new Set(items);
    tree.roots = [root, ...rest.filter((credit) => !folded.has(credit)), node];
}

// The counts in the payload are the request; this is the guarantee. Fold, least valued first,
// until the credit bands fit: pressings without collector state, masters without collector state,
// every other pressing, every other master, and last the credits other than the root's.
function fitDepth(tree) {
    tree.roots.forEach(measureTree);
    const fits = () => requiredDepth(tree.roots) <= usableDepth(tree.roots) + EPSILON;
    if (fits()) return;
    const masters = tree.roots
        .flatMap((credit) => credit.children)
        .filter((master) => master !== tree.pageTarget && master.children.length > 1)
        .sort((a, b) => b.w - a.w || compareIds(a.id, b.id));
    const credits = tree.roots.slice().sort((a, b) => b.w - a.w || compareIds(a.id, b.id));
    const foldPressings = (eligible) => {
        for (const master of masters) {
            if (foldChildren(master, eligible)) remeasureUp(master);
            if (fits()) return true;
        }
        return false;
    };
    const foldMasters = (eligible) => {
        for (const credit of credits) {
            if (foldChildren(credit, (child) => !child.lane && !child.pinned && eligible(child))) remeasureUp(credit);
            if (fits()) return true;
        }
        return false;
    };
    if (foldPressings((child) => !hasState(child))) return;
    if (foldMasters((child) => !hasState(child))) return;
    if (foldPressings(() => true)) return;
    if (foldMasters(() => true)) return;
    foldCredits(tree);
}

// ---------------------------------------------------------------------------------------------
// Placement: x is the year (or the undated strip), z nests credit, master, and release bands.
// ---------------------------------------------------------------------------------------------

/** The x of a year on an axis returned by layoutStrata. */
export function yearToX(axis, year) {
    return axis.fromX + ((year - axis.y0) / (axis.y1 - axis.y0)) * (axis.toX - axis.fromX);
}

function makeAxis(roots, hint) {
    let lo = Infinity;
    let hi = -Infinity;
    const visit = (node) => {
        for (const year of [node.year, node.y0, node.y1]) {
            if (year === null) continue;
            lo = Math.min(lo, year);
            hi = Math.max(hi, year);
        }
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    const valid = hint && Number.isFinite(hint.y0) && Number.isFinite(hint.y1) && hint.y0 < hint.y1;
    return {
        y0: Math.min(valid ? hint.y0 : AXIS_FROM_YEAR, lo - 2),
        y1: Math.max(valid ? hint.y1 : AXIS_TO_YEAR, hi + 1),
        fromX: UNDATED_X + UNDATED_GAP,
        toX: AXIS_TO_X,
        undatedX: UNDATED_X,
    };
}

function placeX(node, axis) {
    node.children.forEach((child) => placeX(child, axis));
    if (node.level > 0 && !node.lane) {
        node.x = node.undated ? UNDATED_X : yearToX(axis, axisYear(node));
        return;
    }
    const dated = node.children.filter((child) => child.x !== UNDATED_X);
    if (dated.length) node.x = dated.reduce((sum, child) => sum + child.x, 0) / dated.length;
    else if (node.lane && !node.children.length && node.y0 !== null) node.x = yearToX(axis, axisYear(node));
    else node.x = UNDATED_X;
}

function byX(a, b) {
    return a.x - b.x || compareIds(a.id, b.id);
}

function stack(list, from, scale) {
    let at = from;
    for (const node of list) {
        placeZ(node, at, at + node.w * scale, scale);
        at += node.w * scale;
    }
}

function placeZ(node, from, to, scale) {
    node.z = (from + to) / 2;
    const children = node.children.slice().sort(byX);
    const mixed = children.filter((child) => child.cls === 'm');
    const dated = children.filter((child) => child.cls === 'd');
    const undated = children.filter((child) => child.cls === 'u');
    const sum = (list) => list.reduce((total, child) => total + child.w, 0);
    const shared = Math.max(sum(dated), sum(undated));
    let at = from + (to - from - (sum(mixed) + shared) * scale) / 2;
    stack(mixed, at, scale);
    at += sum(mixed) * scale;
    stack(dated, at + ((shared - sum(dated)) * scale) / 2, scale);
    stack(undated, at + ((shared - sum(undated)) * scale) / 2, scale);
}

// ---------------------------------------------------------------------------------------------
// Edges: the planar rule from gm-design-on0x. Member and shared-credit edges radiate from the root
// credit; shared personnel joins only masters of one credit that are neighbours in (x, z) order;
// company edges are drawn only for the selected pressing. Every other lateral edge stays in the
// panel and the table. A chain over points sorted by (x, z) cannot cross itself, and credit bands
// do not overlap in depth, so no two drawn edges on a plane cross.
// ---------------------------------------------------------------------------------------------

function drawEdges(roots, byEntry, edges, rootCredit, selected) {
    const rank = new Map();
    for (const credit of roots) credit.children.slice().sort((a, b) => a.x - b.x || a.z - b.z).forEach((child, i) => rank.set(child, i));
    const drawn = [];
    const seen = new Set();
    for (const edge of edges || []) {
        const a = byEntry.get(edge && edge.a);
        const b = byEntry.get(edge && edge.b);
        if (!a || !b || a === b || a.level !== b.level) continue;
        let keep = false;
        if (edge.kind === 'member' || edge.kind === 'collab') keep = a.level === 0 && (a.id === rootCredit || b.id === rootCredit);
        else if (edge.kind === 'personnel') keep = a.level === 1 && a.parent === b.parent && Math.abs(rank.get(a) - rank.get(b)) === 1;
        else if (edge.kind === 'company') keep = a.level === 2 && selected != null && (a.id === selected || b.id === selected);
        const key = [a.id, b.id].sort().join('\u0000') + '\u0000' + edge.kind;
        if (!keep || seen.has(key)) continue;
        seen.add(key);
        drawn.push({ a: a.id, b: b.id, kind: edge.kind });
    }
    return drawn;
}

function output(node, group) {
    return {
        id: node.id,
        level: node.level,
        kind: PLANE_KINDS[node.level],
        parent: node.parent ? node.parent.id : null,
        group,
        children: node.children.map((child) => child.id),
        agg: node.agg,
        aggKind: node.aggKind,
        lane: node.lane,
        undated: node.level > 0 && node.x === UNDATED_X,
        year: node.year,
        y0: node.y0,
        y1: node.y1,
        releases: node.releases,
        masters: node.masters,
        credits: node.credits,
        state: node.state,
        states: node.states ? { ...node.states } : null,
        recordedAt: node.recordedAt,
        label: node.label,
        members: node.members.slice(),
        cursor: node.cursor,
        pageOf: node.pageOf,
        origin: node.origin,
        x: node.x,
        z: node.z,
        size: PLANE_SIZES[node.level],
    };
}

/**
 * Lay out a strata graph from adaptStrataPayload.
 *
 * @param {object} graph - the adapted payload
 * @param {object} [options]
 * @param {{id: string, page?: number, per?: number}} [options.focus] - drill-down: page the
 *   masters of a credit (8 per page, at most 8) or the pressings of a master-plane entry (8 per
 *   page, at most 12). Pages wrap.
 * @param {string} [options.selected] - the selected release-plane entry, whose company edges draw
 * @param {Array<{a: string, b: string, kind: string}>} [options.edges] - lateral edges between
 *   entry ids: 'member' and 'collab' on the credit plane, 'personnel' on the master plane, and
 *   'company' on the release plane. The draft payload carries none; the planar rule picks which
 *   to draw.
 * @param {{y0: number, y1: number}} [options.axis] - a year range to keep steady across clocks. It
 *   widens to hold every year in the view.
 * @returns {object} nodes by plane with x, z, and size; drawn edges; the axis; the depth check;
 *   and the page shown
 */
export function layoutStrata(graph, options = {}) {
    const { focus = null, selected = null, edges = [], axis: axisHint = null } = options;
    const tree = buildTree(graph);
    const page = focus ? applyPage(tree, focus) : null;
    fitDepth(tree);
    const axis = makeAxis(tree.roots, axisHint);
    tree.roots.forEach((root) => placeX(root, axis));
    const usable = usableDepth(tree.roots);
    const required = requiredDepth(tree.roots);
    const scale = required > 0 ? usable / required : 1;
    let at = -WORLD_DEPTH / 2 + DEPTH_MARGIN;
    for (const root of tree.roots) {
        placeZ(root, at, at + root.w * scale, scale);
        at += root.w * scale + GROUP_GUTTER;
    }
    const nodes = [];
    const byEntry = new Map();
    const visit = (node, group) => {
        nodes.push(output(node, group));
        if (node.origin === 'payload' && !node.agg) byEntry.set(node.id, node);
        node.children.forEach((child) => visit(child, group));
    };
    tree.roots.forEach((root) => visit(root, root.id));
    nodes.sort((a, b) => a.level - b.level);
    return {
        nodes,
        edges: drawEdges(tree.roots, byEntry, edges, graph.rootCredit, selected),
        axis,
        depth: { usable, required, fit: scale },
        page,
        rootCredit: graph.rootCredit,
    };
}

// ---------------------------------------------------------------------------------------------
// Geometry and readouts. hull, roundedHull, and inPoly are the mockup's, unchanged. The readouts
// are the mockup's on-screen checks, which the property tests hold at zero.
// ---------------------------------------------------------------------------------------------

export function hull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    const upper = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

export function roundedHull(points, pad) {
    const ring = [];
    for (const [x, z] of points) {
        for (let i = 0; i < 18; i++) {
            const a = (i / 18) * Math.PI * 2;
            ring.push([x + Math.cos(a) * pad, z + Math.sin(a) * pad]);
        }
    }
    return hull(ring);
}

export function inPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i];
        const [xj, zj] = poly[j];
        if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

const orient = (ax, az, bx, bz, cx, cz) => Math.sign((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
const onSegment = (ax, az, bx, bz, cx, cz) =>
    Math.min(ax, bx) - EPSILON <= cx && cx <= Math.max(ax, bx) + EPSILON && Math.min(az, bz) - EPSILON <= cz && cz <= Math.max(az, bz) + EPSILON;

/** Whether two segments [ax, az, bx, bz] cross. Collinear overlap counts: two ribbons on top of each other. */
export function segmentsCross(p, q) {
    const [ax, az, bx, bz] = p;
    const [cx, cz, dx, dz] = q;
    const o1 = orient(ax, az, bx, bz, cx, cz);
    const o2 = orient(ax, az, bx, bz, dx, dz);
    const o3 = orient(cx, cz, dx, dz, ax, az);
    const o4 = orient(cx, cz, dx, dz, bx, bz);
    if (o1 !== o2 && o3 !== o4 && o1 * o2 <= 0 && o3 * o4 <= 0 && (o1 || o2 || o3 || o4)) return true;
    if (!o1 && onSegment(ax, az, bx, bz, cx, cz)) return true;
    if (!o2 && onSegment(ax, az, bx, bz, dx, dz)) return true;
    if (!o3 && onSegment(cx, cz, dx, dz, ax, az)) return true;
    if (!o4 && onSegment(cx, cz, dx, dz, bx, bz)) return true;
    return false;
}

/**
 * The drawn part of an edge: the ribbon stops short of both discs. Null when the discs are too
 * close for a ribbon.
 */
export function edgeSegment(a, b) {
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const sa = a.size * 1.1;
    const sb = b.size * 1.25;
    if (length <= sa + sb) return null;
    return [a.x + dx * sa, a.z + dz * sa, b.x - dx * sb, b.z - dz * sb];
}

/** One rounded hull per credit group on a plane, as the renderer draws them. */
export function hullPolygons(layout, level) {
    const groups = new Map();
    for (const node of layout.nodes) {
        if (node.level !== level) continue;
        if (!groups.has(node.group)) groups.set(node.group, []);
        groups.get(node.group).push([node.x, node.z]);
    }
    return [...groups].map(([group, points]) => ({ group, polygon: roundedHull(points, PLANE_SIZES[level] + HULL_PAD) }));
}

/** Nodes on a plane inside the hull of a credit group they do not belong to. */
export function hullIntrusions(layout, level) {
    const nodes = layout.nodes.filter((node) => node.level === level);
    let count = 0;
    for (const { group, polygon } of hullPolygons(layout, level)) {
        for (const node of nodes) if (node.group !== group && inPoly([node.x, node.z], polygon)) count++;
    }
    return count;
}

/** Pairs of nodes on a plane whose discs overlap. */
export function nodeOverlaps(layout, level) {
    const nodes = layout.nodes.filter((node) => node.level === level);
    let count = 0;
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            if (Math.hypot(a.x - b.x, a.z - b.z) < a.size + b.size - EPSILON) count++;
        }
    }
    return count;
}

/** Pairs of drawn edges on one plane that cross. Edges sharing a node meet only at its disc. */
export function samePlaneCrossings(layout) {
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const segments = [];
    for (const edge of layout.edges) {
        const a = byId.get(edge.a);
        const b = byId.get(edge.b);
        const segment = edgeSegment(a, b);
        if (segment) segments.push({ edge, level: a.level, segment });
    }
    let count = 0;
    for (let i = 0; i < segments.length; i++) {
        for (let j = i + 1; j < segments.length; j++) {
            const p = segments[i];
            const q = segments[j];
            if (p.level !== q.level) continue;
            if (p.edge.a === q.edge.a || p.edge.a === q.edge.b || p.edge.b === q.edge.a || p.edge.b === q.edge.b) continue;
            if (segmentsCross(p.segment, q.segment)) count++;
        }
    }
    return count;
}
