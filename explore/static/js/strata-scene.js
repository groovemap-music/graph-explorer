/**
 * Discography Strata scene logic: everything the webgl-inst renderer decides without a GPU.
 *
 * strata-renderer.js draws a layoutStrata() result with three.js. What it draws, which node a
 * click means, which nodes get a label, how much detail a view gets, and how the camera moves are
 * decided here, as plain functions over the layout, so Vitest covers them in jsdom (which has no
 * WebGL) and the renderer only applies them.
 *
 * Ported from the design spike gm-design-on0x (docs/spikes/gm-design-on0x/web/render-webgl.mjs and
 * lib/labels.mjs), whose Recommendations 1, 3, and 4 this module implements:
 *   - resolve picking: every hit along the ray is a candidate, the nearest projected centre wins,
 *     and the soloed plane, then the selected node's plane, breaks ties;
 *   - labels only for label candidates, placed greedily by priority;
 *   - level of detail from the camera distance and the drawn node count;
 *   - reduced motion for every camera tween.
 */

import { COLLECTOR_STATES, rollUp } from './strata-collector.js';

/** World units between two planes. The credit plane is on top. */
export const PLANE_GAP = 24;
/** The camera's home: azimuth and elevation in radians, distance, and the plane it looks at. */
export const CAMERA_HOME = Object.freeze({ az: 0.42, el: 0.52, r: 210, fy: 1 });
export const CAMERA_LIMITS = Object.freeze({ elMin: 0.12, elMax: 1.5, rMin: 60, rMax: 380 });
/** Elevation of a soloed plane's camera: nearly straight down. */
export const SOLO_ELEVATION = 1.5;
export const TWEEN_MS = 520;
/**
 * Two candidates whose projected centres are within this many CSS pixels of each other are tied,
 * and the plane rule decides between them.
 */
export const TIE_TOLERANCE_PX = 2;
/** Above this many drawn nodes the far and middle views use low-detail geometry and no halos. */
export const LOD_NODE_LIMIT = 1500;
/** At most this many node labels are placed in one frame, highest priority first. */
export const MAX_NODE_LABELS = 400;

/**
 * What a node is drawn as. One InstancedMesh holds every node of one plane and one render kind,
 * so the drawn kinds are an entity, a count node (an aggregate a collector can open), and the
 * no-master lane.
 */
export const RENDER_KINDS = Object.freeze(['entity', 'aggregate', 'lane']);

/**
 * The shape of each plane and render kind, and how high its centre sits above the plane as a
 * multiple of the node's size. A credit is an icosahedron, a master a sphere, and a release a
 * disc, as in the mockup. A count node is an octahedron, or a stack of discs on the release plane,
 * and the no-master lane is a box.
 */
export const NODE_SHAPES = Object.freeze({
    credit: Object.freeze({ entity: 'ico', aggregate: 'octa', lane: 'box' }),
    master: Object.freeze({ entity: 'sphere', aggregate: 'octa', lane: 'box' }),
    release: Object.freeze({ entity: 'disc', aggregate: 'stack', lane: 'box' }),
});
export const SHAPE_LIFT = Object.freeze({ ico: 1.05, octa: 1.05, sphere: 1.05, box: 0.8, disc: 0.37, stack: 0.6 });

/** The drawn kind of a layout node. */
export function renderKind(node) {
    if (node.lane) return 'lane';
    return node.agg ? 'aggregate' : 'entity';
}

export function nodeShape(node) {
    return NODE_SHAPES[node.kind][renderKind(node)];
}

/** The world y of a plane. */
export function planeY(level) {
    return (2 - level) * PLANE_GAP;
}

/** A node's centre in world coordinates: on its plane, lifted by its shape. */
export function nodeCentre(node) {
    return { x: node.x, y: planeY(node.level) + SHAPE_LIFT[nodeShape(node)] * node.size, z: node.z };
}

/** The text a node's label shows. Count nodes and lanes have no title of their own. */
export function displayLabel(node) {
    if (node.lane) return 'Releases without a master';
    if (node.agg) {
        if (node.aggKind === 'credits') return `+${node.credits} other credits`;
        if (node.level === 1) {
            const span = node.y0 === null ? 'no year' : node.y0 === node.y1 ? String(node.y0) : `${node.y0}–${node.y1}`;
            return `${node.masters} masters, ${span}`;
        }
        return `+${node.releases} pressings`;
    }
    return node.label || node.id;
}

