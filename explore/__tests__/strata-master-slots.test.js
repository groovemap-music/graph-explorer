/**
 * The deterministic L2 master slot rule's properties (strata-master-slots.js), over random master
 * sets of up to 25 landmarks and 25 collector masters per style, over generated atlases
 * (strata-atlas-fixtures.js), and over the body recorded from analytics-engine with the synthetic
 * landmark masters (tests/fixtures/style-atlas-masters.json):
 *   - every slot's footprint inside its cell, and every cell inside its sector and the disc;
 *   - no two slots overlapping, in one cell or across cells;
 *   - deterministic: the same masters and cell give the same slots, call after call;
 *   - independent of input order.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { nodeOverlaps } from '../static/js/strata-layout.js';
import { ATLAS_RADIUS, ATLAS_SIZES, FOOTPRINT_SHARE, MASTER_PLANE, NO_MASTERS, adaptAtlasPayload, layoutAtlas, masterId, styleId } from '../static/js/strata-atlas-layout.js';
import {
    CELL_MAX_RADIUS,
    COLLECTOR_SLOTS,
    LANDMARK_SLOTS,
    MASTER_SLOTS,
    atlasMasterSlot,
    hashId,
    masterSlots,
    slotIndices,
    slotPoint,
    styleCells,
} from '../static/js/strata-master-slots.js';
import { generateAtlasPayload, rng } from './strata-atlas-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', name), 'utf8'));
const BODY = fixture('style-atlas.json').body;
const MASTERS = fixture('style-atlas-masters.json').masters;
const EPSILON = 1e-12;

/** Up to 25 landmarks (ranks 1..n) and up to 25 collector masters, with mixed id shapes. */
function masterSet(r, { landmarks = r.int(0, LANDMARK_SLOTS), collectors = r.int(0, COLLECTOR_SLOTS) } = {}) {
    const ids = new Set();
    const id = () => {
        let next;
        do next = r.chance(0.5) ? String(r.int(1, 30_000_000)) : `mb:${r.int(0, 0xffffff).toString(16)}`;
        while (ids.has(next));
        ids.add(next);
        return next;
    };
    return [
        ...Array.from({ length: landmarks }, (_, i) => ({ masterId: id(), rank: i + 1 })),
        ...Array.from({ length: collectors }, () => ({ masterId: id(), rank: null })),
    ];
}

function shuffled(r, list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = r.int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function randomCell(r) {
    return { x: r() * 1.6 - 0.8, y: r() * 1.6 - 0.8, radius: 0.002 + r() * CELL_MAX_RADIUS };
}

/** Slot footprints that reach outside their cell, and pairs of footprints that overlap. */
function violations(cell, slots) {
    const list = [...slots.values()];
    let outside = 0;
    let overlaps = 0;
    for (const slot of list) if (Math.hypot(slot.x - cell.x, slot.y - cell.y) + slot.radius > cell.radius + EPSILON) outside++;
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            if (Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) < list[i].radius + list[j].radius - EPSILON) overlaps++;
        }
    }
    return { outside, overlaps };
}

const seeds = (count, seed0) => Array.from({ length: count }, (_, i) => seed0 + i);

