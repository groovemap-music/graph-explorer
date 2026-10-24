/**
 * Genre Atlas layout: concept B of ADR 0016 (section 4), the served geography on the Strata planes.
 *
 * The atlas is laid out server-side and pinned month to month (analytics-engine
 * insights/style_atlas.py), so this module never moves a node. It maps the served unit-disc
 * coordinates onto the planes by one uniform scale (`ATLAS_RADIUS`), and decides only what the
 * served layout leaves to the client:
 *   - the planes: genres on plane 0, styles and their ghost copies on plane 1, landmark masters on
 *     plane 2, each in a deterministic slot of its style's cell (strata-master-slots.js). When the
 *     route serves none, that plane is drawn empty and says so;
 *   - the footprint check: each plane's node size is the largest that keeps every node's footprint
 *     clear of its nearest neighbour, since the positions cannot move to make room. A master's
 *     size is its slot's footprint instead, which already clears every other slot;
 *   - genre hulls: one per sector, around the styles and ghost copies it hosts. A ghost is counted
 *     in its host's hull (gm-design-4804 Recommendation for B 2);
 *   - lifecycle stages over valid time, read from each style's `stages` (one index into
 *     `rule.stages` per timeline year), and the provisional latest years;
 *   - emergence edges, drawn only where the payload's `emergence_edge` is true;
 *   - lateral edges for the selected style only (gm-design-4804 Recommendation for B 4).
 *
 * The module is pure (no DOM, no three.js). Its properties are Vitest tests
 * (__tests__/strata-atlas-layout.test.js): positions equal the payload, zero hull intrusions, every
 * ghost inside and counted in its host hull, and no two node footprints overlapping on a plane.
 * The input is `GET /api/insights/style-atlas` (contracts/catalog-api/graph-explorer/v1), and
 * adaptAtlasPayload is the one place that reads it.
 */

import { PLANE_KINDS, hull, inPoly, roundedHull } from './strata-layout.js';
import { styleCells } from './strata-master-slots.js';

/** World units per unit of the served disc: the outermost styles (radius 0.95) sit 43.7 units out, inside the plane. */
export const ATLAS_RADIUS = 46;
/** The plane names, top to bottom. */
export const ATLAS_PLANES = Object.freeze(['Genres', 'Styles', 'Masters']);
/** Each plane's node size when the footprint check leaves room for it. */
export const ATLAS_SIZES = Object.freeze([3.2, 1.6, 1.2]);
/**
 * The footprint check: a node's size is at most this share of the distance to its nearest
 * neighbour on the plane, so two footprints (two sizes) never take more than 80% of the gap.
 */
export const FOOTPRINT_SHARE = 0.4;
/** The smallest size the footprint check draws. Below it a node would not be visible at all. */
export const MIN_SIZE = 0.12;
/** A hull's padding around its nodes, beyond their size, when nothing foreign is near it. */
export const HULL_MARGIN = 1.2;
/** A hull's padding is at most this share of the distance to the nearest node it must not hold. */
export const HULL_CLEARANCE_SHARE = 0.45;
/** The plane landmark masters belong on. */
export const MASTER_PLANE = 2;
export const NO_MASTERS = 'Landmark masters are not served by the atlas route yet, so this plane is empty.';
export const NO_MASTER_SLOTS = 'Landmark masters are served, but the rule that places them in their style\'s cell is not built yet, so this plane is empty.';
export const NO_COTAGS = 'Co-tagged styles are not served yet, so no co-tag edges are drawn.';
export const COTAGS_FAILED = 'Co-tagged styles could not be loaded, so no co-tag edges are drawn. The rest of the atlas is unchanged; select the style again to retry.';
/** What the view says before the first monthly run. */
export const EMPTY_MESSAGE = 'The Genre Atlas has no monthly run yet. It appears after the first monthly computation. The stage rule it will use is below.';