/**
 * The collector state a node is colored by, or null when it has none: a release's own state, or a
 * count node's roll-up of the states it holds (strata-collector.js rollUp).
 */
export function nodeStateKey(node) {
    if (node.state && COLLECTOR_STATES.includes(node.state)) return node.state;
    if (!node.states) return null;
    const held = Object.entries(node.states)
        .filter(([state, count]) => COLLECTOR_STATES.includes(state) && count > 0)
        .map(([state]) => state);
    return rollUp(held);
}

/**
 * Whether a node is a blocked pressing: a MusicBrainz-only release, which has no Discogs alias and
 * so no wantlist or collection state, drawn state-less inside the spike's ring.
 */
export function isBlocked(node) {
    return node.provider === 'musicbrainz' && !node.agg;
}

/** What a blocked pressing says about itself, wherever it is listed. */
export const BLOCKED_REASON = 'MusicBrainz-only pressing: it exists only in MusicBrainz, so GrooveMap has no collector state for it.';

/** Why a node cannot change state, or null. */
export function blockedReason(node) {
    return node && node.level === 2 && isBlocked(node) ? BLOCKED_REASON : null;
}

/** Index a layout's nodes by id. */
export function indexNodes(layout) {
    return new Map(layout.nodes.map((node) => [node.id, node]));
}

/**
 * The selected node's lineage: itself, every ancestor, and every descendant. These stay lit and
 * labelled while the rest of the view dims.
 */
export function lineage(byId, id) {
    const start = byId.get(id);
    if (!start) return null;
    const ids = new Set([start.id]);
    for (let parent = start.parent; parent != null; parent = byId.get(parent)?.parent ?? null) ids.add(parent);
    const stack = [...start.children];
    while (stack.length) {
        const child = byId.get(stack.pop());
        if (!child || ids.has(child.id)) continue;
        ids.add(child.id);
        stack.push(...child.children);
    }
    return ids;
}

// ---------------------------------------------------------------------------------------------
// Resolve picking (gm-design-on0x Recommendation 3).
// ---------------------------------------------------------------------------------------------

/**
 * Resolve the hits along a pointer ray to the node the pointer means.
 *
 * Nearest-hit picking lets a node nearer the camera win even when the pointer is on the centre of
 * the node behind it. Here every hit is a candidate, and the node whose projected centre is
 * nearest the pointer wins. Candidates within `tolerancePx` of the nearest are tied; among them a
 * node on the soloed plane wins, then a node on the selected node's plane, then the nearer centre,
 * then the hit nearer the camera.
 *
 * @param {Array<{node: object, screen: {x: number, y: number}}>} hits - in ray order, nearest
 *   first; a node may appear more than once (one hit per face)
 * @param {object} options
 * @param {{x: number, y: number}} options.pointer - the pointer, in the same space as `screen`
 * @param {number|null} [options.solo] - the soloed plane
 * @param {number|null} [options.selectedLevel] - the selected node's plane
 * @param {number} [options.tolerancePx]
 * @returns {{node: object|null, candidates: object[]}} the winner and every candidate, best first
 */
export function resolvePick(hits, { pointer, solo = null, selectedLevel = null, tolerancePx = TIE_TOLERANCE_PX }) {
    const seen = new Set();
    const candidates = [];
    for (const hit of hits) {
        if (seen.has(hit.node)) continue;
        seen.add(hit.node);
        candidates.push({
            node: hit.node,
            order: candidates.length,
            distance: Math.hypot(hit.screen.x - pointer.x, hit.screen.y - pointer.y),
            rank: (solo != null && hit.node.level === solo ? 0 : 2) + (selectedLevel != null && hit.node.level === selectedLevel ? 0 : 1),
        });
    }
    if (!candidates.length) return { node: null, candidates };
    const nearest = Math.min(...candidates.map((candidate) => candidate.distance));
    for (const candidate of candidates) candidate.tied = candidate.distance <= nearest + tolerancePx;
    candidates.sort(
        (a, b) => Number(b.tied) - Number(a.tied) || (a.tied ? a.rank - b.rank : 0) || a.distance - b.distance || a.order - b.order,
    );
    return { node: candidates[0].node, candidates };
}

