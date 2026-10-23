// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    CAMERA_HOME,
    CAMERA_LIMITS,
    LOD_NODE_LIMIT,
    TIE_TOLERANCE_PX,
    displayLabel,
    indexNodes,
    labelCandidates,
    levelOfDetail,
    lineage,
    nodeCentre,
    nodeStateKey,
    placeLabels,
    planCameraMove,
    planeY,
    prefersReducedMotion,
    renderKind,
    resolvePick,
    stepTween,
    verticalLinks,
    verticalLinksKey,
} from '../static/js/strata-scene.js';
import { adaptStrataPayload, layoutStrata } from '../static/js/strata-layout.js';
import { buildPayload, generateDiscography, rng } from './strata-fixtures.js';

const node = (id, level, extra = {}) => ({ id, level, kind: ['credit', 'master', 'release'][level], parent: null, children: [], x: 0, z: 0, size: 1, ...extra });
const hit = (n, x, y) => ({ node: n, screen: { x, y } });
const POINTER = { x: 100, y: 100 };

describe('resolvePick', () => {
    const credit = node('c', 0);
    const master = node('m', 1);
    const release = node('r', 2);
    const other = node('r2', 2);

    it('returns nothing when the ray hits nothing', () => {
        expect(resolvePick([], { pointer: POINTER })).toEqual({ node: null, candidates: [] });
    });

    it('picks the stacked node whose projected centre is under the pointer, not the nearest hit', () => {
        // The master is nearer the camera and covers the release, but the pointer is on the
        // release's centre. Nearest-hit picking would take the master.
        const hits = [hit(master, 112, 96), hit(master, 112, 96), hit(release, 101, 100)];
        const { node: picked, candidates } = resolvePick(hits, { pointer: POINTER });
        expect(picked).toBe(release);
        expect(candidates.map((c) => c.node)).toEqual([release, master]);
    });

    it('collects every hit along the ray once, however many faces it crosses', () => {
        const hits = [hit(credit, 140, 100), hit(master, 120, 100), hit(credit, 140, 100), hit(release, 130, 100), hit(master, 120, 100)];
        const { candidates } = resolvePick(hits, { pointer: POINTER });
        expect(candidates.map((c) => c.node.id)).toEqual(['m', 'r', 'c']);
    });

    it('breaks a tie between stacked nodes toward the selected node’s plane', () => {
        const hits = [hit(master, 100.5, 100), hit(release, 100, 100)];
        expect(resolvePick(hits, { pointer: POINTER, selectedLevel: 1 }).node).toBe(master);
        expect(resolvePick(hits, { pointer: POINTER, selectedLevel: 2 }).node).toBe(release);
    });

    it('breaks a tie toward the soloed plane first, then the selected plane', () => {
        const hits = [hit(master, 100, 100), hit(release, 100, 101)];
        expect(resolvePick(hits, { pointer: POINTER, solo: 2, selectedLevel: 1 }).node).toBe(release);
        expect(resolvePick(hits, { pointer: POINTER, solo: 1, selectedLevel: 2 }).node).toBe(master);
        // A tie the solo rule cannot settle (both on other planes) falls to the selected plane.
        expect(resolvePick([hit(credit, 100, 100), hit(release, 100, 101)], { pointer: POINTER, solo: 1, selectedLevel: 2 }).node).toBe(release);
    });

    it('lets the plane rule decide only within the tie tolerance', () => {
        const near = hit(master, 100 + TIE_TOLERANCE_PX / 2, 100);
        const far = hit(release, 100 + TIE_TOLERANCE_PX * 3, 100);
        expect(resolvePick([near, far], { pointer: POINTER, solo: 2, selectedLevel: 2 }).node).toBe(master);
    });

    it('settles a tie with no plane preference by the nearer centre, then the nearer hit', () => {
        expect(resolvePick([hit(master, 101.5, 100), hit(release, 100.5, 100)], { pointer: POINTER }).node).toBe(release);
        expect(resolvePick([hit(master, 100, 101), hit(other, 101, 100)], { pointer: POINTER }).node).toBe(master);
    });
});

