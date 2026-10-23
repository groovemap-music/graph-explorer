import { afterEach, describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { StrataRenderer, STRATA_TOKENS } from '../static/js/strata-renderer.js';
import { CAMERA_HOME, MAX_NODE_LABELS, PLANE_GAP, SOLO_ELEVATION, cameraPose, nodeCentre } from '../static/js/strata-scene.js';
import { COLLECTOR_STATES, stateTokenName } from '../static/js/strata-collector.js';
import { PLANE_SIZES, adaptStrataPayload, layoutStrata } from '../static/js/strata-layout.js';
import { buildPayload, generateDiscography, generateEdges, rng } from './strata-fixtures.js';
import { syntheticLayout } from './strata-synthetic.js';

const RECT = { left: 0, top: 0, width: 800, height: 600 };

// Every token the renderer reads, as hex, so jsdom needs no stylesheet.
const TOKENS = new Map([
    ...[STRATA_TOKENS.canvas, STRATA_TOKENS.planeFill, STRATA_TOKENS.planeLine, STRATA_TOKENS.link, STRATA_TOKENS.accent, STRATA_TOKENS.hover, STRATA_TOKENS.stateless].map((name, i) => [name, `#10203${i}`]),
    ...STRATA_TOKENS.hull.map((name, i) => [name, `#4040${i}0`]),
    ...Object.values(STRATA_TOKENS.edge).map((name, i) => [name, `#5050${i}0`]),
    ...COLLECTOR_STATES.flatMap((state, i) => ['light', 'dark'].map((theme) => [stateTokenName(state, theme), `#a0${i}0${theme === 'dark' ? 'f' : '0'}0`])),
]);
TOKENS.set(STRATA_TOKENS.canvas, '#000000');

// The GPU seam: everything but the draw.
function stubGL() {
    return { draws: 0, setPixelRatio() {}, setSize() {}, render() { this.draws++; }, dispose() { this.disposed = true; } };
}

function fakeMedia(reduce) {
    const listeners = new Set();
    const query = {
        matches: reduce,
        addEventListener: (type, fn) => listeners.add(fn),
        removeEventListener: (type, fn) => listeners.delete(fn),
    };
    return {
        matchMedia: (text) => (text === '(prefers-reduced-motion: reduce)' ? query : { matches: false }),
        set(value) {
            query.matches = value;
            for (const fn of listeners) fn({ matches: value });
        },
        listeners,
    };
}

let mounted = [];

function mount({ reduce = false, layout = null } = {}) {
    const stage = document.createElement('div');
    document.body.append(stage);
    const media = fakeMedia(reduce);
    let clock = 0;
    const gl = stubGL();
    const renderer = new StrataRenderer(stage, {
        createRenderer: () => gl,
        readToken: (name) => TOKENS.get(name) || '',
        theme: () => 'dark',
        matchMedia: media.matchMedia,
        measure: () => RECT,
        now: () => clock,
        requestFrame: () => 1,
        cancelFrame: () => {},
        pixelRatio: 1,
    });
    if (layout) renderer.setLayout(layout);
    mounted.push(renderer);
    return { renderer, stage, gl, media, advance: (ms) => (clock += ms), at: () => clock };
}

afterEach(() => {
    for (const renderer of mounted) if (renderer.layout !== null || renderer.canvas.isConnected) renderer.dispose();
    mounted = [];
    document.body.textContent = '';
});

function realLayout(seed = 3, budget = [3, 12, 16]) {
    const r = rng(seed);
    const payload = buildPayload(generateDiscography(r, { maxReleases: 600 }), budget, { signedIn: true });
    return layoutStrata(adaptStrataPayload(payload), { edges: generateEdges(r, payload) });
}

const layoutNode = (id, level, x, z, extra = {}) => ({
    id,
    level,
    kind: ['credit', 'master', 'release'][level],
    parent: null,
    group: 'c',
    children: [],
    agg: false,
    aggKind: null,
    lane: null,
    state: null,
    states: null,
    label: id,
    x,
    z,
    size: PLANE_SIZES[level],
    ...extra,
});

/**
 * A credit, a master, and a release stacked so that the camera's ray through the release's centre
 * also passes through the master's centre: both project to the same pixel, a perfect tie.
 */
function stackedLayout(cam) {
    const eye = cameraPose(cam).position;
    const release = layoutNode('r', 2, 10, 8, { parent: 'm' });
    const rc = nodeCentre(release);
    const masterY = nodeCentre(layoutNode('m', 1, 0, 0)).y;
    const t = (masterY - eye.y) / (rc.y - eye.y);
    const master = layoutNode('m', 1, eye.x + t * (rc.x - eye.x), eye.z + t * (rc.z - eye.z), { parent: 'c', children: ['r'] });
    const credit = layoutNode('c', 0, -30, -20, { children: ['m', 'r2p'] });
    const sideMaster = layoutNode('r2p', 1, -30, -25, { parent: 'c', children: ['r2'] });
    const sideRelease = layoutNode('r2', 2, -30, -25, { parent: 'r2p' });
    return {
        nodes: [credit, master, sideMaster, release, sideRelease],
        edges: [],
        axis: { y0: 1950, y1: 2026, fromX: -48, toX: 54, undatedX: -56 },
        depth: { usable: 1, required: 1, fit: 1 },
        page: null,
        rootCredit: 'c',
    };
}

describe('scene', () => {
    it('draws one InstancedMesh per plane and render kind, holding every node once', () => {
        const layout = realLayout();
        const { renderer } = mount({ layout });
        const kinds = new Set(layout.nodes.map((n) => `${n.level}|${n.lane ? 'lane' : n.agg ? 'aggregate' : 'entity'}`));
        expect(renderer.instanced.map((e) => `${e.level}|${e.kind}`).sort()).toEqual([...kinds].sort());
        expect(renderer.instanced.every((e) => e.mesh.isInstancedMesh)).toBe(true);
        const held = renderer.instanced.flatMap((e) => e.nodes.map((n) => n.id));
        expect(held.sort()).toEqual(layout.nodes.map((n) => n.id).sort());
    });

    it('keeps a 20,000-node layout to a few dozen draw objects', () => {
        const layout = syntheticLayout({ nodes: 20000 });
        const { renderer } = mount({ layout });
        renderer.render();
        const counts = renderer.drawCounts();
        expect(layout.nodes).toHaveLength(20000);
        expect(counts.instancedMeshes).toBeLessThanOrEqual(9);
        expect(counts.objects).toBeLessThan(60);
    });

    it('merges each plane’s lateral edges into ribbons, one mesh per plane and kind', () => {
        const layout = syntheticLayout({ nodes: 2000 });
        const { renderer } = mount({ layout });
        const kinds = new Set(layout.edges.map((e) => `${layout.nodes.find((n) => n.id === e.a).level}|${e.kind}`));
        expect(renderer.edgeObjects).toHaveLength(kinds.size);
        expect(layout.edges.length).toBeGreaterThan(kinds.size);
    });

    it('colors nodes by collector state and dims everything outside the selection', () => {
        const layout = stackedLayout(CAMERA_HOME);
        layout.nodes[3].state = 'owned';
        const { renderer } = mount({ layout });
        const colorOf = (id) => {
            const entry = renderer.instanced.find((e) => e.nodes.some((n) => n.id === id));
            const color = new THREE.Color();
            entry.mesh.getColorAt(entry.nodes.findIndex((n) => n.id === id), color);
            return `#${color.getHexString()}`;
        };
        const owned = TOKENS.get(stateTokenName('owned', 'dark'));
        expect(colorOf('r')).toBe(owned);
        expect(colorOf('r2')).toBe(TOKENS.get(STRATA_TOKENS.stateless));
        renderer.select('m');
        expect(colorOf('r')).toBe(owned);
        expect(colorOf('r2')).not.toBe(TOKENS.get(STRATA_TOKENS.stateless));
    });
});

describe('resolve picking through the scene', () => {
    it('picks the release under the pointer through the master stacked in front of it', () => {
        const cam = { ...CAMERA_HOME, el: 1.2 };
        const layout = stackedLayout(cam);
        // Move the master off the release's ray, but still in front of it on screen.
        layout.nodes[1].x += 1.2;
        const { renderer } = mount({ layout });
        renderer.setCamera(cam);
        const release = renderer.screenPosition(renderer.byId.get('r'));
        const { node, candidates } = renderer.hitsAt(release.x, release.y);
        // The ray meets the master first: nearest-hit picking would return it.
        const nearest = renderer.raycaster.intersectObjects(renderer.instanced.map((e) => e.mesh), false)[0];
        expect(nearest.object.userData.nodes[nearest.instanceId].id).toBe('m');
        expect(candidates.map((c) => c.node.id)).toEqual(['r', 'm']);
        expect(node.id).toBe('r');
        const master = renderer.screenPosition(renderer.byId.get('m'));
        expect(renderer.pick(master.x, master.y).id).toBe('m');
    });

    it('breaks a perfect tie toward the selected node’s plane', () => {
        const cam = { ...CAMERA_HOME, el: 1.2 };
        const { renderer } = mount({ layout: stackedLayout(cam) });
        renderer.setCamera(cam);
        const p = renderer.screenPosition(renderer.byId.get('r'));
        const m = renderer.screenPosition(renderer.byId.get('m'));
        expect(Math.hypot(m.x - p.x, m.y - p.y)).toBeLessThan(0.01);
        expect(renderer.hitsAt(p.x, p.y).candidates.map((c) => c.node.id).sort()).toEqual(['m', 'r']);
        renderer.select('r2p');
        expect(renderer.pick(p.x, p.y).id).toBe('m');
        renderer.select('r2');
        expect(renderer.pick(p.x, p.y).id).toBe('r');
        renderer.select('r2p');
        expect(renderer.pick(m.x, m.y).id).toBe('m');
    });

    it('picks only on the soloed plane, which hides the others', () => {
        const cam = { ...CAMERA_HOME, el: 1.2 };
        const { renderer } = mount({ layout: stackedLayout(cam), reduce: true });
        renderer.solo(2);
        renderer.setCamera(cam);
        const p = renderer.screenPosition(renderer.byId.get('r'));
        expect(renderer.hitsAt(p.x, p.y).candidates.map((c) => c.node.id)).toEqual(['r']);
    });

    it('selects on a click and orbits on a drag', () => {
        const cam = { ...CAMERA_HOME, el: 1.2 };
        const layout = stackedLayout(cam);
        layout.nodes[1].x += 1.2;
        const { renderer } = mount({ layout });
        renderer.setCamera(cam);
        const selected = [];
        renderer.addEventListener('select', (event) => selected.push(event.detail.id));
        const p = renderer.screenPosition(renderer.byId.get('r'));
        const fire = (type, x, y) => renderer.canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0 }));
        fire('pointerdown', p.x, p.y);
        fire('pointerup', p.x, p.y);
        expect(selected).toEqual(['r']);
        const az = renderer.cam.az;
        fire('pointerdown', p.x, p.y);
        fire('pointermove', p.x + 40, p.y);
        fire('pointerup', p.x + 40, p.y);
        expect(renderer.cam.az).not.toBe(az);
        expect(selected).toEqual(['r']);
    });
});