// ---------------------------------------------------------------------------------------------
// Level of detail.
// ---------------------------------------------------------------------------------------------

/**
 * The level of detail for a camera distance and a drawn node count.
 *
 * - `labelDepth`: the deepest plane whose nodes are label candidates without a selection. The
 *   home view labels credits and masters (the mockup's labelDepth 1); zooming in adds releases,
 *   zooming far out keeps credits only, and a soloed plane labels everything on it.
 * - `detail`: 'low' draws fewer segments per shape and no halos. It applies when the view draws
 *   more than LOD_NODE_LIMIT nodes and the camera is not close in.
 */
export function levelOfDetail({ distance, drawn, solo = null, home = CAMERA_HOME.r }) {
    const ratio = distance / home;
    let labelDepth = 1;
    if (ratio < 0.62) labelDepth = 4;
    else if (ratio < 0.85) labelDepth = 2;
    else if (ratio > 1.25) labelDepth = 0;
    if (solo != null) labelDepth = Math.max(labelDepth, 3);
    const detail = drawn > LOD_NODE_LIMIT && ratio >= 0.62 ? 'low' : 'high';
    return { labelDepth, detail, halos: detail === 'high' };
}

// ---------------------------------------------------------------------------------------------
// Labels (gm-design-on0x lib/labels.mjs). Only candidates get a label element.
// ---------------------------------------------------------------------------------------------

/**
 * The nodes that may carry a label, with their placement priority (lower places first).
 *
 * The hovered and selected nodes always show (priority 0). With a selection, its lineage is
 * labelled and nothing else is. Without one, every node on a plane at or above `labelDepth` is a
 * candidate, credits first. A soloed view labels its own plane only.
 */
export function labelCandidates(nodes, { labelDepth, solo = null, selected = null, selection = null, hovered = null }) {
    const out = [];
    for (const node of nodes) {
        if (solo != null && node.level !== solo) continue;
        let priority = null;
        if (node.id === hovered || node.id === selected) priority = 0;
        else if (selection) priority = selection.has(node.id) ? 0.5 + node.level * 0.1 : null;
        else if (node.level <= labelDepth) priority = 1 + node.level;
        if (priority !== null) out.push({ node, priority });
    }
    return out;
}

/** Rough label width in CSS pixels, so placement never measures the DOM. */
export function labelWidth(text, level) {
    return text.length * (level === 0 ? 7.6 : 6.4) + 12;
}

/** The text of a label that stands for several pressings with the same title. */
export function countedText(text, count) {
    return `${text} ×${count}`;
}

/**
 * Collapse repeated pressing titles: the pressings of one master that share a title are one label
 * with a count, anchored over the middle of the pressings it stands for, instead of a stack of
 * identical labels. The hovered and selected nodes (priority 0) keep their own labels, because
 * those say which node the panel is describing. Every candidate gains `text`
 * (what its label says), `count` (how many nodes it stands for), and, when it stands for several,
 * `at` (the world point to anchor over).
 *
 * @param {Array<{node: object, priority: number}>} candidates - `labelCandidates` output
 * @param {(node: object) => string} textOf - a node's label text
 */
export function collapseRepeats(candidates, textOf = displayLabel) {
    const groups = new Map();
    const out = [];
    for (const candidate of candidates) {
        const { node, priority } = candidate;
        const text = textOf(node);
        if (priority === 0 || node.level !== 2 || node.agg || node.lane) {
            out.push({ ...candidate, text, count: 1 });
            continue;
        }
        const key = `${node.parent}|${text}`;
        const group = groups.get(key);
        if (group) {
            group.members.push(node);
            continue;
        }
        const entry = { ...candidate, text, count: 1, members: [node] };
        groups.set(key, entry);
        out.push(entry);
    }
    for (const entry of groups.values()) {
        if (entry.members.length > 1) {
            const centres = entry.members.map(nodeCentre);
            const mean = (axis) => centres.reduce((sum, centre) => sum + centre[axis], 0) / centres.length;
            entry.count = entry.members.length;
            entry.text = countedText(entry.text, entry.count);
            entry.at = { x: mean('x'), y: mean('y'), z: mean('z') };
        }
        delete entry.members;
    }
    return out;
}

