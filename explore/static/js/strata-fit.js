/**
 * The Fit landing point: concept C′ of ADR 0016 (section 4), a "Will it fit?" candidate drawn on
 * the Genre Atlas, over the collector's Taste Strata layer when they are signed in.
 *
 * The input is a `GET /api/fit/release/{id}` body (contracts/catalog-api/graph-explorer/v1), and
 * planLanding is the one place that reads it. A first-party session's components carry
 * `evidence_entries`: every entry behind the score, uncapped, each with `entity_type`,
 * `entity_id`, and `drawable` (catalog-api docs/cratefit.md). What is drawn follows
 * gm-design-4804 C2 and the Recommendation for C 1 and 2:
 *   - Affinity: the shared genre and style nodes;
 *   - Novelty: the candidate's unheld genre and style nodes;
 *   - Bridge: an edge between the hulls of the bridged genres (`genres`), one per pair, since the
 *     bridged regions are mutually separate;
 *   - Redundancy: the owned sibling under the same master (`master_id`), on the master node the
 *     slot rule already placed: a landmark, or the collector's own master from Taste Strata.
 * Only a `drawable: true` entry is drawn, and only in its component's shape. Depth, and artist or
 * label entries of any component, are listed beside the atlas and never get a position. So is a
 * drawable entry whose node is not on this atlas. A body without `evidence_entries` (an app token,
 * or a body cached before the field existed) is listed whole, sentence by sentence: nothing is
 * drawn and no position is invented.
 *
 * The module is pure (no DOM, no three.js). Its properties are Vitest tests
 * (__tests__/strata-fit.test.js): each drawn component's mapping, listed components never
 * producing a position, and the fallback.
 */

import { genreId, polygonDistance, styleId } from './strata-atlas-layout.js';
import { segmentsCross } from './strata-layout.js';

/** The five components, in the order the "Will it fit?" card names them. */
export const FIT_COMPONENTS = Object.freeze(['affinity', 'novelty', 'bridge', 'depth', 'redundancy']);
/** A component's on-screen name. */
export const FIT_LABELS = Object.freeze({ affinity: 'Affinity', novelty: 'Novelty', bridge: 'Bridge', depth: 'Depth', redundancy: 'Redundancy' });
/** What a drawn mark means, beside a node's label, so the cue is never color alone. */
export const FIT_MARK_WORDS = Object.freeze({ affinity: 'shared', novelty: 'new to you', redundancy: 'you hold this record' });

export const LANDING_FALLBACK = 'This profile names no atlas nodes, so nothing is drawn. Its evidence is listed instead.';
export const LANDING_NOT_ON_ATLAS = 'not drawn on this atlas';
export const LANDING_NO_SLOT = 'its master has no slot on this atlas';
export const LANDING_HULLS_TOUCH = 'the two hulls touch, so there is no gap to draw';
export const LANDING_NO_ATLAS = 'the atlas is not loaded';

const NODE_TYPES = new Set(['genre', 'style']);

function article(noun) {
    return /^[aeiou]/.test(noun) ? 'an' : 'a';
}

/**
 * An entry's sentence, as catalog-api writes it (api/fit.py _render_entry), so an uncapped entry
 * past the card's three reads the way the card's own lines do.
 */
export function entrySentence(entry) {
    const { kind, dimension = '', entity = '', count, detail } = entry;
    if (kind === 'shared') return `shares ${dimension} ${entity} with ${count} release${count === 1 ? '' : 's'} you hold`;
    if (kind === 'unheld') return `${entity} is ${article(dimension)} ${dimension} your collection has never held`;
    if (kind === 'thread') return `deepens ${dimension} ${entity} (${count} held)`;
    if (kind === 'bridge') return `bridges ${entity}, which share no artist or label in your collection`;
    if (kind === 'heuristic') return 'region boundaries are the v0 genre heuristic, not a computed community';
    if (kind === 'duplicate') return detail == null ? 'you already hold this exact release' : `you hold ${entity}, the same record on ${detail}`;
    if (kind === 'duplicate_title') return `you hold ${entity} by ${detail}, which no master links to this pressing`;
    return String(entity || kind || '');
}