describe('hover, select, and solo', () => {
    it('reports each change once, with the node', () => {
        const { renderer } = mount({ layout: stackedLayout(CAMERA_HOME), reduce: true });
        const events = [];
        for (const type of ['hover', 'select', 'solo']) renderer.addEventListener(type, (event) => events.push([type, 'id' in event.detail ? event.detail.id : event.detail.level, event.detail.node?.level]));
        renderer.hover('m');
        renderer.hover('m');
        renderer.select('r');
        renderer.solo(2);
        renderer.solo(null);
        renderer.select(null);
        renderer.hover('missing');
        expect(events).toEqual([
            ['hover', 'm', 1],
            ['select', 'r', 2],
            ['hover', null, undefined],
            ['solo', 2, undefined],
            ['solo', null, undefined],
            ['select', null, undefined],
        ]);
    });

    it('hovers from pointer moves once a frame, by resolve picking', () => {
        const cam = { ...CAMERA_HOME, el: 1.2 };
        const layout = stackedLayout(cam);
        layout.nodes[1].x += 1.2;
        const { renderer } = mount({ layout });
        renderer.setCamera(cam);
        const p = renderer.screenPosition(renderer.byId.get('r'));
        renderer.canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: p.x, clientY: p.y }));
        expect(renderer.hovered).toBeNull();
        renderer.tick(0);
        expect(renderer.hovered).toBe('r');
        renderer.canvas.dispatchEvent(new MouseEvent('pointerleave'));
        expect(renderer.hovered).toBeNull();
    });

    it('keeps the selection across a new layout that still draws it, and drops it otherwise', () => {
        const layout = stackedLayout(CAMERA_HOME);
        const { renderer } = mount({ layout });
        renderer.select('r');
        renderer.setLayout(stackedLayout(CAMERA_HOME));
        expect(renderer.selected).toBe('r');
        renderer.setLayout(realLayout());
        expect(renderer.selected).toBeNull();
    });

    it('rejects a plane that does not exist', () => {
        const { renderer } = mount({ layout: stackedLayout(CAMERA_HOME) });
        expect(() => renderer.solo(5)).toThrow(RangeError);
    });
});

