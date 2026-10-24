/**
 * Taste Strata (strata-taste.js): the signed-in collector's layer on the Genre Atlas.
 *
 * The L2 properties run the collector's masters through the one slot rule the landmarks use
 * (strata-master-slots.js, by way of layoutAtlas), over generated atlases with random landmarks and
 * random collections, and over the recorded atlas with the synthetic projection
 * (tests/fixtures/taste-projection.json):
 *   - deterministic: the same atlas and collection give the same slots, in any input order;
 *   - every collector master's footprint inside its dominant style's cell;
 *   - no two footprints overlapping on the master plane, landmarks and collector masters together;
 *   - landmarks keep their slots, and collector masters keep theirs when landmarks change.
 * The L0 and L1 marks, masterless counting, and transaction time are covered after them.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { nodeOverlaps } from '../static/js/strata-layout.js';
import { MASTER_PLANE, adaptAtlasPayload, ghostId, layoutAtlas, masterId, styleId, genreId } from '../static/js/strata-atlas-layout.js';
import { COLLECTOR_SLOTS, LANDMARK_SLOTS, atlasMasterSlot, styleCells } from '../static/js/strata-master-slots.js';
import { CollectorState } from '../static/js/strata-collector.js';
import {
    adaptTasteProjection,
    dominantStyle,
    heldCounts,
    paintTaste,
    recordedYears,
    stateAsOf,
    tasteEntry,
    withCollectorMasters,
} from '../static/js/strata-taste.js';
import { generateAtlasPayload, rng } from './strata-atlas-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', name), 'utf8'));
const ATLAS = { ...fixture('style-atlas.json').body, masters: fixture('style-atlas-masters.json').masters };
const TASTE = fixture('taste-projection.json').body;
const EPSILON = 1e-12;
const STATES = ['owned', 'wanted', 'wanted_owned'];

const seeds = (count, seed0) => Array.from({ length: count }, (_, i) => seed0 + i);

function shuffled(r, list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = r.int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function span(r, { dated = r.chance(0.85) } = {}) {
    if (!dated) return { first: null, last: null, undated: 1 };
    const first = Date.UTC(r.int(2005, 2025), r.int(0, 11), r.int(1, 28));
    return { first: new Date(first).toISOString(), last: new Date(first + r.int(0, 3) * 3.15e10).toISOString(), undated: 0 };
}

function entry(r, id) {
    const state = STATES[r.int(0, 2)];
    return {
        id,
        items: r.int(1, 40),
        owned: state === 'wanted' ? 0 : r.int(1, 20),
        wanted: state === 'owned' ? 0 : r.int(1, 20),
        state,
        recorded_at: { owned: state === 'wanted' ? null : span(r), wanted: state === 'owned' ? null : span(r) },
    };
}

/**
 * A generated atlas with up to 25 landmarks per style (some of them landmarks of two styles), and
 * a random collection over it: masters carrying one to three styles, some not drawn, some landmarks.
 */
function generated(seed, { collectors = null } = {}) {
    const r = rng(seed);
    const payload = generateAtlasPayload(r, { styles: r.int(20, 120) });
    const styles = payload.styles.map((style) => style.style);
    const masters = [];
    let next = 1;
    for (const style of styles) {
        const count = r.chance(0.3) ? 0 : r.int(1, LANDMARK_SLOTS);
        for (let rank = 1; rank <= count; rank++) masters.push({ master_id: r.chance(0.05) && masters.length ? masters[r.int(0, masters.length - 1)].master_id : next++, style, rank });
    }
    // A master is listed at most once per style.
    const seen = new Set();
    payload.masters = masters.filter((master) => !seen.has(`${master.master_id}@${master.style}`) && seen.add(`${master.master_id}@${master.style}`));
    const held = new Set();
    const taste = { totals: { items: 0, owned: 0, wanted: 0, wanted_owned: 0, masterless_items: r.int(0, 30), genre_only_items: 0, unplaced_items: 0 }, recorded_at: { owned: span(r), wanted: span(r) }, genres: [], styles: [], masters: [] };
    const total = collectors ?? r.int(0, 400);
    for (let i = 0; i < total; i++) {
        const landmark = payload.masters.length && r.chance(0.05) ? payload.masters[r.int(0, payload.masters.length - 1)] : null;
        const id = landmark ? String(landmark.master_id) : r.chance(0.5) ? String(5_000_000 + r.int(0, 9_999_999)) : `mb:${r.int(0, 0xffffff).toString(16)}`;
        if (held.has(id)) continue;
        held.add(id);
        const own = Array.from({ length: r.int(1, 3) }, () => (r.chance(0.05) ? 'Not On This Atlas' : styles[r.int(0, styles.length - 1)]));
        if (landmark) own.push(landmark.style);
        taste.masters.push({ ...entry(r, id), year: r.chance(0.9) ? r.int(1950, 2025) : null, genres: [], styles: [...new Set(own)].sort() });
    }
    for (const style of styles) if (r.chance(0.5)) taste.styles.push(entry(r, style));
    taste.totals.items = taste.masters.length + taste.totals.masterless_items;
    return { payload, taste };
}

