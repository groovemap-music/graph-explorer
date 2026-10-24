// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    CAMERA_HOME,
    CAMERA_LIMITS,
    LOD_NODE_LIMIT,
    TIE_TOLERANCE_PX,
    displayLabel,
    indexNodes,
    CREDIT_LABEL_HEIGHT,
    LABEL_GAP,
    LABEL_HEIGHT,
    TAG_HEIGHT,
    collapseRepeats,
    countedText,
    labelBoxes,
    labelCandidates,
    labelWidth,
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

/** Pairs of boxes that share any area. */
function overlaps(boxes) {
    const found = [];
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) found.push([a, b]);
        }
    }
    return found;
}

describe('label placement', () => {
    const box = (id, priority, x, y) => ({ id, priority, x, y, w: 50, h: 16 });

    it('drops a label that would overlap one with a better priority', () => {
        const items = [box('b', 2, 20, 10), box('a', 1, 0, 0), box('c', 1, 200, 0)];
        const shown = placeLabels(items, [], 800, 600).map((item) => item.id);
        expect(shown).toEqual(['a', 'c']);
        expect(items.find((item) => item.id === 'b').shown).toBe(false);
    });

    it('shows priority 0 off the viewport, and nudges it clear of a reserved box rather than over it', () => {
        const reserved = { x: 0, y: 0, w: 150, h: 20 };
        const items = [box('hover', 0, 10, 10), box('next', 1, 10, 10), box('off', 1, 900, 10), box('hover-off', 0, 900, 10)];
        const shown = placeLabels(items, [reserved], 800, 600);
        expect(shown.map((item) => item.id)).toEqual(['hover', 'hover-off']);
        expect(overlaps([reserved, ...shown])).toEqual([]);
        expect(items.find((item) => item.id === 'hover').y).not.toBe(10);
    });

    it('nudges a hovered label off the selected one instead of drawing the two over each other', () => {
        const items = [box('selected', 0, 100, 100), box('hover', 0, 110, 104), box('near', 1, 100, 140)];
        const shown = placeLabels(items, [], 800, 600);
        expect(shown.map((item) => item.id)).toEqual(['selected', 'hover', 'near']);
        expect(overlaps(shown)).toEqual([]);
    });

    it('hides a priority 0 label only when the column around it is full', () => {
        const wall = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: -100 + i * 18, w: 400, h: 18 }));
        const items = [box('hover', 0, 100, 100)];
        expect(placeLabels(items, wall, 800, 600)).toEqual([]);
        expect(items[0].shown).toBe(false);
        expect(items[0].y).toBe(100);
    });

    it('keeps the gap between neighbours and drops a label that would leave the viewport, not clip it', () => {
        const items = [box('a', 1, 0, 0), box('touching', 2, 50 + LABEL_GAP - 1, 0), box('clear', 2, 50 + LABEL_GAP, 0), box('clipped', 1, 760, 300), box('inside', 1, 750, 300)];
        const shown = placeLabels(items, [], 800, 600).map((item) => item.id);
        expect(shown).toEqual(['a', 'inside', 'clear']);
    });

    it('finds overlaps across grid cells', () => {
        const items = [box('a', 1, 60, 60), box('b', 2, 100, 70), box('c', 2, 63, 50)];
        expect(placeLabels(items, [], 800, 600).map((item) => item.id)).toEqual(['a']);
    });
});