describe('labels', () => {
    const labels = (stage) => [...stage.querySelectorAll('.strata-label')];

    it('creates label elements only for candidates, and never for pressings in the home view', () => {
        const layout = syntheticLayout({ nodes: 20000 });
        const { renderer, stage } = mount({ layout });
        renderer.render();
        const created = labels(stage);
        expect(renderer.stats.labelCandidates).toBe(layout.nodes.filter((n) => n.level <= 1).length);
        expect(created.length).toBeGreaterThan(0);
        expect(created.length).toBeLessThanOrEqual(MAX_NODE_LABELS);
        const byId = new Map(layout.nodes.map((n) => [n.id, n]));
        expect(created.every((el) => byId.get(el.dataset.node).level <= 1)).toBe(true);
    });

    it('shows placed labels with CSSOM transforms and hides the rest with the hidden attribute', () => {
        const { renderer, stage } = mount({ layout: realLayout() });
        renderer.render();
        const shown = labels(stage).filter((el) => !el.hidden);
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.every((el) => /^translate\(-?[\d.]+px, -?[\d.]+px\)$/.test(el.style.transform))).toBe(true);
        renderer.solo(2);
        renderer.render();
        const visible = labels(stage).filter((el) => !el.hidden);
        expect(visible.every((el) => renderer.byId.get(el.dataset.node).level === 2)).toBe(true);
    });

    it('labels pressings once the camera is close, and the selection’s lineage only', () => {
        const layout = realLayout();
        const { renderer, stage } = mount({ layout, reduce: true });
        renderer.render();
        const home = renderer.stats.labelCandidates;
        renderer.zoom('in');
        renderer.zoom('in');
        renderer.zoom('in');
        renderer.render();
        expect(renderer.stats.labelCandidates).toBe(layout.nodes.length);
        expect(renderer.stats.labelCandidates).toBeGreaterThan(home);
        const release = layout.nodes.find((n) => n.level === 2 && n.parent);
        renderer.select(release.id);
        renderer.render();
        expect(renderer.stats.labelCandidates).toBe(renderer.selection.size);
        expect(labels(stage).filter((el) => !el.hidden).every((el) => renderer.selection.has(el.dataset.node))).toBe(true);
    });
});