function lay(payload, taste) {
    const atlas = adaptAtlasPayload(payload);
    const projection = taste ? adaptTasteProjection(taste) : null;
    const placed = projection ? withCollectorMasters(atlas, projection) : null;
    const layout = layoutAtlas(placed ? placed.atlas : atlas, { masterSlot: atlasMasterSlot });
    paintTaste(layout, projection);
    return { atlas, projection, placed, layout };
}

const masterNodes = (layout) => layout.nodes.filter((node) => node.level === MASTER_PLANE);
const slotsOf = (layout) => new Map(masterNodes(layout).map((node) => [node.id, [node.ax, node.ay, node.slotRadius]]));

/** Footprints outside their cell, and overlapping pairs inside one cell (cells never meet). */
function violations(atlas, layout) {
    const cells = styleCells(atlas);
    const perCell = new Map();
    let outside = 0;
    for (const node of masterNodes(layout)) {
        const cell = cells.get(node.style);
        if (Math.hypot(node.ax - cell.x, node.ay - cell.y) + node.slotRadius > cell.radius + EPSILON) outside++;
        if (!perCell.has(node.style)) perCell.set(node.style, []);
        perCell.get(node.style).push(node);
    }
    let overlaps = 0;
    for (const nodes of perCell.values()) {
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const [a, b] = [nodes[i], nodes[j]];
                if (Math.hypot(a.ax - b.ax, a.ay - b.ay) < a.slotRadius + b.slotRadius - EPSILON) overlaps++;
                if (Math.hypot(a.x - b.x, a.z - b.z) < a.size + b.size - EPSILON) overlaps++;
            }
        }
    }
    return { outside, overlaps };
}

describe('L2: collector masters in deterministic slots', () => {
    it.each(seeds(60, 1))('stay inside their cell and clear of every landmark and each other (generated atlas %i)', (seed) => {
        const { payload, taste } = generated(seed);
        const { atlas, layout, placed } = lay(payload, taste);
        expect(masterNodes(layout).filter((node) => node.master.collector)).toHaveLength(placed.placed);
        expect(violations(atlas, layout)).toEqual({ outside: 0, overlaps: 0 });
    });

    it('stay inside and clear when a cell holds far more than 25 collector masters', () => {
        for (const seed of seeds(5, 500)) {
            const { payload, taste } = generated(seed, { collectors: 0 });
            const style = payload.styles[0].style;
            const r = rng(seed);
            for (let i = 0; i < 180; i++) taste.masters.push({ ...entry(r, `c${seed}-${i}`), year: null, genres: [], styles: [style] });
            const { atlas, layout } = lay(payload, taste);
            expect(masterNodes(layout).filter((node) => node.master.collector && node.style === style)).toHaveLength(180);
            expect(violations(atlas, layout)).toEqual({ outside: 0, overlaps: 0 });
        }
    });

    it('are deterministic: the same atlas and collection give the same slots, in any order', () => {
        for (const seed of seeds(20, 100)) {
            const { payload, taste } = generated(seed);
            const expected = slotsOf(lay(payload, taste).layout);
            expect(slotsOf(lay(structuredClone(payload), structuredClone(taste)).layout)).toEqual(expected);
            const r = rng(seed);
            const reordered = { ...taste, masters: shuffled(r, taste.masters) };
            expect(slotsOf(lay({ ...payload, masters: shuffled(r, payload.masters) }, reordered).layout)).toEqual(expected);
        }
    });

    it('leave every landmark in its slot while a cell holds 25 collector masters or fewer', () => {
        for (const seed of seeds(20, 200)) {
            const { payload, taste } = generated(seed, { collectors: 120 });
            const without = slotsOf(lay(payload, null).layout);
            const { layout } = lay(payload, taste);
            const crowded = new Set();
            const perStyle = new Map();
            for (const node of masterNodes(layout)) if (node.master.collector) perStyle.set(node.style, (perStyle.get(node.style) || 0) + 1);
            for (const [style, count] of perStyle) if (count > COLLECTOR_SLOTS) crowded.add(style);
            for (const node of masterNodes(layout)) {
                if (node.master.collector || crowded.has(node.style)) continue;
                expect([node.ax, node.ay, node.slotRadius]).toEqual(without.get(node.id));
            }
        }
    });

    it('keep their slots when the landmarks of their cell change', () => {
        for (const seed of seeds(20, 300)) {
            const { payload, taste } = generated(seed, { collectors: 60 });
            const before = lay(payload, taste).layout;
            const r = rng(seed);
            const landmarks = new Set(taste.masters.map((master) => master.id));
            // Drop a random share of the landmarks the collector does not hold, and rank the rest anew.
            const kept = payload.masters.filter((master) => landmarks.has(String(master.master_id)) || r.chance(0.5));
            const ranks = new Map();
            const reranked = kept.map((master) => {
                const rank = (ranks.get(master.style) || 0) + 1;
                ranks.set(master.style, rank);
                return { ...master, rank };
            });
            const after = slotsOf(lay({ ...payload, masters: reranked }, taste).layout);
            for (const node of masterNodes(before)) if (node.master.collector) expect(after.get(node.id)).toEqual([node.ax, node.ay, node.slotRadius]);
        }
    });

    it('place the synthetic projection on the recorded atlas without one overlap on the plane', () => {
        const { atlas, layout, placed } = lay(ATLAS, TASTE);
        expect(placed).toMatchObject({ placed: 3, landmarks: 1, notDrawn: 1 });
        const collectors = masterNodes(layout).filter((node) => node.master.collector);
        expect(collectors.map((node) => node.id).sort()).toEqual([masterId('7100001', 'Copper Drift'), masterId('7100002', 'Amber Bop'), masterId('7100003', 'Dusty Drift')].sort());
        for (const node of collectors) expect(node.parent).toBe(styleId(node.style));
        expect(violations(atlas, layout)).toEqual({ outside: 0, overlaps: 0 });
        expect(nodeOverlaps(layout, MASTER_PLANE)).toBe(0);
    });
});