/** The pixel heights of the label kinds, which `labelBoxes` and the stylesheet agree on. */
export const LABEL_HEIGHT = 16;
export const CREDIT_LABEL_HEIGHT = 19;
export const TAG_HEIGHT = 18;
/** The clear space placement keeps between two boxes, so neighbours never read as one stack. */
export const LABEL_GAP = 2;

/**
 * The boxes a frame's labels occupy, in CSS pixels, ready for `placeLabels`: node labels (above
 * their node, or above the middle of the pressings they count) and the outlined credit chips
 * (hull tags), all in one list so the chips are boxes in the same greedy grid as the labels.
 * Node labels beyond `maxNodeLabels` are left out, except priority 0.
 *
 * @param {Array<{node: object, priority: number, text: string, at?: object}>} candidates - after `collapseRepeats`
 * @param {Array<{text: string, level: number, x: number, z: number}>} tags - the chips to place
 * @param {{project: (x: number, y: number, z: number) => {x: number, y: number, ok: boolean},
 *          width: number, height: number, maxNodeLabels?: number}} view
 */
export function labelBoxes(candidates, tags, { project, width, height, maxNodeLabels = Infinity }) {
    const items = [];
    for (const { node, priority, text, at } of candidates) {
        const c = at || nodeCentre(node);
        const s = project(c.x, c.y + node.size * 1.25, c.z);
        if (!s.ok || s.x < -40 || s.x > width + 40 || s.y < -20 || s.y > height + 20) continue;
        const w = labelWidth(text, node.level);
        items.push({ node, text, priority, x: s.x - w / 2, y: s.y - 18, w, h: node.level === 0 ? CREDIT_LABEL_HEIGHT : LABEL_HEIGHT });
    }
    items.sort((a, b) => a.priority - b.priority);
    const kept = items.filter((item, i) => item.priority === 0 || i < maxNodeLabels);
    tags.forEach((tag, index) => {
        const s = project(tag.x, planeY(tag.level), tag.z);
        if (!s.ok) return;
        const w = labelWidth(tag.text, 1) + 6;
        kept.push({ tag, index, priority: 2.5 + tag.level * 0.01, x: s.x - w / 2, y: s.y - 2, w, h: TAG_HEIGHT });
    });
    return kept;
}

const CELL = 64;

/**
 * Greedy label placement: by priority, drop a label that would overlap one already placed or leave
 * the viewport. No two boxes that come back overlap, and each keeps `LABEL_GAP` from the next.
 * Priority 0 (hovered or selected) is never dropped for a neighbour: it is nudged up or down to
 * the nearest free slot instead, and only hidden when the column around it is full. `reserved`
 * boxes (plane labels) are placed first. Boxes are {x, y, w, h} in CSS pixels; items gain
 * `shown`, and a nudged item gains its new `y`. A uniform grid keeps each overlap test local, so a
 * frame costs about one test per neighbour.
 */
export function placeLabels(items, reserved, width, height) {
    const grid = new Map();
    const cells = (box, visit) => {
        for (let cx = Math.floor((box.x - LABEL_GAP) / CELL); cx <= Math.floor((box.x + box.w + LABEL_GAP) / CELL); cx++) {
            for (let cy = Math.floor((box.y - LABEL_GAP) / CELL); cy <= Math.floor((box.y + box.h + LABEL_GAP) / CELL); cy++) {
                if (visit(`${cx},${cy}`) === false) return false;
            }
        }
        return true;
    };
    const add = (box) =>
        cells(box, (key) => {
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(box);
        });
    const free = (box) =>
        cells(
            box,
            (key) =>
                !(grid.get(key) || []).some(
                    (q) => box.x < q.x + q.w + LABEL_GAP && box.x + box.w + LABEL_GAP > q.x && box.y < q.y + q.h + LABEL_GAP && box.y + box.h + LABEL_GAP > q.y,
                ),
        );
    reserved.forEach(add);
    const sorted = items.slice().sort((a, b) => a.priority - b.priority);
    const shown = [];
    for (const item of sorted) {
        if (item.priority > 0) {
            const outside = item.x < 0 || item.x + item.w > width || item.y < 0 || item.y + item.h > height;
            if (outside || !free(item)) {
                item.shown = false;
                continue;
            }
        } else if (!free(item)) {
            const home = item.y;
            const step = item.h + LABEL_GAP;
            let slot = null;
            for (let k = 1; k <= 4 && slot === null; k++) {
                for (const dy of [-k * step, k * step]) {
                    item.y = home + dy;
                    if (free(item)) {
                        slot = dy;
                        break;
                    }
                }
            }
            if (slot === null) {
                item.y = home;
                item.shown = false;
                continue;
            }
        }
        add(item);
        item.shown = true;
        shown.push(item);
    }
    return shown;
}

