/**
 * Deterministic L2 master slots: where a master sits on the master plane, inside its style's cell.
 *
 * Masters are served with no position. ADR 0016 section 4 (C′) gives them "deterministic slots in
 * their dominant style cell, computed with B's layout" (gm-design-4804 C1 and Recommendation for
 * C 4). This module is that rule, shared by the Genre Atlas landmarks and Taste Strata's collector
 * masters, so a master that is both lands in the same place in both views.
 *
 * The cell. A style's cell is a disc around its primary node (the served position in its home
 * sector) with the largest radius that keeps it clear of everything it must not cross: half the
 * distance to the nearest other drawn style-plane node (a style or a ghost copy), so no two cells
 * overlap; the edges of its genre's sector; the rim of the unit disc; and CELL_MAX_RADIUS, so an
 * isolated style's masters stay under it.
 *
 * The slots. A cell has MASTER_SLOTS slots on a golden-angle (Vogel) spiral, from its centre out.
 * The first LANDMARK_SLOTS are for landmarks in rank order, so the top landmark sits under its
 * style; the next COLLECTOR_SLOTS are for every other master. A collector master's preferred slot
 * is a hash of its id, and a taken slot passes it to the next free one, in a fixed order (hash,
 * then id), so the result is the same for any input order. The spiral's points are at least
 * VOGEL_SPACING / √capacity of its radius apart, so each slot owns a footprint disc of radius
 * `radius` that touches no other slot's, nor the cell's edge. More masters than slots widen the
 * spiral by whole blocks of COLLECTOR_SLOTS: the slots crowd, but still never overlap.
 *
 * The module is pure (no DOM, no three.js, no randomness beyond the id hash). Its properties are
 * Vitest tests (__tests__/strata-master-slots.test.js): every slot inside its cell, no two slots
 * overlapping, deterministic, and independent of input order.
 */

/** Landmark slots per cell: the atlas route serves the top 25 masters per style (gm-design-4804 C1). */
export const LANDMARK_SLOTS = 25;
/** Collector-master slots per cell, after the landmarks. */
export const COLLECTOR_SLOTS = 25;
/** A cell's slots before it widens. */
export const MASTER_SLOTS = LANDMARK_SLOTS + COLLECTOR_SLOTS;
/** The largest cell radius, in unit-disc units (2.3 world units on the atlas). */
export const CELL_MAX_RADIUS = 0.05;
/**
 * The spacing the slot footprints are cut to: on a Vogel spiral of n points over a unit disc, no
 * two points are closer than 1.546 / √n (measured for every n from 25 to 400 in steps of 25).
 */
export const VOGEL_SPACING = 1.5;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** A 32-bit FNV-1a hash of an id: the only source of spread in the slot rule. */
export function hashId(id) {
    const text = String(id);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** The distance from a point to the ray from the origin at `angle`. */
function rayDistance(x, y, angle) {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    return x * ux + y * uy < 0 ? Math.hypot(x, y) : Math.abs(x * uy - y * ux);
}

/**
 * Every style's cell, from an adapted atlas (strata-atlas-layout.js adaptAtlasPayload): a map from
 * style name to `{x, y, radius}` in unit-disc units, centred on the style's primary node.
 */
export function styleCells(atlas) {
    const sectors = new Map(atlas.genres.map((genre) => [genre.genre, [genre.sectorStart, genre.sectorEnd]]));
    const drawn = [...atlas.styles, ...atlas.ghosts];
    const cells = new Map();
    for (const style of atlas.styles) {
        let radius = Math.min(CELL_MAX_RADIUS, 1 - Math.hypot(style.x, style.y));
        for (const other of drawn) {
            if (other !== style) radius = Math.min(radius, Math.hypot(other.x - style.x, other.y - style.y) / 2);
        }
        const sector = sectors.get(style.genre);
        if (sector) for (const angle of sector) radius = Math.min(radius, rayDistance(style.x, style.y, angle));
        cells.set(style.style, { x: style.x, y: style.y, radius: Math.max(0, radius) });
    }
    return cells;
}

const isLandmark = (master) => Number.isInteger(master.rank) && master.rank >= 1;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Each master's slot index in its cell, and the cell's capacity. `masters` are one style's
 * masters, `{masterId, rank}`; a master with an integer rank of 1 or more is a landmark. An id
 * listed twice takes one slot, as a landmark if either listing is one.
 *
 * @param {Array<{masterId: string, rank?: number | null}>} masters
 * @returns {{indices: Map<string, number>, capacity: number}}
 */
export function slotIndices(masters) {
    const unique = new Map();
    for (const master of masters) {
        const id = String(master.masterId);
        const seen = unique.get(id);
        if (!seen || (isLandmark(master) && (!isLandmark(seen) || master.rank < seen.rank))) unique.set(id, { id, rank: master.rank });
    }
    const landmarks = [...unique.values()].filter(isLandmark).sort((a, b) => a.rank - b.rank || byText(a.id, b.id));
    const collectors = [...unique.values()]
        .filter((master) => !isLandmark(master))
        .map((master) => ({ id: master.id, hash: hashId(master.id) }))
        .sort((a, b) => a.hash - b.hash || byText(a.id, b.id));
    const start = Math.max(LANDMARK_SLOTS, landmarks.length);
    const room = COLLECTOR_SLOTS * Math.max(1, Math.ceil(collectors.length / COLLECTOR_SLOTS));
    const indices = new Map(landmarks.map((master, i) => [master.id, i]));
    const taken = new Array(room).fill(false);
    for (const { id, hash } of collectors) {
        let at = hash % room;
        while (taken[at]) at = (at + 1) % room;
        taken[at] = true;
        indices.set(id, start + at);
    }
    return { indices, capacity: start + room };
}

/**
 * Slot `index` of a cell with `capacity` slots: `{x, y, radius}`, the slot's centre and the radius
 * of its footprint, in unit-disc units. Every footprint lies inside the cell, and no two overlap.
 */
export function slotPoint(cell, index, capacity = MASTER_SLOTS) {
    const share = VOGEL_SPACING / (2 * Math.sqrt(capacity));
    const spiral = cell.radius / (1 + share);
    const r = spiral * Math.sqrt((index + 0.5) / capacity);
    const angle = index * GOLDEN_ANGLE;
    return { x: cell.x + r * Math.cos(angle), y: cell.y + r * Math.sin(angle), radius: spiral * share };
}

/** Every master's slot in one cell: a map from master id to `{x, y, radius}`. */
export function masterSlots(cell, masters) {
    const { indices, capacity } = slotIndices(masters);
    return new Map([...indices].map(([id, index]) => [id, slotPoint(cell, index, capacity)]));
}

const placed = new WeakMap();

/**
 * The slot rule in layoutAtlas's `masterSlot` shape: a master's slot in its style's `cell`, among
 * the style's `masters`. The slots of one `masters` list are worked out once.
 */
export function atlasMasterSlot(master, { cell, masters }) {
    let slots = placed.get(masters);
    if (!slots || slots.cell !== cell) {
        slots = { cell, at: masterSlots(cell, masters) };
        placed.set(masters, slots);
    }
    return slots.at.get(String(master.masterId));
}