describe('the dominant style', () => {
    const drawn = new Set(['A', 'B', 'C']);

    it('is the best-ranked style a master is a landmark of, so it shares the landmark\'s slot', () => {
        const landmarks = new Map([['9', [{ style: 'C', rank: 4 }, { style: 'B', rank: 2 }, { style: 'A', rank: 2 }]]]);
        expect(dominantStyle({ masterId: '9', styles: ['C'] }, { landmarks, drawn })).toEqual({ style: 'A', landmark: true });
    });

    it('is otherwise the drawn style the collector holds most items on, then the first by name', () => {
        const held = new Map([['B', { items: 5 }], ['C', { items: 9 }]]);
        expect(dominantStyle({ masterId: '1', styles: ['A', 'B', 'C', 'Z'] }, { drawn, held })).toEqual({ style: 'C', landmark: false });
        expect(dominantStyle({ masterId: '1', styles: ['C', 'A'] }, { drawn })).toEqual({ style: 'A', landmark: false });
    });

    it('never draws a master twice: a served master with no rank is marked in place too', () => {
        const atlas = adaptAtlasPayload({ ...ATLAS, masters: [{ master_id: 7100002, style: 'Copper Swing' }] });
        const taste = adaptTasteProjection(TASTE);
        const placed = withCollectorMasters(atlas, taste);
        expect(placed.atlas.masters.filter((master) => master.masterId === '7100002')).toHaveLength(1);
        expect(placed).toMatchObject({ placed: 3, landmarks: 1, notDrawn: 1 });
    });

    it('is null when none of the master\'s styles is drawn', () => {
        expect(dominantStyle({ masterId: '1', styles: ['Z'] }, { drawn })).toBeNull();
        expect(dominantStyle({ masterId: '1', styles: [] }, { drawn })).toBeNull();
    });
});

describe('L0 and L1 marks', () => {
    it('mark every served genre and style the collector holds, ghosts included, never anything else', () => {
        const { layout, projection } = lay(ATLAS, TASTE);
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        for (const genre of TASTE.genres) expect(byId.get(genreId(genre.id)).held).toMatchObject({ items: genre.items, owned: genre.owned, wanted: genre.wanted });
        // Copper Drift is drawn under Pop with a ghost copy under Blues: an item lands on both.
        expect(byId.get(styleId('Copper Drift')).held).toEqual({ state: CollectorState.WANTED_OWNED, items: 1, owned: 1, wanted: 1 });
        expect(byId.get(ghostId('Copper Drift', 'Blues')).held).toEqual(byId.get(styleId('Copper Drift')).held);
        const held = layout.nodes.filter((node) => node.held);
        for (const node of held) expect(tasteEntry(projection, node)).not.toBeNull();
        expect(layout.nodes.filter((node) => !node.held && tasteEntry(projection, node))).toEqual([]);
        // The landmark the collector holds is marked where it already is.
        expect(byId.get(masterId('910001', 'Amber Bop')).held).toMatchObject({ state: CollectorState.OWNED });
        expect(heldCounts(layout).get(CollectorState.OWNED)).toBeGreaterThan(0);
    });

    it('counts masterless items and draws nothing for them', () => {
        const { layout, projection } = lay(ATLAS, TASTE);
        expect(projection.totals).toMatchObject({ masterlessItems: 2, genreOnlyItems: 1 });
        // Every master but the one with no drawn style; masterless items have no node at all.
        const held = masterNodes(layout).filter((node) => node.held);
        expect(new Set(held.map((node) => node.master.masterId))).toEqual(new Set(['910001', '7100001', '7100002', '7100003']));
        // 910001 is a landmark of two styles, so it is drawn, and marked, in both cells.
        expect(held.filter((node) => node.master.masterId === '910001').map((node) => node.style).sort()).toEqual(ATLAS.masters.filter((raw) => raw.master_id === 910001).map((raw) => raw.style).sort());
        expect(held.filter((node) => node.master.masterId === '910001')).toHaveLength(2);
    });

    it('clear every mark without a projection', () => {
        const { layout } = lay(ATLAS, TASTE);
        paintTaste(layout, null);
        expect(layout.nodes.some((node) => node.held || node.heldLater)).toBe(false);
    });
});