/**
 * The claim a drawable entry makes on the atlas, in its component's shape, or null when the entry
 * is listed. The shape is checked here as well as `drawable`, so Depth, an artist, or a label is
 * never placed whatever the flag says.
 */
function claimOf(component, entry) {
    if (!entry || entry.drawable !== true) return null;
    const text = entrySentence(entry);
    if (component === 'affinity' || component === 'novelty') {
        if (!NODE_TYPES.has(entry.entity_type) || typeof entry.entity_id !== 'string' || !entry.entity_id) return null;
        return { component, kind: 'node', entityType: entry.entity_type, name: entry.entity_id, text };
    }
    if (component === 'bridge') {
        const genres = Array.isArray(entry.genres) ? [...new Set(entry.genres.filter((genre) => typeof genre === 'string' && genre))] : [];
        return genres.length >= 2 ? { component, kind: 'edge', genres, text } : null;
    }
    if (component === 'redundancy') {
        return entry.master_id != null && entry.master_id !== '' ? { component, kind: 'master', masterId: String(entry.master_id), text } : null;
    }
    return null;
}

/**
 * Read a Fit profile into what the atlas draws and what it lists.
 *
 * @param {object | null} profile - a `GET /api/fit/release/{id}` body
 * @returns {{release: {id: string, title: string | null, artist: string | null}, structured: boolean,
 *   claims: object[], listed: Array<{component: string, text: string}>} | null}
 */
export function planLanding(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const release = profile.release || {};
    const components = profile.components || {};
    const claims = [];
    const listed = [];
    let structured = false;
    for (const component of FIT_COMPONENTS) {
        const raw = components[component] || {};
        if (Array.isArray(raw.evidence_entries)) {
            structured = true;
            for (const entry of raw.evidence_entries) {
                if (!entry || typeof entry !== 'object') continue;
                const claim = claimOf(component, entry);
                if (claim) claims.push(claim);
                else listed.push({ component, text: entrySentence(entry) });
            }
        } else {
            for (const line of raw.evidence || []) if (typeof line === 'string' && line) listed.push({ component, text: line });
        }
    }
    return {
        release: { id: String(release.id ?? ''), title: release.title || null, artist: release.artist || null },
        structured,
        claims,
        listed,
    };
}

// ---------------------------------------------------------------------------------------------
// Placement on a layoutAtlas() result.
// ---------------------------------------------------------------------------------------------

function segmentPoint(p, a, b) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = dx * dx + dz * dz;
    const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length)) : 0;
    return [a[0] + t * dx, a[1] + t * dz];
}

function nearestOn(p, polygon) {
    if (polygon.length === 1) return polygon[0];
    let best = null;
    let bestDistance = Infinity;
    for (let i = 0; i < polygon.length; i++) {
        const q = segmentPoint(p, polygon[i], polygon[(i + 1) % polygon.length]);
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < bestDistance) {
            bestDistance = d;
            best = q;
        }
    }
    return best;
}

/**
 * The shortest segment between two hull polygons (`[x, z]` lists in world units, a single point
 * allowed), from a point on `a`'s boundary to one on `b`'s, or null when they touch or overlap.
 */
export function hullGap(a, b) {
    if (!a.length || !b.length) return null;
    const sides = (polygon) => (polygon.length < 2 ? [] : polygon.map((p, i) => [...p, ...polygon[(i + 1) % polygon.length]]));
    const bSides = sides(b);
    if (sides(a).some((side) => bSides.some((other) => segmentsCross(side, other)))) return null;
    let best = null;
    for (const [from, to, flip] of [[a, b, false], [b, a, true]]) {
        if (to.length >= 3 && from.some((p) => polygonDistance(p, to) === 0)) return null;
        for (const p of from) {
            const q = nearestOn(p, to);
            const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            if (!best || d < best.length) best = { from: flip ? q : p, to: flip ? p : q, length: d };
        }
    }
    return best && best.length > 1e-6 ? best : null;
}