describe('slots in one cell', () => {
    it.each(seeds(200, 1))('fit inside the cell and never overlap, for up to 25 + 25 masters (seed %i)', (seed) => {
        const r = rng(seed);
        const cell = randomCell(r);
        const masters = masterSet(r);
        const slots = masterSlots(cell, masters);
        expect(slots.size).toBe(masters.length);
        expect(violations(cell, slots)).toEqual({ outside: 0, overlaps: 0 });
    });

    it('fit and never overlap at full capacity, 25 landmarks and 25 collector masters', () => {
        for (const seed of seeds(50, 1000)) {
            const r = rng(seed);
            const cell = randomCell(r);
            const masters = masterSet(r, { landmarks: LANDMARK_SLOTS, collectors: COLLECTOR_SLOTS });
            const { indices, capacity } = slotIndices(masters);
            expect(capacity).toBe(MASTER_SLOTS);
            expect(new Set(indices.values()).size).toBe(MASTER_SLOTS);
            expect(violations(cell, masterSlots(cell, masters))).toEqual({ outside: 0, overlaps: 0 });
        }
    });

    it('widens past capacity and still fits without overlaps', () => {
        for (const [landmarks, collectors] of [[25, 26], [30, 25], [25, 120], [0, 400]]) {
            const r = rng(landmarks * 1000 + collectors);
            const cell = randomCell(r);
            const masters = masterSet(r, { landmarks, collectors });
            const { capacity } = slotIndices(masters);
            expect(capacity).toBeGreaterThan(MASTER_SLOTS);
            const slots = masterSlots(cell, masters);
            expect(slots.size).toBe(landmarks + collectors);
            expect(violations(cell, slots)).toEqual({ outside: 0, overlaps: 0 });
        }
    });

    it('is deterministic: the same masters and cell give the same slots', () => {
        for (const seed of seeds(50, 2000)) {
            const r = rng(seed);
            const cell = randomCell(r);
            const masters = masterSet(r);
            const copy = masters.map((master) => ({ ...master }));
            expect(masterSlots({ ...cell }, copy)).toEqual(masterSlots(cell, masters));
            for (const master of masters) expect(atlasMasterSlot(master, { cell, masters })).toEqual(slotPoint(cell, slotIndices(masters).indices.get(master.masterId)));
        }
        expect(hashId('12345')).toBe(hashId(12345));
        expect(hashId('12345')).not.toBe(hashId('12346'));
    });

    it('does not depend on input order', () => {
        for (const seed of seeds(100, 3000)) {
            const r = rng(seed);
            const cell = randomCell(r);
            const masters = masterSet(r);
            const expected = masterSlots(cell, masters);
            for (let k = 0; k < 5; k++) {
                const slots = masterSlots(cell, shuffled(r, masters));
                for (const [id, slot] of expected) expect(slots.get(id)).toEqual(slot);
            }
        }
    });

    it('puts landmarks in rank order from the centre, and collector masters after them', () => {
        const r = rng(7);
        const masters = masterSet(r, { landmarks: 12, collectors: 20 });
        const { indices } = slotIndices(masters);
        for (const master of masters) {
            if (master.rank) expect(indices.get(master.masterId)).toBe(master.rank - 1);
            else expect(indices.get(master.masterId)).toBeGreaterThanOrEqual(LANDMARK_SLOTS);
        }
        const cell = { x: 0.2, y: -0.1, radius: 0.04 };
        const distance = (id) => {
            const slot = masterSlots(cell, masters).get(id);
            return Math.hypot(slot.x - cell.x, slot.y - cell.y);
        };
        const top = masters.find((master) => master.rank === 1).masterId;
        for (const master of masters) if (master.masterId !== top) expect(distance(top)).toBeLessThan(distance(master.masterId));
    });

    it('keeps a collector master in its slot when landmarks come and go', () => {
        const r = rng(11);
        const masters = masterSet(r, { landmarks: 25, collectors: 18 });
        const collectors = masters.filter((master) => !master.rank);
        const alone = slotIndices(collectors).indices;
        const withLandmarks = slotIndices(masters).indices;
        for (const master of collectors) expect(withLandmarks.get(master.masterId)).toBe(alone.get(master.masterId));
    });

    it('gives an id listed twice one slot, as a landmark if either listing is one', () => {
        const masters = [{ masterId: '9', rank: null }, { masterId: '9', rank: 2 }, { masterId: '4', rank: 1 }, { masterId: '5', rank: null }];
        const { indices } = slotIndices(masters);
        expect([...indices.keys()].sort()).toEqual(['4', '5', '9']);
        expect(indices.get('4')).toBe(0);
        expect(indices.get('9')).toBe(1);
    });
});