describe('label candidates', () => {
    const c = node('c', 0, { children: ['m'] });
    const m = node('m', 1, { parent: 'c', children: ['r'] });
    const r = node('r', 2, { parent: 'm' });
    const m2 = node('m2', 1, { parent: 'c', children: ['r2'] });
    const r2 = node('r2', 2, { parent: 'm2' });
    const nodes = [c, m, m2, r, r2];
    const ids = (list) => list.map((item) => `${item.node.id}:${item.priority}`);

    it('labels credits and masters in the home view, credits first, and no pressings', () => {
        expect(ids(labelCandidates(nodes, { labelDepth: 1 }))).toEqual(['c:1', 'm:2', 'm2:2']);
    });

    it('always labels the hovered node, at the top priority', () => {
        expect(ids(labelCandidates(nodes, { labelDepth: 1, hovered: 'r2' }))).toEqual(['c:1', 'm:2', 'm2:2', 'r2:0']);
    });

    it('labels only the selection’s lineage while something is selected', () => {
        const byId = indexNodes({ nodes });
        const selection = lineage(byId, 'm');
        expect([...selection].sort()).toEqual(['c', 'm', 'r']);
        expect(ids(labelCandidates(nodes, { labelDepth: 1, selected: 'm', selection }))).toEqual(['c:0.5', 'm:0', 'r:0.7']);
    });

    it('labels only the soloed plane, all of it', () => {
        expect(ids(labelCandidates(nodes, { labelDepth: levelOfDetail({ distance: CAMERA_HOME.r, drawn: 5, solo: 2 }).labelDepth, solo: 2 }))).toEqual(['r:3', 'r2:3']);
    });

    it('labels zoomed-in pressings and keeps zoomed-out views to credits', () => {
        expect(labelCandidates(nodes, { labelDepth: levelOfDetail({ distance: 100, drawn: 5 }).labelDepth })).toHaveLength(5);
        expect(ids(labelCandidates(nodes, { labelDepth: levelOfDetail({ distance: 300, drawn: 5 }).labelDepth }))).toEqual(['c:1']);
    });

    it('makes candidates of a real layout’s credits and masters only', () => {
        const r0 = rng(7);
        const layout = layoutStrata(adaptStrataPayload(buildPayload(generateDiscography(r0, { maxReleases: 400 }), [3, 12, 16], { signedIn: true })));
        const candidates = labelCandidates(layout.nodes, { labelDepth: 1 });
        expect(candidates.length).toBe(layout.nodes.filter((n) => n.level <= 1).length);
        expect(candidates.every((item) => item.node.level <= 1)).toBe(true);
    });
});

describe('label placement', () => {
    const box = (id, priority, x, y) => ({ id, priority, x, y, w: 50, h: 16 });

    it('drops a label that would overlap one with a better priority', () => {
        const items = [box('b', 2, 20, 10), box('a', 1, 0, 0), box('c', 1, 200, 0)];
        const shown = placeLabels(items, [], 800, 600).map((item) => item.id);
        expect(shown).toEqual(['a', 'c']);
        expect(items.find((item) => item.id === 'b').shown).toBe(false);
    });

    it('always shows priority 0, even over a reserved box or off the viewport', () => {
        const items = [box('hover', 0, 10, 10), box('next', 1, 10, 10), box('off', 1, 900, 10)];
        const shown = placeLabels(items, [{ x: 0, y: 0, w: 150, h: 20 }], 800, 600).map((item) => item.id);
        expect(shown).toEqual(['hover']);
    });

    it('finds overlaps across grid cells', () => {
        const items = [box('a', 1, 60, 60), box('b', 2, 100, 70), box('c', 2, 63, 50)];
        expect(placeLabels(items, [], 800, 600).map((item) => item.id)).toEqual(['a']);
    });
});

describe('level of detail', () => {
    it('keeps full detail for a budgeted view at any distance', () => {
        expect(levelOfDetail({ distance: CAMERA_HOME.r, drawn: 31 })).toEqual({ labelDepth: 1, detail: 'high', halos: true });
        expect(levelOfDetail({ distance: CAMERA_LIMITS.rMax, drawn: 31 }).detail).toBe('high');
    });

    it('drops geometry detail and halos for a large view until the camera is close', () => {
        expect(levelOfDetail({ distance: CAMERA_HOME.r, drawn: LOD_NODE_LIMIT + 1 })).toEqual({ labelDepth: 1, detail: 'low', halos: false });
        expect(levelOfDetail({ distance: CAMERA_HOME.r * 0.6, drawn: 20000 })).toEqual({ labelDepth: 4, detail: 'high', halos: true });
    });

    it('labels deeper planes as the camera closes in', () => {
        expect([1.3, 1, 0.8, 0.5].map((k) => levelOfDetail({ distance: CAMERA_HOME.r * k, drawn: 10 }).labelDepth)).toEqual([0, 1, 2, 4]);
    });
});