/** A genre's region on the style plane: its hull, or its own node when it hosts no style. */
function genreRegion(layout, byId, genre) {
    const hull = layout.hulls.find((entry) => entry.genre === genre);
    if (hull) return hull.polygon;
    const node = byId.get(genreId(genre));
    return node ? [[node.x, node.z]] : null;
}

/**
 * Place a plan on a laid-out atlas. Nothing moves: a claim marks nodes the atlas already draws, or
 * joins two hulls it already draws, or it is not drawn and is said so.
 *
 * @param {object | null} layout - from layoutAtlas, or null before the atlas has loaded
 * @param {object} plan - from planLanding
 * @returns {{marks: Map<string, string>, edges: Array<{component: string, genres: string[],
 *   from: number[], to: number[]}>, drawn: Array<{component: string, text: string, nodes: string[]}>,
 *   notDrawn: Array<{component: string, text: string, reason: string}>}}
 */
export function placeLanding(layout, plan) {
    const marks = new Map();
    const edges = [];
    const drawn = [];
    const notDrawn = [];
    const byId = layout ? new Map(layout.nodes.map((node) => [node.id, node])) : new Map();
    const mark = (ids, component) => {
        for (const id of ids) if (!marks.has(id)) marks.set(id, component);
    };
    for (const claim of plan ? plan.claims : []) {
        const { component, text } = claim;
        if (!layout) {
            notDrawn.push({ component, text, reason: LANDING_NO_ATLAS });
            continue;
        }
        if (claim.kind === 'node') {
            const node = byId.get(claim.entityType === 'genre' ? genreId(claim.name) : styleId(claim.name));
            if (!node) {
                notDrawn.push({ component, text, reason: LANDING_NOT_ON_ATLAS });
                continue;
            }
            // A style is marked on its primary node and on every ghost copy, as Taste Strata marks it.
            const ids = [node.id, ...(node.ghosts || [])];
            mark(ids, component);
            drawn.push({ component, text, nodes: ids });
        } else if (claim.kind === 'edge') {
            // One edge per pair. A pair that cannot be drawn is named on its own, so a three-way
            // bridge with one touching pair still says which join is missing.
            const pairs = [];
            const missing = [];
            for (let i = 0; i < claim.genres.length; i++) {
                for (let j = i + 1; j < claim.genres.length; j++) {
                    const genres = [claim.genres[i], claim.genres[j]];
                    const a = genreRegion(layout, byId, genres[0]);
                    const b = genreRegion(layout, byId, genres[1]);
                    const gap = a && b ? hullGap(a, b) : null;
                    if (gap) pairs.push({ component, genres, from: gap.from, to: gap.to });
                    else missing.push({ component, text: `${genres[0]} and ${genres[1]}`, reason: a && b ? LANDING_HULLS_TOUCH : LANDING_NOT_ON_ATLAS });
                }
            }
            if (pairs.length) {
                edges.push(...pairs);
                drawn.push({ component, text, nodes: claim.genres.map(genreId).filter((id) => byId.has(id)) });
                notDrawn.push(...missing);
            } else notDrawn.push({ component, text, reason: missing[0].reason });
        } else if (claim.kind === 'master') {
            const ids = layout.nodes.filter((node) => node.entity === 'master' && node.master.masterId === claim.masterId).map((node) => node.id);
            if (!ids.length) {
                notDrawn.push({ component, text, reason: LANDING_NO_SLOT });
                continue;
            }
            mark(ids, component);
            drawn.push({ component, text, nodes: ids });
        }
    }
    return { marks, edges, drawn, notDrawn };
}

/**
 * Mark every node a placed landing names (`node.landing` is its component, else null) and set the
 * layout's `landingEdges`. With no placement, every mark is cleared. Nothing moves.
 *
 * @returns {number} the nodes marked
 */
export function paintLanding(layout, placed) {
    let marked = 0;
    for (const node of layout.nodes) {
        node.landing = placed?.marks.get(node.id) ?? null;
        if (node.landing) marked++;
    }
    layout.landingEdges = placed ? placed.edges : [];
    return marked;
}