describe('transaction time', () => {
    const taste = adaptTasteProjection(TASTE);

    it('spans the years Discogs recorded, and none when it recorded none', () => {
        expect(recordedYears(taste)).toEqual({ first: 2014, last: 2024 });
        expect(recordedYears(adaptTasteProjection({ ...TASTE, recorded_at: { owned: { first: null, last: null, undated: 3 }, wanted: null } }))).toBeNull();
    });

    it('replays each state from when it was first recorded, and keeps an undated one for now', () => {
        const copper = taste.styles.get('Copper Drift');
        expect(stateAsOf(copper, 2013)).toBeNull();
        expect(stateAsOf(copper, 2014)).toBe(CollectorState.WANTED);
        expect(stateAsOf(copper, 2015)).toBe(CollectorState.WANTED_OWNED);
        expect(stateAsOf(copper, null)).toBe(CollectorState.WANTED_OWNED);
        const dusty = taste.styles.get('Dusty Drift');
        expect(stateAsOf(dusty, 2030)).toBeNull();
        expect(stateAsOf(dusty, null)).toBe(CollectorState.OWNED);
        // A time with a UTC offset is an instant: 2019-03-02T10:00-08:00 is in 2019 everywhere.
        expect(stateAsOf(taste.byMaster.get('910001'), 2018)).toBeNull();
        expect(stateAsOf(taste.byMaster.get('910001'), 2019)).toBe(CollectorState.OWNED);
    });

    it('unmarks what was recorded later, and moves nothing', () => {
        const { layout, projection } = lay(ATLAS, TASTE);
        const positions = layout.nodes.map((node) => [node.id, node.x, node.z]);
        const marked = paintTaste(layout, projection, 2016);
        const byId = new Map(layout.nodes.map((node) => [node.id, node]));
        expect(byId.get(styleId('Copper Drift')).held.state).toBe(CollectorState.WANTED_OWNED);
        expect(byId.get(styleId('Amber Bop')).held).toBeNull();
        expect(byId.get(styleId('Amber Bop')).heldLater).toBe(true);
        expect(byId.get(masterId('7100003', 'Dusty Drift')).held).toBeNull();
        expect(marked).toEqual({ genres: 2, styles: 1, masters: 0, collectors: 1 });
        expect(layout.nodes.map((node) => [node.id, node.x, node.z])).toEqual(positions);
    });
});

describe('the payload', () => {
    it('reads the synthetic projection', () => {
        const taste = adaptTasteProjection(TASTE);
        expect(taste.totals).toEqual({ items: 7, owned: 5, wanted: 3, wantedOwned: 1, masterlessItems: 2, genreOnlyItems: 1, unplacedItems: 0 });
        expect(taste.genres.get('Electronic').state).toBe(CollectorState.WANTED_OWNED);
        expect(taste.masters.map((master) => master.masterId)).toEqual(TASTE.masters.map((master) => master.id));
        expect(taste.recordedAt.owned).toEqual({ first: Date.parse('2015-06-10T12:00:00Z'), last: Date.parse('2022-02-14T08:00:00Z'), undated: 1 });
    });

    it.each([
        ['not an object', null],
        ['no totals', { ...TASTE, totals: undefined }],
        ['a list that is not one', { ...TASTE, styles: {} }],
        ['an unknown state', { ...TASTE, styles: [{ ...TASTE.styles[0], state: 'none' }] }],
        ['a negative count', { ...TASTE, genres: [{ ...TASTE.genres[0], items: -1 }] }],
        ['a master with no id', { ...TASTE, masters: [{ ...TASTE.masters[0], id: null }] }],
    ])('refuses %s', (_, body) => {
        expect(() => adaptTasteProjection(body)).toThrow(/invalid taste-projection payload/);
    });
});