const STAGE_DESCRIPTIONS = Object.freeze({
    absent: (r) => `before the year it reaches ${num(r.emerge_total)} cumulative releases`,
    emerging: (r) => `trailing mean at least ${num(r.active_share)} × its peak, under ${num(r.establish_years)} years after emergence`,
    established: (r) => `trailing mean at least ${num(r.active_share)} × its peak, ${num(r.establish_years)} or more years after emergence`,
    reviving: (r) => `trailing mean under ${num(r.active_share)} × its peak, but at least ${num(r.revive_ratio)} × its trough and ${num(r.revive_floor)} × its peak`,
    declining: () => 'otherwise',
});
const BASIS_WORDS = Object.freeze({ release_year: 'release-year counts', master_year: 'master-year counts' });

function num(value) {
    return Number.isFinite(value) ? String(Number(value)) : '?';
}

function invalid(message) {
    throw new Error(`invalid style-atlas payload: ${message}`);
}

function finite(value, what) {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${what} is not a number`);
    return value;
}

function text(value, what) {
    if (typeof value !== 'string' || !value) invalid(`${what} is not a name`);
    return value;
}

function yearOrNull(value, what) {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value)) invalid(`${what} is not a year`);
    return value;
}

// ---------------------------------------------------------------------------------------------
// The payload.
// ---------------------------------------------------------------------------------------------

/**
 * Read a style-atlas body. Before the first monthly run the route answers 200 with no month, no
 * timeline, and empty lists, and the rule still present: that is `empty`, not an error.
 */
export function adaptAtlasPayload(payload) {
    if (!payload || typeof payload !== 'object') invalid('not an object');
    const rule = payload.rule && typeof payload.rule === 'object' ? payload.rule : invalid('no rule');
    if (!Array.isArray(rule.stages) || !rule.stages.every((stage) => typeof stage === 'string')) invalid('rule.stages is not a list of names');
    const base = { month: payload.month ?? null, computedAt: payload.computed_at ?? null, rule };
    if (payload.month == null || payload.timeline == null) return { ...base, empty: true, timeline: null, genres: [], styles: [], ghosts: [], masters: [] };

    const timeline = {
        firstYear: yearOrNull(payload.timeline.first_year, 'timeline.first_year') ?? invalid('no first year'),
        lastYear: yearOrNull(payload.timeline.last_year, 'timeline.last_year') ?? invalid('no last year'),
        provisionalFrom: yearOrNull(payload.timeline.provisional_from, 'timeline.provisional_from') ?? invalid('no provisional year'),
    };
    if (timeline.lastYear < timeline.firstYear) invalid('the timeline ends before it starts');
    const years = timeline.lastYear - timeline.firstYear + 1;

    const genres = (payload.genres || []).map((raw, i) => ({
        genre: text(raw.genre, `genres[${i}].genre`),
        ringOrder: finite(raw.ring_order, `genres[${i}].ring_order`),
        sectorStart: finite(raw.sector_start, `genres[${i}].sector_start`),
        sectorEnd: finite(raw.sector_end, `genres[${i}].sector_end`),
        x: finite(raw.x, `genres[${i}].x`),
        y: finite(raw.y, `genres[${i}].y`),
        emergenceYear: yearOrNull(raw.emergence_year, `genres[${i}].emergence_year`),
    }));
    const genreNames = new Set(genres.map((genre) => genre.genre));
    if (genreNames.size !== genres.length) invalid('a genre is listed twice');

    const styles = (payload.styles || []).map((raw, i) => {
        const where = `styles[${i}]`;
        const stages = Array.isArray(raw.stages) ? raw.stages : invalid(`${where}.stages is not a list`);
        if (stages.length !== years) invalid(`${where} has ${stages.length} stages for ${years} timeline years`);
        if (!stages.every((index) => Number.isInteger(index) && index >= 0 && index < rule.stages.length)) invalid(`${where}.stages holds an index outside rule.stages`);
        const parents = (raw.parents || []).map((parent, j) => ({
            genre: text(parent.genre, `${where}.parents[${j}].genre`),
            share: finite(parent.share, `${where}.parents[${j}].share`),
            dominant: parent.dominant === true,
            emergenceEdge: parent.emergence_edge === true,
        }));
        return {
            style: text(raw.style, `${where}.style`),
            genre: text(raw.genre, `${where}.genre`),
            x: finite(raw.x, `${where}.x`),
            y: finite(raw.y, `${where}.y`),
            stage: typeof raw.stage === 'string' ? raw.stage : invalid(`${where}.stage is not a name`),
            settledStage: typeof raw.settled_stage === 'string' ? raw.settled_stage : null,
            emergenceYear: yearOrNull(raw.emergence_year, `${where}.emergence_year`),
            stages,
            parents,
        };
    });
    const styleNames = new Set(styles.map((style) => style.style));
    if (styleNames.size !== styles.length) invalid('a style is listed twice');

    const ghosts = (payload.ghosts || []).map((raw, i) => ({
        style: text(raw.style, `ghosts[${i}].style`),
        genre: text(raw.genre, `ghosts[${i}].genre`),
        x: finite(raw.x, `ghosts[${i}].x`),
        y: finite(raw.y, `ghosts[${i}].y`),
    }));
    for (const ghost of ghosts) if (!styleNames.has(ghost.style)) invalid(`the ghost of ${ghost.style} has no style`);

    // Landmark masters, the top ones per style by release count. They come with no position;
    // layoutAtlas places them through a slot rule, never here. One master can be a landmark of
    // several styles, and is drawn in each one's cell.
    const masters = (payload.masters || []).map((raw, i) => ({
        masterId: raw.master_id != null ? String(raw.master_id) : invalid(`masters[${i}].master_id is missing`),
        title: typeof raw.title === 'string' ? raw.title : null,
        year: yearOrNull(raw.year, `masters[${i}].year`),
        style: text(raw.style, `masters[${i}].style`),
        releaseCount: Number.isInteger(raw.release_count) ? raw.release_count : null,
        rank: Number.isInteger(raw.rank) && raw.rank >= 1 ? raw.rank : null,
    }));
    const masterKeys = new Set(masters.map((master) => masterId(master.masterId, master.style)));
    if (masterKeys.size !== masters.length) invalid('a master is listed twice for one style');

    return { ...base, empty: false, timeline, genres, styles, ghosts, masters };
}

// ---------------------------------------------------------------------------------------------
// Valid time and the stage rule.
// ---------------------------------------------------------------------------------------------

/** A year clamped to the timeline. */
export function clampYear(timeline, year) {
    return Math.min(timeline.lastYear, Math.max(timeline.firstYear, Math.round(year)));
}

/** Whether a year is provisional: its counts still grow as the catalogue catches up. */
export function isProvisional(timeline, year) {
    return year >= timeline.provisionalFrom;
}

/** A style's stage name in a year of the timeline. */
export function stageAt(style, timeline, rule, year) {
    return rule.stages[style.stages[clampYear(timeline, year) - timeline.firstYear]];
}

/**
 * The stage rule as on-screen text, from the payload's `rule` (analytics-engine
 * LifecycleRule.describe()). Every stage gets its condition with the thresholds filled in, and
 * every threshold is also listed by name, so a rule this client has no words for is still shown.
 */
export function ruleText(rule) {
    const basis = BASIS_WORDS[rule.basis] || String(rule.basis || 'unknown counts');
    const thresholds = Object.entries(rule)
        .filter(([name, value]) => name !== 'rule_version' && typeof value === 'number')
        .map(([name, value]) => ({ name, value: num(value) }));
    const version = typeof rule.rule_version === 'string' ? rule.rule_version : 'unversioned';
    // The served id is internal (a design decision and its revision). The heading says the revision
    // alone; the full id stays in `version` for the detail line and its tooltip.
    const revision = /\/(\d+)$/.exec(version);
    return {
        version,
        title: `Stage rule${revision ? ` (version ${revision[1]})` : ''}`,
        stages: rule.stages.map((stage) => ({ stage, condition: STAGE_DESCRIPTIONS[stage] ? STAGE_DESCRIPTIONS[stage](rule) : 'defined by the rule; this view has no description for it' })),
        notes: [
            `Stages are judged over ${basis}.`,
            `The trailing mean is over ${num(rule.window)} years. Emergence is the first year with ${num(rule.emerge_total)} cumulative releases, not the first release.`,
            `The latest ${num(rule.provisional_years)} years are provisional: their counts still grow as the catalogue catches up.`,
        ],
        thresholds,
    };
}

// ---------------------------------------------------------------------------------------------
// The footprint check.
// ---------------------------------------------------------------------------------------------

/** The smallest distance between two points, or Infinity for fewer than two. */
export function nearestDistance(points) {
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
            if (d < best) best = d;
        }
    }
    return best;
}

/**
 * A plane's node size. The positions are the server's and cannot move to make room, so the size
 * gives way instead: the largest size up to the plane's own at which no two footprints touch.
 * `fit` is false when even MIN_SIZE footprints would touch (two nodes nearly on top of each other).
 */
export function atlasFootprint(points, size) {
    const nearest = nearestDistance(points);
    const room = FOOTPRINT_SHARE * nearest;
    return { size: Math.max(MIN_SIZE, Math.min(size, room)), nearest, fit: room >= MIN_SIZE };
}

/**
 * The master plane's footprint check. Its slots already clear each other (strata-master-slots.js),
 * so each master is sized from its own slot, by the same share of the gap as the other planes:
 * FOOTPRINT_SHARE of the slot spacing, twice the footprint radius. A crowded cell draws smaller
 * masters; there is no MIN_SIZE floor, since a floor would make them overlap. The result reports
 * the smallest size and spacing, and `fit` is false when the smallest is under MIN_SIZE. This
 * stays linear in the number of masters, where the pairwise check would not.
 */
export function masterFootprint(masters) {
    let size = Infinity;
    let nearest = Infinity;
    for (const node of masters) {
        const spacing = 2 * node.slotRadius * ATLAS_RADIUS;
        node.size = Math.min(ATLAS_SIZES[MASTER_PLANE], FOOTPRINT_SHARE * spacing);
        size = Math.min(size, node.size);
        nearest = Math.min(nearest, spacing);
    }
    return masters.length ? { size, nearest, fit: size >= MIN_SIZE } : { size: ATLAS_SIZES[MASTER_PLANE], nearest, fit: true };
}

// ---------------------------------------------------------------------------------------------
// The layout.
// ---------------------------------------------------------------------------------------------

export const genreId = (genre) => `g:${genre}`;
export const styleId = (style) => `s:${style}`;
export const ghostId = (style, genre) => `h:${style}@${genre}`;

function world(point) {
    return { x: point.x * ATLAS_RADIUS, z: -point.y * ATLAS_RADIUS };
}

function plainNode(id, level, point, extra) {
    return {
        id,
        level,
        kind: PLANE_KINDS[level],
        parent: null,
        group: null,
        children: [],
        agg: false,
        aggKind: null,
        lane: null,
        state: null,
        states: null,
        ax: point.x,
        ay: point.y,
        ...world(point),
        size: ATLAS_SIZES[level],
        ...extra,
    };
}

export const masterId = (id, style) => `m:${id}@${style}`;

/**
 * Lay out an adapted atlas. Every node keeps its served coordinates (`ax`, `ay`) and sits at
 * `x = ax * ATLAS_RADIUS`, `z = -ay * ATLAS_RADIUS` (north is away from the camera's home), the
 * same scale for every node, so the geography is the server's.
 *
 * The master plane is the seam for landmark masters. They are served with no position, and a
 * deterministic slot rule (strata-master-slots.js atlasMasterSlot, the rule concept C′ uses for
 * collector masters too) places each in its style's cell. With no rule, or no masters, the plane
 * is empty and says why.
 *
 * @param {object} atlas - from adaptAtlasPayload
 * @param {object} [options]
 * @param {((master: object, context: {style: object, sector: number[], cell: {x: number, y: number,
 *   radius: number}, masters: object[]}) => {x: number, y: number, radius: number}) | null}
 *   [options.masterSlot] - a master's slot in the unit disc, and the radius of its footprint, from
 *   the master, its style's primary node, host sector, and cell (strata-master-slots.js
 *   styleCells), and all the masters served for that style
 * @returns {{nodes: object[], edges: object[], hulls: object[], emergence: object[], footprint:
 *   object[], planes: object[], atlas: object}}
 */
export function layoutAtlas(atlas, { masterSlot = null } = {}) {
    const nodes = [];
    const byGenre = new Map();
    for (const genre of atlas.genres) {
        const node = plainNode(genreId(genre.genre), 0, genre, {
            entity: 'genre',
            label: genre.genre,
            genre: genre.genre,
            group: genreId(genre.genre),
            ringOrder: genre.ringOrder,
            sector: [genre.sectorStart, genre.sectorEnd],
            emergenceYear: genre.emergenceYear,
        });
        byGenre.set(genre.genre, node);
        nodes.push(node);
    }
    const host = (genre) => byGenre.get(genre) || null;
    const primaries = new Map();
    for (const style of atlas.styles) {
        const genre = host(style.genre);
        const node = plainNode(styleId(style.style), 1, style, {
            entity: 'style',
            label: style.style,
            style: style.style,
            genre: style.genre,
            parent: genre ? genre.id : null,
            group: genreId(style.genre),
            ghosts: [],
            data: style,
        });
        primaries.set(style.style, node);
        if (genre) genre.children.push(node.id);
        nodes.push(node);
    }
    for (const ghost of atlas.ghosts) {
        const primary = primaries.get(ghost.style);
        const genre = host(ghost.genre);
        const node = plainNode(ghostId(ghost.style, ghost.genre), 1, ghost, {
            entity: 'ghost',
            label: ghost.style,
            style: ghost.style,
            genre: ghost.genre,
            parent: genre ? genre.id : null,
            group: genreId(ghost.genre),
            ghostOf: primary.id,
            data: primary.data,
        });
        primary.ghosts.push(node.id);
        if (genre) genre.children.push(node.id);
        nodes.push(node);
    }
    const masters = atlas.masters || [];
    if (masterSlot && masters.length) {
        const cells = styleCells(atlas);
        const perStyle = new Map();
        for (const master of masters) {
            if (!perStyle.has(master.style)) perStyle.set(master.style, []);
            perStyle.get(master.style).push(master);
        }
        for (const master of masters) {
            const style = primaries.get(master.style);
            if (!style) continue;
            const point = masterSlot(master, { style: style.data, sector: host(style.genre)?.sector ?? null, cell: cells.get(master.style), masters: perStyle.get(master.style) });
            if (!Number.isFinite(point?.radius)) throw new Error(`the master slot rule gave master ${master.masterId} no footprint radius`);
            const node = plainNode(masterId(master.masterId, master.style), MASTER_PLANE, point, {
                entity: 'master',
                label: master.title || `Master ${master.masterId}`,
                style: master.style,
                genre: style.genre,
                parent: style.id,
                group: style.group,
                master,
                slotRadius: point.radius,
            });
            style.children.push(node.id);
            nodes.push(node);
        }
    }

    const footprint = [0, 1, 2].map((level) => {
        const onPlane = nodes.filter((node) => node.level === level);
        const check = level === MASTER_PLANE ? masterFootprint(onPlane) : atlasFootprint(onPlane.map((node) => [node.x, node.z]), ATLAS_SIZES[level]);
        if (level !== MASTER_PLANE) for (const node of onPlane) node.size = check.size;
        return { level, nodes: onPlane.length, ...check };
    });

    const layout = { nodes, edges: [], footprint, atlas };
    layout.hulls = atlasHulls(layout);
    layout.emergence = emergenceLinks(layout);
    layout.planes = ATLAS_PLANES.map((name, level) => ({
        level,
        name,
        count: nodes.filter((node) => node.level === level).length,
        note: level !== MASTER_PLANE || nodes.some((node) => node.level === level) ? null : masters.length ? NO_MASTER_SLOTS : NO_MASTERS,
    }));
    return layout;
}

/** The genres a drawn copy's style has as parents (share at or above the parent threshold). */
export function parentGenres(node) {
    if (node.entity === 'genre' || node.entity === 'master') return [];
    return node.data.parents.map((parent) => parent.genre);
}

// ---------------------------------------------------------------------------------------------
// Hulls.
// ---------------------------------------------------------------------------------------------

function segmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = dx * dx + dz * dz;
    const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

/** The distance from a point to a convex polygon (0 inside). A polygon may be a point or a segment. */
export function polygonDistance(p, polygon) {
    if (polygon.length >= 3 && inPoly(p, polygon)) return 0;
    if (polygon.length === 1) return Math.hypot(p[0] - polygon[0][0], p[1] - polygon[0][1]);
    let best = Infinity;
    for (let i = 0; i < polygon.length; i++) best = Math.min(best, segmentDistance(p, polygon[i], polygon[(i + 1) % polygon.length]));
    return best;
}

/**
 * One hull per genre on the style plane, around every style and ghost copy the genre hosts.
 *
 * The hull is the convex hull of the hosted nodes (the measure analytics-engine's hull_check and
 * the spike use), padded so the nodes sit inside it. The padding gives way before it reaches a node
 * the hull must not hold: one hosted elsewhere whose style does not have the genre as a parent. A
 * style's own primary node may sit inside a secondary parent's hull; that is not an intrusion.
 */
export function atlasHulls(layout) {
    const onPlane = layout.nodes.filter((node) => node.level === 1);
    const groups = new Map();
    for (const node of onPlane) {
        if (!groups.has(node.group)) groups.set(node.group, []);
        groups.get(node.group).push(node);
    }
    const genres = new Map(layout.nodes.filter((node) => node.level === 0).map((node) => [node.id, node]));
    const out = [];
    for (const [group, members] of groups) {
        const genre = genres.get(group)?.genre ?? group.slice(2);
        const points = members.map((node) => [node.x, node.z]);
        const core = hull(points);
        let clearance = Infinity;
        for (const node of onPlane) {
            if (node.group === group || parentGenres(node).includes(genre)) continue;
            clearance = Math.min(clearance, polygonDistance([node.x, node.z], core));
        }
        const size = members[0].size;
        const pad = Math.min(size + HULL_MARGIN, HULL_CLEARANCE_SHARE * clearance);
        out.push({
            group,
            genre,
            ringOrder: genres.get(group)?.ringOrder ?? out.length,
            polygon: roundedHull(points, pad),
            pad,
            members: members.map((node) => node.id),
            styles: members.filter((node) => node.entity === 'style').length,
            ghosts: members.filter((node) => node.entity === 'ghost').length,
        });
    }
    return out.sort((a, b) => a.ringOrder - b.ringOrder);
}

/** Style-plane nodes inside the hull of a genre that is neither their host nor a parent of their style. */
export function atlasHullIntrusions(layout) {
    const onPlane = layout.nodes.filter((node) => node.level === 1);
    let count = 0;
    for (const { group, genre, polygon } of layout.hulls) {
        for (const node of onPlane) {
            if (node.group === group || parentGenres(node).includes(genre)) continue;
            if (inPoly([node.x, node.z], polygon)) count++;
        }
    }
    return count;
}

/** Ghost copies that are not inside, or not counted in, their host genre's hull. */
export function ghostsOutsideHost(layout) {
    const byGroup = new Map(layout.hulls.map((h) => [h.group, h]));
    return layout.nodes.filter((node) => {
        if (node.entity !== 'ghost') return false;
        const hostHull = byGroup.get(node.group);
        return !hostHull || !hostHull.members.includes(node.id) || !inPoly([node.x, node.z], hostHull.polygon);
    });
}

// ---------------------------------------------------------------------------------------------
// Edges.
// ---------------------------------------------------------------------------------------------

/**
 * The emergence edges: from each drawn copy of a style to the genre whose sector it is drawn in,
 * where the payload marks that (style, parent) pair's `emergence_edge` (the style emerged in a
 * later year than the genre). A primary node links to its dominant parent and a ghost to the
 * secondary parent it is drawn under. Nothing else is drawn between the planes.
 */
export function emergenceLinks(layout) {
    const drawn = new Set(layout.nodes.map((node) => node.id));
    const links = [];
    for (const node of layout.nodes) {
        if (node.entity !== 'style' && node.entity !== 'ghost') continue;
        const parent = node.data.parents.find((entry) => entry.genre === node.genre);
        const to = genreId(node.genre);
        if (parent && parent.emergenceEdge && drawn.has(to)) links.push({ from: node.id, to, ghost: node.entity === 'ghost' });
    }
    return links;
}

/** The primary node of a style, a ghost, or null for a genre. */
export function primaryOf(byId, id) {
    const node = byId.get(id);
    if (!node || node.entity === 'genre' || node.entity === 'master') return null;
    return node.entity === 'ghost' ? byId.get(node.ghostOf) : node;
}

/**
 * Split a style's co-tagged styles by whether the atlas draws them: a pair is an edge only when
 * both of its styles are nodes here. The rest are not dropped; the panel lists them. Both halves
 * are best rank first.
 *
 * @param {Array<{other: string, release_count?: number, rank?: number}>} entries
 *   `GET /api/insights/style-atlas/cotags?style=<name>` entries
 * @returns {{drawn: Array<object>, listed: Array<object>}}
 */
export function splitCotags(byId, selected, entries) {
    const primary = selected == null ? null : primaryOf(byId, selected);
    const sorted = (entries || []).filter((entry) => entry && typeof entry.other === 'string');
    sorted.sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity));
    const drawn = [];
    const listed = [];
    for (const entry of sorted) {
        const other = byId.get(styleId(entry.other));
        (primary && other && other.id !== primary.id ? drawn : listed).push(entry);
    }
    return { drawn, listed };
}

/**
 * The lateral edges drawn for a selection: none without a selected style (no layout makes the
 * whole co-tag set crossing-free, gm-design-4804 B2), and for one a star around its primary node:
 * a `ghost` edge to each of its ghost copies, and a `cotag` edge to each co-tagged style the
 * `cotags` source names that is drawn, best rank first. A star has no crossings.
 *
 * @param {(style: string) => Array<{other: string, release_count?: number, rank?: number}>} [cotags]
 *   the selected style's co-tagged styles, in the shape of
 *   `GET /api/insights/style-atlas/cotags?style=<name>` entries
 */
export function lateralEdges(layout, byId, selected, cotags = () => []) {
    const primary = selected == null ? null : primaryOf(byId, selected);
    if (!primary) return [];
    const edges = primary.ghosts.map((id) => ({ a: primary.id, b: id, kind: 'ghost' }));
    for (const entry of splitCotags(byId, selected, cotags(primary.style)).drawn) {
        edges.push({ a: primary.id, b: styleId(entry.other), kind: 'cotag', rank: entry.rank ?? null, releaseCount: entry.release_count ?? null });
    }
    return edges;
}

/**
 * What stays lit for a selection: a style (or any of its copies) lights every copy and every
 * parent genre; a genre lights itself and everything it hosts.
 */
export function atlasSelection(byId, id) {
    const node = id == null ? null : byId.get(id);
    if (!node) return null;
    if (node.entity === 'genre') return new Set([node.id, ...node.children]);
    if (node.entity === 'master') return new Set([node.id, node.parent, ...(node.parent ? [byId.get(node.parent).parent] : [])].filter(Boolean));
    const primary = primaryOf(byId, id);
    const lit = new Set([primary.id, ...primary.ghosts, ...primary.children]);
    for (const genre of parentGenres(primary)) if (byId.has(genreId(genre))) lit.add(genreId(genre));
    return lit;
}

// ---------------------------------------------------------------------------------------------
// Paint: the stage of every node in a year.
// ---------------------------------------------------------------------------------------------

/**
 * Set each node's `stage` for a year of valid time, and `provisional` when the year is. A genre
 * has no served stage: it is `absent` before its emergence year and has no stage after. A
 * landmark master likewise, around its year.
 */
export function paintAtlas(layout, year) {
    const { timeline, rule } = layout.atlas;
    const at = clampYear(timeline, year);
    const provisional = isProvisional(timeline, at);
    for (const node of layout.nodes) {
        if (node.entity === 'genre') {
            node.stage = node.emergenceYear === null || at < node.emergenceYear ? 'absent' : null;
            node.provisional = false;
        } else if (node.entity === 'master') {
            // A master has no lifecycle stage: it is absent before its year and state-less after.
            node.stage = node.master.year !== null && at < node.master.year ? 'absent' : null;
            node.provisional = false;
        } else {
            node.stage = stageAt(node.data, timeline, rule, at);
            node.provisional = provisional;
        }
    }
    return { year: at, provisional };
}

/** Counts of styles (primary nodes only) per stage, for the legend. */
export function stageCounts(layout) {
    const counts = new Map();
    for (const node of layout.nodes) if (node.entity === 'style') counts.set(node.stage, (counts.get(node.stage) || 0) + 1);
    return counts;
}