describe('reduced motion', () => {
    const moves = {
        'zoom in': (r) => r.zoom('in'),
        'zoom out': (r) => r.zoom('out'),
        reset: (r) => {
            r.orbit(1);
            r.resetCamera();
        },
        solo: (r) => r.solo(0),
        'leave solo': (r) => {
            r.solo(2);
            r.tick(r.now() + 10000);
            r.solo(null);
        },
    };

    for (const [name, move] of Object.entries(moves)) {
        it(`jumps instead of tweening for ${name} when reduced motion is preferred`, () => {
            const { renderer } = mount({ layout: realLayout(), reduce: true });
            move(renderer);
            const after = { ...renderer.cam };
            expect(renderer.tween).toBeNull();
            renderer.tick(renderer.now() + 16);
            expect(renderer.stats.tweenFrames).toBe(0);
            expect(renderer.cam).toEqual(after);
        });

        it(`tweens ${name} over several frames otherwise`, () => {
            const { renderer, advance } = mount({ layout: realLayout() });
            move(renderer);
            expect(renderer.tween).not.toBeNull();
            const target = { ...renderer.tween.to };
            const frames = renderer.stats.tweenFrames;
            for (let i = 0; i < 40; i++) renderer.tick(advance(16));
            expect(renderer.stats.tweenFrames - frames).toBeGreaterThan(20);
            expect(renderer.tween).toBeNull();
            for (const key of Object.keys(target)) expect(renderer.cam[key]).toBeCloseTo(target[key], 6);
        });
    }

    it('lands a running tween at once when the preference turns on', () => {
        const { renderer, media } = mount({ layout: realLayout() });
        renderer.zoom('in');
        const target = renderer.tween.to.r;
        media.set(true);
        expect(renderer.tween).toBeNull();
        expect(renderer.cam.r).toBeCloseTo(target, 6);
        renderer.zoom('in');
        expect(renderer.tween).toBeNull();
    });

    it('stops listening when disposed', () => {
        const { renderer, media, stage } = mount({ layout: realLayout() });
        expect(media.listeners.size).toBe(1);
        renderer.dispose();
        expect(media.listeners.size).toBe(0);
        expect(stage.querySelector('canvas')).toBeNull();
        expect(stage.querySelector('.strata-labels')).toBeNull();
    });

    it('looks straight down at a soloed plane', () => {
        const { renderer } = mount({ layout: realLayout(), reduce: true });
        renderer.solo(1);
        expect(renderer.cam).toMatchObject({ fy: 1, el: SOLO_ELEVATION });
        expect(renderer.camera.position.y).toBeGreaterThan(PLANE_GAP);
    });
});