describe('collapsing repeated pressing titles', () => {
    const master = node('m:1', 1, { children: ['r:1', 'r:2', 'r:3', 'r:4'], label: 'Master' });
    const press = (id, label, extra = {}) => node(id, 2, { parent: 'm:1', agg: false, label, x: Number(id.slice(2)) * 2, z: 4, size: 1, ...extra });
    const nodes = [master, press('r:1', 'Willow Orbit'), press('r:2', 'Willow Orbit'), press('r:3', 'Willow Orbit (Remastered)'), press('r:4', 'Willow Orbit')];
    const summary = (list) => list.map((item) => [item.node.id, item.text, item.count]);

    it('makes one label with a count of the pressings of one master that share a title', () => {
        const labelled = collapseRepeats(labelCandidates(nodes, { labelDepth: 4 }));
        expect(summary(labelled)).toEqual([
            ['m:1', 'Master', 1],
            ['r:1', countedText('Willow Orbit', 3), 3],
            ['r:3', 'Willow Orbit (Remastered)', 1],
        ]);
        expect(countedText('Willow Orbit', 3)).toBe('Willow Orbit \u00d73');
    });

    it('anchors the count label over the middle of the pressings it stands for', () => {
        const [, counted] = collapseRepeats(labelCandidates(nodes, { labelDepth: 4 }));
        const members = ['r:1', 'r:2', 'r:4'].map((id) => nodeCentre(nodes.find((n) => n.id === id)));
        expect(counted.at.x).toBeCloseTo(members.reduce((sum, c) => sum + c.x, 0) / 3);
        expect(counted.at.z).toBe(4);
        expect(counted.members).toBeUndefined();
    });

    it('keeps pressings with the same title under different masters apart', () => {
        const other = [...nodes, node('m:2', 1, { label: 'Other' }), press('r:9', 'Willow Orbit', { parent: 'm:2' })];
        const labelled = collapseRepeats(labelCandidates(other, { labelDepth: 4 }));
        expect(summary(labelled).filter(([id]) => id.startsWith('r:')).map(([, text]) => text)).toEqual([countedText('Willow Orbit', 3), 'Willow Orbit (Remastered)', 'Willow Orbit']);
    });

    it('never folds the hovered or selected node into a count, and counts the rest', () => {
        const labelled = collapseRepeats(labelCandidates(nodes, { labelDepth: 4, hovered: 'r:2' }));
        const text = Object.fromEntries(summary(labelled).map(([id, label, count]) => [id, [label, count]]));
        expect(text['r:2']).toEqual(['Willow Orbit', 1]);
        expect(text['r:1']).toEqual([countedText('Willow Orbit', 2), 2]);
        expect(text['r:4']).toBeUndefined();
    });

    it('leaves count nodes, lanes, masters, and credits alone, and a selection\'s lineage collapses', () => {
        const aggregate = node('ra:m:1', 2, { parent: 'm:1', agg: true, releases: 9 });
        const lane = node('nm:c:1', 1, { agg: true, lane: 'nomaster' });
        const twins = [aggregate, lane, node('c:1', 0, { label: 'Same' }), node('c:2', 0, { label: 'Same' })];
        expect(summary(collapseRepeats(labelCandidates(twins, { labelDepth: 4 }), displayLabel)).map(([, , count]) => count)).toEqual([1, 1, 1, 1]);
        const byId = indexNodes({ nodes });
        const selection = lineage(byId, 'm:1');
        const labelled = collapseRepeats(labelCandidates(nodes, { labelDepth: 1, selected: 'm:1', selection }));
        expect(labelled.filter((item) => item.count > 1).map((item) => item.text)).toEqual([countedText('Willow Orbit', 3)]);
    });
});

describe('label boxes', () => {
    const project = (x, y, z) => ({ x: 400 + x * 10, y: 300 + z * 10 - y, ok: true });
    const view = { project, width: 800, height: 600 };

    it('boxes node labels and outlined chips alike, with the heights the stylesheet gives them', () => {
        const credit = { node: node('c', 0, { label: 'Artist' }), priority: 1, text: 'Artist', count: 1 };
        const release = { node: node('r', 2, { x: 5, label: 'Pressing' }), priority: 3, text: 'Pressing', count: 1 };
        const tag = { text: 'The Placeholder Band, Remixer One', level: 1, x: -5, z: 3 };
        const [a, b, chip] = labelBoxes([release, credit], [tag], view);
        expect(a.node.id).toBe('c');
        expect([a.h, b.h, chip.h]).toEqual([CREDIT_LABEL_HEIGHT, LABEL_HEIGHT, TAG_HEIGHT]);
        expect(chip.tag).toBe(tag);
        expect(chip.w).toBe(labelWidth(tag.text, 1) + 6);
        expect(b.w).toBe(labelWidth('Pressing', 2));
    });

    it('sizes a count label by its counted text, and anchors it at the point it carries', () => {
        const counted = { node: node('r', 2, { label: 'Pressing' }), priority: 3, text: countedText('Pressing', 12), count: 12, at: { x: 10, y: 0, z: 0 } };
        const [item] = labelBoxes([counted], [], view);
        expect(item.w).toBe(labelWidth('Pressing \u00d712', 2));
        expect(item.x + item.w / 2).toBeCloseTo(400 + 10 * 10);
    });

    it('leaves out what is off screen, behind the camera, or past the label limit, except priority 0', () => {
        const at = (id, x, priority, extra = {}) => ({ node: node(id, 2, { x, label: id }), priority, text: id, count: 1, ...extra });
        const candidates = [at('far', 500, 3), at('near1', 1, 3), at('near2', 2, 3), at('hover', 3, 0)];
        expect(labelBoxes(candidates, [], { ...view, maxNodeLabels: 2 }).map((item) => item.node.id)).toEqual(['hover', 'near1']);
        const hidden = labelBoxes([at('near1', 1, 3)], [{ text: 'chip', level: 0, x: 0, z: 0 }], { ...view, project: () => ({ x: 0, y: 0, ok: false }) });
        expect(hidden).toEqual([]);
    });
});