// ---------------------------------------------------------------------------------------------
// Camera and reduced motion.
// ---------------------------------------------------------------------------------------------

/** Whether the user asks for reduced motion. `matchMedia` is injectable for tests. */
export function prefersReducedMotion(matchMedia = globalThis.matchMedia) {
    return typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)')?.matches;
}

export function clampCamera(cam) {
    return {
        ...cam,
        el: Math.min(CAMERA_LIMITS.elMax, Math.max(CAMERA_LIMITS.elMin, cam.el)),
        r: Math.min(CAMERA_LIMITS.rMax, Math.max(CAMERA_LIMITS.rMin, cam.r)),
    };
}

/** The camera's position and target for an orbit state. */
export function cameraPose(cam) {
    const ty = (2 - cam.fy) * PLANE_GAP;
    return {
        position: { x: cam.r * Math.cos(cam.el) * Math.sin(cam.az), y: ty + cam.r * Math.sin(cam.el), z: cam.r * Math.cos(cam.el) * Math.cos(cam.az) },
        target: { x: 0, y: ty, z: 0 },
    };
}

const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

/**
 * Plan a camera move. Under reduced motion the move is a jump: no tween, and the camera is at
 * `to` on the next frame. Otherwise it is an ease-in-out tween over `ms`.
 *
 * @returns {{cam: object, tween: object|null}} the camera to apply now and the tween to step, if any
 */
export function planCameraMove(cam, to, { reduce, now, ms = TWEEN_MS }) {
    const target = clampCamera({ ...cam, ...to });
    if (reduce || ms <= 0) return { cam: target, tween: null };
    return { cam, tween: { from: { ...cam }, to: target, t0: now, ms } };
}

/** Step a tween to time `t`. Returns the camera and whether the tween has finished. */
export function stepTween(tween, t) {
    const k = Math.min(1, Math.max(0, (t - tween.t0) / tween.ms));
    const e = ease(k);
    const cam = {};
    for (const key of Object.keys(tween.to)) cam[key] = tween.from[key] + (tween.to[key] - tween.from[key]) * e;
    return { cam, done: k >= 1 };
}

// ---------------------------------------------------------------------------------------------
// Vertical links: from each node down to its parent on the plane above.
// ---------------------------------------------------------------------------------------------

/**
 * The vertical links of a view as flat [x0, y0, z0, x1, y1, z1, ...] arrays: `main` for every
 * link and `lit` for links inside the selection's lineage. A soloed view draws none.
 */
export function verticalLinks(nodes, byId, { solo = null, selection = null }) {
    const main = [];
    const lit = [];
    if (solo != null) return { main, lit };
    for (const node of nodes) {
        const parent = node.parent != null ? byId.get(node.parent) : null;
        if (!parent) continue;
        const from = nodeCentre(node);
        const segment = [from.x, from.y, from.z, parent.x, planeY(parent.level) + 0.05, parent.z];
        (selection && selection.has(node.id) && selection.has(parent.id) ? lit : main).push(...segment);
    }
    return { main, lit };
}

/** What the vertical links depend on. They are rebuilt only when this key changes. */
export function verticalLinksKey({ layoutVersion, solo, selected }) {
    return `${layoutVersion}|${solo ?? '-'}|${selected ?? '-'}`;
}