describe('vertical links and level of detail', () => {
    it('rebuilds vertical links only when the layout, solo, or selection changes', () => {
        const layout = realLayout();
        const { renderer } = mount({ layout, reduce: true });
        renderer.render();
        expect(renderer.stats.verticalBuilds).toBe(1);
        renderer.orbit(0.4);
        renderer.render();
        renderer.tilt(0.2);
        renderer.zoom('in');
        renderer.render();
        renderer.hover(layout.nodes[0].id);
        renderer.render();
        expect(renderer.stats.verticalBuilds).toBe(1);
        renderer.select(layout.nodes.find((n) => n.level === 2).id);
        renderer.render();
        expect(renderer.stats.verticalBuilds).toBe(2);
        renderer.solo(1);
        renderer.render();
        expect(renderer.links.main.geometry.getAttribute('position').count).toBe(0);
        renderer.solo(null);
        renderer.setLayout(layout);
        renderer.render();
        expect(renderer.stats.verticalBuilds).toBe(4);
        const links = layout.nodes.filter((n) => n.parent).length;
        const drawn = renderer.links.main.geometry.getAttribute('position').count + renderer.links.lit.geometry.getAttribute('position').count;
        expect(drawn).toBe(links * 2);
    });

    it('draws a large view with low-detail shapes and no halos until the camera closes in', () => {
        const { renderer } = mount({ layout: syntheticLayout({ nodes: 5000 }), reduce: true });
        renderer.render();
        const sphere = renderer.instanced.find((e) => e.shape === 'sphere').mesh;
        const low = sphere.geometry.getAttribute('position').count;
        expect(renderer.detail).toBe('low');
        expect(renderer.halos.every((halo) => !halo.visible)).toBe(true);
        renderer.zoom('in');
        renderer.zoom('in');
        renderer.zoom('in');
        renderer.render();
        expect(renderer.detail).toBe('high');
        expect(sphere.geometry.getAttribute('position').count).toBeGreaterThan(low);
        expect(renderer.halos.every((halo) => halo.visible)).toBe(true);
    });

    it('keeps full detail for a budgeted view', () => {
        const { renderer } = mount({ layout: realLayout() });
        renderer.render();
        expect(renderer.detail).toBe('high');
    });
});