describe('cells', () => {
    const cellsHold = (payload) => {
        const atlas = adaptAtlasPayload(payload);
        const cells = styleCells(atlas);
        const sectors = new Map(atlas.genres.map((genre) => [genre.genre, genre]));
        expect(cells.size).toBe(atlas.styles.length);
        const drawn = [...atlas.styles, ...atlas.ghosts];
        let overlaps = 0;
        let crossings = 0;
        for (const style of atlas.styles) {
            const cell = cells.get(style.style);
            expect([cell.x, cell.y]).toEqual([style.x, style.y]);
            expect(cell.radius).toBeGreaterThan(0);
            expect(cell.radius).toBeLessThanOrEqual(CELL_MAX_RADIUS);
            expect(Math.hypot(cell.x, cell.y) + cell.radius).toBeLessThanOrEqual(1);
            // Clear of every other drawn style-plane node by twice its radius, so no two cells meet.
            for (const other of drawn) if (other !== style && Math.hypot(other.x - cell.x, other.y - cell.y) < 2 * cell.radius - EPSILON) overlaps++;
            // Inside its genre's sector: the cell never reaches across either edge.
            const genre = sectors.get(style.genre);
            for (const angle of [genre.sectorStart, genre.sectorEnd]) {
                const across = Math.abs(cell.x * Math.sin(angle) - cell.y * Math.cos(angle));
                if (cell.x * Math.cos(angle) + cell.y * Math.sin(angle) > 0 && across < cell.radius - EPSILON) crossings++;
            }
        }
        expect({ overlaps, crossings }).toEqual({ overlaps: 0, crossings: 0 });
        return cells;
    };

    it('hold for the body recorded from analytics-engine', () => cellsHold(BODY));

    it.each(seeds(40, 1))('hold for generated atlas %i', (seed) => cellsHold(generateAtlasPayload(rng(seed))));
});

describe('on the atlas master plane', () => {
    const withMasters = { ...BODY, masters: MASTERS };

    it('draws every served landmark of the synthetic fixture, inside its style cell, with no overlaps', () => {
        const atlas = adaptAtlasPayload(withMasters);
        const layout = layoutAtlas(atlas, { masterSlot: atlasMasterSlot });
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        const masters = layout.nodes.filter((node) => node.level === MASTER_PLANE);
        expect(masters).toHaveLength(MASTERS.length);
        expect(layout.planes[MASTER_PLANE]).toMatchObject({ count: MASTERS.length, note: null });
        const cells = styleCells(atlas);
        for (const raw of MASTERS) {
            const node = byId.get(masterId(raw.master_id, raw.style));
            const cell = cells.get(raw.style);
            expect(node.parent).toBe(styleId(raw.style));
            expect(Math.hypot(node.ax - cell.x, node.ay - cell.y) + node.slotRadius).toBeLessThanOrEqual(cell.radius + EPSILON);
            expect(node.size).toBeCloseTo(Math.min(ATLAS_SIZES[MASTER_PLANE], FOOTPRINT_SHARE * 2 * node.slotRadius * ATLAS_RADIUS), 12);
        }
        // The one master that is a landmark of two styles is drawn in both cells.
        const shared = MASTERS.filter((raw) => raw.master_id === MASTERS[0].master_id);
        expect(shared).toHaveLength(2);
        expect(new Set(shared.map((raw) => masterId(raw.master_id, raw.style))).size).toBe(2);
        expect(nodeOverlaps(layout, MASTER_PLANE)).toBe(0);
    });

    it('fills every cell to 25 + 25 masters on the recorded body without one overlap on the plane', () => {
        const r = rng(4804);
        const masters = BODY.styles.flatMap((style) => masterSet(r, { landmarks: LANDMARK_SLOTS, collectors: COLLECTOR_SLOTS }).map((master) => ({ master_id: `${style.style}/${master.masterId}`, style: style.style, rank: master.rank })));
        const layout = layoutAtlas(adaptAtlasPayload({ ...BODY, masters }), { masterSlot: atlasMasterSlot });
        expect(layout.nodes.filter((node) => node.level === MASTER_PLANE)).toHaveLength(BODY.styles.length * MASTER_SLOTS);
        expect(nodeOverlaps(layout, MASTER_PLANE)).toBe(0);
    });

    it('lays out the same plane for the masters in any order', () => {
        const r = rng(9);
        const place = (masters) => {
            const layout = layoutAtlas(adaptAtlasPayload({ ...BODY, masters }), { masterSlot: atlasMasterSlot });
            return new Map(layout.nodes.filter((node) => node.level === MASTER_PLANE).map((node) => [node.id, [node.ax, node.ay, node.size]]));
        };
        const expected = place(MASTERS);
        for (let k = 0; k < 3; k++) expect(place(shuffled(r, MASTERS))).toEqual(expected);
    });

    it('says the plane is empty only when no masters are served', () => {
        const layout = layoutAtlas(adaptAtlasPayload(BODY), { masterSlot: atlasMasterSlot });
        expect(layout.nodes.filter((node) => node.level === MASTER_PLANE)).toEqual([]);
        expect(layout.planes[MASTER_PLANE].note).toBe(NO_MASTERS);
    });
});