describe('label placement over generated layouts', () => {
    // Every label and outlined chip a frame would draw, placed over the layouts the route's fold
    // can make from invented catalogs, under random cameras that crowd them to varying degrees, with
    // random hovered and selected nodes. The boxes are the ones `labelBoxes` hands `placeLabels`.
    const WIDTH = 1000;
    const HEIGHT = 640;
    const RESERVED = [0, 1, 2].map((level) => ({ x: 4, y: 40 + level * 120, w: 150, h: 20 }));

    function frame(seed) {
        const r = rng(seed);
        const catalog = generateDiscography(r, { maxReleases: 80 + Math.floor(r() * 500) });
        const masters = [...catalog.masterYears.keys()];
        const focus = masters.length && r() < 0.6 ? `m:${masters[Math.floor(r() * masters.length)]}` : null;
        const payload = buildPayload(catalog, [3, 12, 16], { focus, signedIn: true, r });
        // Pressings of one master repeat a handful of titles, and credits have names of every length.
        for (const entry of payload.planes[2].nodes) if (entry.provider === 'discogs') entry.title = r.pick(['Willow Orbit', 'Willow Orbit (Remastered)', 'Lantern Static', `Release ${entry.release_id}`]);
        for (const entry of payload.planes[0].nodes) for (const artist of entry.artists) artist.name = `${artist.name}${' and the Placeholder Band'.repeat(r.int(0, 3))}`;
        const layout = layoutStrata(adaptStrataPayload(payload));
        const { nodes } = layout;
        const byId = indexNodes(layout);
        const choose = () => (r() < 0.7 ? null : nodes[Math.floor(r() * nodes.length)].id);
        const selected = choose();
        const hovered = choose();
        const scale = 4 + r() * 8;
        const tilt = r() * 0.8;
        const project = (x, y, z) => ({ x: WIDTH / 2 + x * scale, y: HEIGHT / 2 + z * scale * tilt - y * scale * 0.4, ok: true });
        const candidates = collapseRepeats(
            labelCandidates(nodes, { labelDepth: 1 + Math.floor(r() * 4), solo: r() < 0.3 ? Math.floor(r() * 3) : null, selected, selection: selected ? lineage(byId, selected) : null, hovered }),
        );
        const tags = nodes.filter((n) => n.level === 0 && !n.agg).flatMap((n) => [0, 1, 2].map((level) => ({ text: n.label || n.id, level, x: n.x, z: n.z + level })));
        const items = labelBoxes(candidates, tags, { project, width: WIDTH, height: HEIGHT, maxNodeLabels: 80 });
        const shown = placeLabels(items, RESERVED, WIDTH, HEIGHT);
        return { layout, candidates, items, shown };
    }

    it('never overlaps two label boxes, outlined chips and plane labels included', () => {
        let placed = 0;
        let chips = 0;
        let dropped = 0;
        for (let seed = 1; seed <= 60; seed++) {
            const { items, shown } = frame(seed);
            const clashes = overlaps([...RESERVED, ...shown]);
            expect(clashes.length, `seed ${seed}`).toBe(0);
            for (let i = 0; i < shown.length; i++) {
                for (let j = i + 1; j < shown.length; j++) {
                    const a = shown[i];
                    const b = shown[j];
                    const apart = a.x + a.w + LABEL_GAP <= b.x || b.x + b.w + LABEL_GAP <= a.x || a.y + a.h + LABEL_GAP <= b.y || b.y + b.h + LABEL_GAP <= a.y;
                    expect(apart, `seed ${seed}: ${a.text ?? a.tag.text} / ${b.text ?? b.tag.text}`).toBe(true);
                }
            }
            placed += shown.length;
            chips += shown.filter((item) => item.tag).length;
            dropped += items.length - shown.length;
        }
        // The property is not vacuous: labels and chips were placed, and the crowding dropped some.
        expect(placed).toBeGreaterThan(300);
        expect(chips).toBeGreaterThan(20);
        expect(dropped).toBeGreaterThan(20);
    });

    it('keeps every label that is not hovered or selected inside the viewport', () => {
        for (let seed = 1; seed <= 40; seed++) {
            for (const item of frame(seed).shown.filter((entry) => entry.priority > 0)) {
                expect(item.x >= 0 && item.y >= 0 && item.x + item.w <= WIDTH && item.y + item.h <= HEIGHT, `seed ${seed}: ${item.text ?? item.tag.text}`).toBe(true);
            }
        }
    });

    it('draws one label for each repeated title under a master, with its count', () => {
        let counted = 0;
        for (let seed = 1; seed <= 60; seed++) {
            const { candidates } = frame(seed);
            const seen = new Set();
            for (const item of candidates.filter((entry) => entry.node.level === 2 && !entry.node.agg && entry.priority > 0)) {
                const key = `${item.node.parent}|${item.text}`;
                expect(seen.has(key), `seed ${seed}: ${key}`).toBe(false);
                seen.add(key);
                if (item.count > 1) counted += 1;
            }
        }
        expect(counted).toBeGreaterThan(5);
    });

    it('draws the same title as a single label when many pressings share it', () => {
        const nodes = [node('m:1', 1, { children: [] }), ...Array.from({ length: 12 }, (_, i) => node(`r:${i}`, 2, { parent: 'm:1', agg: false, label: 'Willow Orbit', x: i * 0.5, z: 1 }))];
        const labelled = collapseRepeats(labelCandidates(nodes, { labelDepth: 4 }));
        expect(labelled.filter((item) => item.node.level === 2)).toHaveLength(1);
        const items = labelBoxes(labelled, [], { project: (x, y, z) => ({ x: 100 + x * 8, y: 100 + z - y, ok: true }), width: 800, height: 600 });
        const shown = placeLabels(items, [], 800, 600);
        expect(shown.map((item) => item.text)).toEqual(['m:1', countedText('Willow Orbit', 12)]);
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