describe('reduced motion', () => {
    const media = (reduce) => (query) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' });

    it('reads prefers-reduced-motion, and treats a missing matchMedia as no preference', () => {
        expect(prefersReducedMotion(media(true))).toBe(true);
        expect(prefersReducedMotion(media(false))).toBe(false);
        expect(prefersReducedMotion(undefined)).toBe(false);
    });

    it('turns a camera move into a jump under reduced motion', () => {
        const plan = planCameraMove({ ...CAMERA_HOME }, { r: 120, az: 1 }, { reduce: true, now: 0 });
        expect(plan.tween).toBeNull();
        expect(plan.cam).toMatchObject({ r: 120, az: 1, el: CAMERA_HOME.el });
    });

    it('tweens the same move otherwise, ending exactly on the target', () => {
        const plan = planCameraMove({ ...CAMERA_HOME }, { r: 120 }, { reduce: false, now: 1000 });
        expect(plan.cam.r).toBe(CAMERA_HOME.r);
        const middle = stepTween(plan.tween, 1000 + plan.tween.ms / 2);
        expect(middle.done).toBe(false);
        expect(middle.cam.r).toBeGreaterThan(120);
        expect(middle.cam.r).toBeLessThan(CAMERA_HOME.r);
        expect(stepTween(plan.tween, 1000 + plan.tween.ms)).toEqual({ cam: expect.objectContaining({ r: 120 }), done: true });
    });

    it('clamps the target to the camera limits', () => {
        expect(planCameraMove({ ...CAMERA_HOME }, { r: 1, el: 9 }, { reduce: true, now: 0 }).cam).toMatchObject({ r: CAMERA_LIMITS.rMin, el: CAMERA_LIMITS.elMax });
    });
});

describe('scene helpers', () => {
    it('draws entities, count nodes, and lanes as separate kinds, centred above their plane', () => {
        expect(renderKind({ agg: false })).toBe('entity');
        expect(renderKind({ agg: true })).toBe('aggregate');
        expect(renderKind({ agg: true, lane: 'nomaster' })).toBe('lane');
        const disc = nodeCentre({ ...node('r', 2), size: 1.35 });
        expect(disc.y).toBeGreaterThan(planeY(2));
        expect(disc.y).toBeLessThan(planeY(2) + 1.35);
        expect(planeY(0)).toBeGreaterThan(planeY(1));
    });

    it('names count nodes and lanes, which have no title', () => {
        expect(displayLabel({ lane: 'nomaster', agg: true })).toBe('Releases without a master');
        expect(displayLabel({ agg: true, aggKind: 'credits', credits: 4 })).toBe('+4 other credits');
        expect(displayLabel({ agg: true, level: 1, masters: 9, y0: 1970, y1: 1979 })).toBe('9 masters, 1970–1979');
        expect(displayLabel({ agg: true, level: 1, masters: 2, y0: null, y1: null })).toBe('2 masters, no year');
        expect(displayLabel({ agg: true, level: 2, releases: 12 })).toBe('+12 pressings');
        expect(displayLabel({ id: 'r:1', label: 'Blue Train' })).toBe('Blue Train');
    });

    it('colors a count node by the roll-up of the states it holds', () => {
        expect(nodeStateKey({ state: 'owned' })).toBe('owned');
        expect(nodeStateKey({ state: null, states: { none: 3, wanted: 1, owned: 0 } })).toBe('wanted');
        expect(nodeStateKey({ state: null, states: { none: 2 } })).toBe('none');
        expect(nodeStateKey({ state: null, states: null })).toBeNull();
    });

    it('links each node to its parent, lit inside the selection, and none on a soloed plane', () => {
        const nodes = [node('c', 0, { children: ['m'] }), node('m', 1, { parent: 'c', children: ['r'] }), node('r', 2, { parent: 'm' })];
        const byId = indexNodes({ nodes });
        expect(verticalLinks(nodes, byId, {}).main).toHaveLength(12);
        const lit = verticalLinks(nodes, byId, { selection: new Set(['m', 'r']) });
        expect([lit.main.length, lit.lit.length]).toEqual([6, 6]);
        expect(verticalLinks(nodes, byId, { solo: 1 })).toEqual({ main: [], lit: [] });
        expect(verticalLinksKey({ layoutVersion: 1, solo: null, selected: null })).not.toBe(verticalLinksKey({ layoutVersion: 1, solo: null, selected: 'm' }));
    });
});
