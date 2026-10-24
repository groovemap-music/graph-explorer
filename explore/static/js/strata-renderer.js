/**
 * Discography Strata renderer: the webgl-inst engine (ADR 0016 section 1, gm-design-on0x
 * Recommendations 1, 3, and 4) on three.js 0.186.1.
 *
 * It draws a layoutStrata() result (strata-layout.js) on three stacked planes:
 *   - one InstancedMesh per plane and render kind (entity, count node, no-master lane), plus one
 *     instanced halo per plane;
 *   - lateral edges merged into one ribbon mesh per plane, edge kind, and dimming;
 *   - credit hulls merged per plane and color;
 *   - one instanced blocked-pressing ring per plane, around MusicBrainz-only releases;
 *   - vertical links, rebuilt only when the layout, the soloed plane, or the selection changes;
 *   - DOM labels created only for label candidates and placed greedily each frame.
 *
 * Decisions that need no GPU (resolve picking, label candidates, level of detail, camera tweens
 * under reduced motion) live in strata-scene.js. The WebGL context is behind one seam,
 * `createRenderer`, so Vitest builds the whole scene, raycasts, and lays out labels in jsdom.
 *
 * The renderer is display-only. It exposes pick, hover, select, and solo, and reports them as
 * `hover`, `select`, and `solo` events; the Explore integration decides what they open.
 *
 * Styles come from strata.css and the promoted tokens: labels are positioned through CSSOM
 * (`element.style.transform`) and shown with the `hidden` attribute, never a style attribute
 * written as markup, so a `style-src 'self'` policy holds.
 */

import * as THREE from 'three';
import { activeTheme, stateColor } from './strata-collector.js';
import { PLANE_KINDS, WORLD_DEPTH, WORLD_WIDTH, edgeSegment, hullPolygons, yearToX } from './strata-layout.js';
import {
    CAMERA_HOME,
    MAX_NODE_LABELS,
    SOLO_ELEVATION,
    cameraPose,
    clampCamera,
    collapseRepeats,
    displayLabel,
    indexNodes,
    isBlocked,
    labelBoxes,
    labelCandidates,
    levelOfDetail,
    lineage,
    nodeCentre,
    nodeShape,
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
} from './strata-scene.js';

const PLANE_NAMES = Object.freeze(['Credits', 'Masters', 'Releases']);
const PLANE_MARGIN = 7;
const HULL_COLORS = 4;
const DIM = 0.8;

/** Lateral edge styles: ribbon width in world units, dashed, and an arrow head. */
export const EDGE_STYLES = Object.freeze({
    member: Object.freeze({ width: 0.7, dash: false, arrow: true }),
    collab: Object.freeze({ width: 0.7, dash: false, arrow: false }),
    personnel: Object.freeze({ width: 0.5, dash: false, arrow: false }),
    company: Object.freeze({ width: 0.4, dash: true, arrow: false }),
});

/** The custom properties the renderer reads (strata.css), besides the collector state tokens. */
export const STRATA_TOKENS = Object.freeze({
    canvas: '--strata-canvas',
    planeFill: '--strata-plane-fill',
    planeLine: '--strata-plane-line',
    link: '--strata-link',
    accent: '--strata-accent',
    hover: '--strata-hover',
    stateless: '--strata-node-stateless',
    blocked: '--strata-blocked',
    hull: Object.freeze(['--strata-hull-1', '--strata-hull-2', '--strata-hull-3', '--strata-hull-4']),
    edge: Object.freeze({
        member: '--strata-edge-member',
        collab: '--strata-edge-collab',
        personnel: '--strata-edge-personnel',
        company: '--strata-edge-company',
    }),
});

function readComputedToken(name) {
    return getComputedStyle(globalThis.document.documentElement).getPropertyValue(name).trim();
}

// Unit shapes at two levels of detail, shared by every layout a renderer draws.
const SHAPES = {
    ico: () => new THREE.IcosahedronGeometry(1, 0),
    octa: () => new THREE.OctahedronGeometry(1, 0),
    box: () => new THREE.BoxGeometry(1.3, 1.3, 1.3),
    sphere: (low) => (low ? new THREE.SphereGeometry(1, 10, 6) : new THREE.SphereGeometry(1, 24, 16)),
    disc: (low) => new THREE.CylinderGeometry(1, 1, 0.34, low ? 12 : 32),
    stack: (low) => new THREE.CylinderGeometry(1, 1, 0.9, low ? 12 : 32),
    halo: (low) => new THREE.CircleGeometry(1, low ? 16 : 36),
    ring: () => new THREE.TorusGeometry(1, 0.075, 8, 56),
};

// The mockup's ribbon(): two triangles per solid run, optional dashes and arrow head, on y = 0.
// Exported for the Genre Atlas renderer (strata-atlas-renderer.js), which draws its own edge kinds.
export function ribbon(out, segment, { width, dash, arrow }) {
    const [ax, az, bx, bz] = segment;
    let dx = bx - ax;
    let dz = bz - az;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const nx = (-dz * width) / 2;
    const nz = (dx * width) / 2;
    const quad = (t0, t1) => {
        const x0 = ax + dx * t0;
        const z0 = az + dz * t0;
        const x1 = ax + dx * t1;
        const z1 = az + dz * t1;
        out.push(x0 + nx, 0, z0 + nz, x1 + nx, 0, z1 + nz, x1 - nx, 0, z1 - nz, x0 + nx, 0, z0 + nz, x1 - nx, 0, z1 - nz, x0 - nx, 0, z0 - nz);
    };
    const body = arrow ? Math.max(0, length - 2.4) : length;
    if (dash) for (let t = 0; t < body; t += 2.6) quad(t, Math.min(body, t + 1.4));
    else quad(0, body);
    if (arrow) {
        const hx = ax + dx * body;
        const hz = az + dz * body;
        const head = Math.max(width * 2.2, 1.1);
        out.push(hx - dz * head, 0, hz + dx * head, bx, 0, bz, hx + dz * head, 0, hz - dx * head);
    }
    return out;
}

function positions(list) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    return geometry;
}

export class StrataRenderer extends EventTarget {
    /**
     * @param {HTMLElement} stage - the element the canvas and label layer fill
     * @param {object} [options]
     * @param {(canvas: HTMLCanvasElement) => object} [options.createRenderer] - the GPU seam:
     *   returns an object with setPixelRatio, setSize, render, and dispose. Defaults to a
     *   three.js WebGLRenderer.
     * @param {(name: string) => string} [options.readToken] - reads a custom property; defaults to
     *   the computed style of the document root
     * @param {() => string} [options.theme] - 'light' or 'dark'; defaults to the root's class
     * @param {(query: string) => MediaQueryList} [options.matchMedia]
     * @param {(callback: FrameRequestCallback) => number} [options.requestFrame]
     * @param {(handle: number) => void} [options.cancelFrame]
     * @param {() => number} [options.now]
     * @param {() => {left: number, top: number, width: number, height: number}} [options.measure] -
     *   the stage's client rectangle
     * @param {(node: object) => string} [options.labelOf] - a node's label text
     * @param {number} [options.pixelRatio]
     */
    constructor(stage, options = {}) {
        super();
        this.stage = stage;
        this.readToken = options.readToken || readComputedToken;
        this.themeOf = options.theme || (() => activeTheme());
        this.now = options.now || (() => performance.now());
        this.measure = options.measure || (() => stage.getBoundingClientRect());
        this.labelOf = options.labelOf || displayLabel;
        this.requestFrame = options.requestFrame || ((callback) => globalThis.requestAnimationFrame(callback));
        this.cancelFrame = options.cancelFrame || ((handle) => globalThis.cancelAnimationFrame(handle));
        const createRenderer = options.createRenderer || ((canvas) => new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));

        stage.classList.add('strata-stage');
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'strata-canvas';
        this.overlay = document.createElement('div');
        this.overlay.className = 'strata-labels';
        this.overlay.setAttribute('aria-hidden', 'true');
        stage.append(this.canvas, this.overlay);

        this.gl = createRenderer(this.canvas);
        this.gl.setPixelRatio(Math.min(options.pixelRatio ?? globalThis.devicePixelRatio ?? 1, 2));
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(38, 1, 1, 3000);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.85));
        const light = new THREE.DirectionalLight(0xffffff, 0.75);
        light.position.set(40, 140, 80);
        this.scene.add(light);
        this.raycaster = new THREE.Raycaster();

        this.geometries = new Map();
        this.planes = [0, 1, 2].map((level) => {
            const group = new THREE.Group();
            group.position.y = planeY(level);
            this.scene.add(group);
            return { group, level };
        });
        this.links = {
            main: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.32 })),
            lit: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.75 })),
        };
        this.selectRing = new THREE.Mesh(this.geometry('ring', 'high'), new THREE.MeshBasicMaterial());
        this.hoverRing = new THREE.Mesh(this.geometry('ring', 'high'), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6 }));
        for (const ring of [this.selectRing, this.hoverRing]) {
            ring.rotation.x = Math.PI / 2;
            ring.visible = false;
        }
        this.scene.add(this.links.main, this.links.lit, this.selectRing, this.hoverRing);

        this.planeLabels = PLANE_NAMES.map((name, level) => {
            const el = document.createElement('div');
            el.className = 'strata-plane-label';
            el.hidden = true;
            const title = document.createElement('b');
            title.textContent = name;
            const count = document.createElement('span');
            el.append(title, count);
            el.dataset.level = String(level);
            this.overlay.append(el);
            return { el, count };
        });

        this.layout = null;
        this.layoutVersion = 0;
        this.byId = new Map();
        this.instanced = [];
        this.halos = [];
        this.blockedRings = [];
        this.layoutObjects = [];
        this.hullObjects = [];
        this.edgeObjects = [];
        this.nodeLabels = new Map();
        this.tagPool = [];
        this.shownLabels = new Set();
        this.selected = null;
        this.selection = null;
        this.hovered = null;
        this.soloed = null;
        this.cam = { ...CAMERA_HOME };
        this.tween = null;
        this.detail = 'high';
        this.linksKey = null;
        this.candidatesKey = null;
        this.candidates = [];
        this.dirty = true;
        this.frameHandle = null;
        this.pendingHover = null;
        this.stats = { frames: 0, lastFrameMs: 0, tweenFrames: 0, verticalBuilds: 0, labelCandidates: 0, labelsShown: 0 };

        this.matchMedia = options.matchMedia === undefined ? globalThis.matchMedia?.bind(globalThis) : options.matchMedia;
        this.reduceQuery = typeof this.matchMedia === 'function' ? this.matchMedia('(prefers-reduced-motion: reduce)') : null;
        this.reduce = prefersReducedMotion(this.matchMedia);
        this.onReduceChange = (event) => {
            this.reduce = !!event.matches;
            if (this.reduce && this.tween) {
                this.setCamera(this.tween.to);
                this.tween = null;
            }
        };
        this.reduceQuery?.addEventListener?.('change', this.onReduceChange);

        this.refreshColors();
        this.bindPointer();
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(stage);
        }
        this.resize();
        this.applyCamera();
    }

    // -----------------------------------------------------------------------------------------
    // Public API.
    // -----------------------------------------------------------------------------------------

    /** Draw a layoutStrata() result. The selection survives when its node is still drawn. */
    setLayout(layout) {
        this.clearLayout();
        this.layout = layout;
        this.layoutVersion++;
        this.byId = indexNodes(layout);
        for (const level of [0, 1, 2]) this.buildPlane(level);
        this.buildNodes();
        this.planeLabels.forEach(({ count }, level) => {
            count.textContent = String(layout.nodes.filter((node) => node.level === level).length);
        });
        if (this.hovered && !this.byId.has(this.hovered)) this.hover(null);
        this.placeRing(this.hoverRing, this.hovered);
        const dropped = this.selected !== null && !this.byId.has(this.selected);
        if (dropped) this.selected = null;
        // Colors, edges, and hulls, for the selection that survives.
        this.applySelection();
        if (dropped) this.emit('select', null);
    }

    /** The node a pointer at client coordinates means, by resolve picking, or null. */
    pick(clientX, clientY) {
        return this.hitsAt(clientX, clientY).node;
    }

    /** Every node under a pointer, best first, with the resolve winner. */
    hitsAt(clientX, clientY) {
        const rect = this.measure();
        if (!this.layout || !rect.width || !rect.height) return { node: null, candidates: [] };
        const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        this.scene.updateMatrixWorld();
        this.raycaster.setFromCamera(ndc, this.camera);
        const meshes = this.instanced.filter((entry) => this.planeVisible(entry.level)).map((entry) => entry.mesh);
        const hits = this.raycaster.intersectObjects(meshes, false).map((hit) => {
            const node = hit.object.userData.nodes[hit.instanceId];
            return { node, screen: this.screenPosition(node, rect) };
        });
        const selectedLevel = this.selected ? this.byId.get(this.selected).level : null;
        return resolvePick(hits, { pointer: { x: clientX, y: clientY }, solo: this.soloed, selectedLevel });
    }

    /** Hover a node by id, or clear the hover with null. */
    hover(id) {
        const next = id != null && this.byId.has(id) && this.planeVisible(this.byId.get(id).level) ? id : null;
        if (next === this.hovered) return;
        this.hovered = next;
        this.placeRing(this.hoverRing, next);
        this.dirty = true;
        this.emit('hover', next);
    }

    /** Select a node by id, or clear the selection with null. Its lineage stays lit. */
    select(id) {
        const next = id != null && this.byId.has(id) ? id : null;
        if (next === this.selected) return;
        this.selected = next;
        this.applySelection();
        this.emit('select', next);
    }

    /** Show one plane alone, looked at from above, or every plane again with null. */
    solo(level) {
        const next = level == null ? null : Number(level);
        if (next !== null && !PLANE_KINDS[next]) throw new RangeError(`no plane ${String(level)}`);
        if (next === this.soloed) return;
        this.soloed = next;
        this.planes.forEach((plane) => {
            plane.group.visible = this.planeVisible(plane.level);
        });
        if (this.hovered && !this.planeVisible(this.byId.get(this.hovered).level)) this.hover(null);
        this.placeRing(this.selectRing, this.selected);
        if (next === null) this.animateTo({ fy: CAMERA_HOME.fy, el: CAMERA_HOME.el, r: CAMERA_HOME.r });
        else this.animateTo({ fy: next, el: SOLO_ELEVATION, r: CAMERA_HOME.r * 0.92 });
        this.dirty = true;
        this.dispatchEvent(new CustomEvent('solo', { detail: { level: next } }));
    }

    orbit(radians) {
        this.setCamera({ az: this.cam.az + radians });
    }

    tilt(radians) {
        this.setCamera({ el: this.cam.el + radians });
    }

    /** 'in', 'out', or 'reset' (home, or straight down on a soloed plane). Tweened unless reduced. */
    zoom(direction) {
        if (direction === 'in') this.animateTo({ r: this.cam.r * 0.8 });
        else if (direction === 'out') this.animateTo({ r: this.cam.r * 1.25 });
        else this.resetCamera();
    }

    resetCamera() {
        const solo = this.soloed;
        this.animateTo({ az: CAMERA_HOME.az, el: solo == null ? CAMERA_HOME.el : SOLO_ELEVATION, r: CAMERA_HOME.r, fy: solo ?? CAMERA_HOME.fy });
    }

    /** Move the camera. Every tween goes through here, so reduced motion turns each into a jump. */
    animateTo(to, ms) {
        const plan = planCameraMove(this.cam, to, { reduce: this.reduce, now: this.now(), ms });
        this.tween = plan.tween;
        if (!plan.tween) this.setCamera(plan.cam);
        this.dirty = true;
    }

    /** Re-read the tokens, for a theme change. */
    refreshColors() {
        const token = (name) => {
            const value = this.readToken(name);
            if (!value) throw new Error(`design token ${name} is not defined; is css/strata.css loaded?`);
            return new THREE.Color(value);
        };
        const theme = this.themeOf();
        const states = new Map();
        this.colors = {
            canvas: token(STRATA_TOKENS.canvas),
            planeFill: token(STRATA_TOKENS.planeFill),
            planeLine: token(STRATA_TOKENS.planeLine),
            link: token(STRATA_TOKENS.link),
            accent: token(STRATA_TOKENS.accent),
            hover: token(STRATA_TOKENS.hover),
            stateless: token(STRATA_TOKENS.stateless),
            blocked: token(STRATA_TOKENS.blocked),
            hull: STRATA_TOKENS.hull.map(token),
            edge: Object.fromEntries(Object.entries(STRATA_TOKENS.edge).map(([kind, name]) => [kind, token(name)])),
            state: (key) => {
                if (key === null) return this.colors.stateless;
                if (!states.has(key)) states.set(key, new THREE.Color(stateColor(key, { theme, readToken: this.readToken })));
                return states.get(key);
            },
        };
        this.links.main.material.color.copy(this.colors.link);
        this.links.lit.material.color.copy(this.colors.accent);
        this.selectRing.material.color.copy(this.colors.accent);
        this.hoverRing.material.color.copy(this.colors.hover);
        if (this.layout) {
            const layout = this.layout;
            this.setLayout(layout);
        }
        this.dirty = true;
    }

    /** Render one frame now: level of detail, links, the scene, and labels. */
    render() {
        const t0 = this.now();
        this.applyLevelOfDetail();
        this.updateLinks();
        this.gl.render(this.scene, this.camera);
        this.layoutLabels();
        this.dirty = false;
        this.stats.frames++;
        this.stats.lastFrameMs = this.now() - t0;
    }

    /** Advance tweens and the pending hover to time `t`, and render if anything changed. */
    tick(t = this.now()) {
        if (this.tween) {
            const { cam, done } = stepTween(this.tween, t);
            this.setCamera(cam);
            this.stats.tweenFrames++;
            if (done) this.tween = null;
        }
        if (this.pendingHover) {
            const { x, y } = this.pendingHover;
            this.pendingHover = null;
            this.hover(this.pick(x, y)?.id ?? null);
        }
        if (this.dirty) this.render();
    }

    start() {
        if (this.frameHandle !== null) return;
        const step = (t) => {
            this.frameHandle = this.requestFrame(step);
            this.tick(t);
        };
        this.frameHandle = this.requestFrame(step);
    }

    stop() {
        if (this.frameHandle === null) return;
        this.cancelFrame(this.frameHandle);
        this.frameHandle = null;
    }

    resize() {
        const { width, height } = this.measure();
        if (!width || !height) return;
        this.gl.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.dirty = true;
    }

    /** A node's projected centre in client coordinates, and whether it is in front of the camera. */
    screenPosition(node, rect = this.measure()) {
        const c = nodeCentre(node);
        const v = new THREE.Vector3(c.x, c.y, c.z).project(this.camera);
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, visible: v.z > -1 && v.z < 1 };
    }

    /** Draw objects in the scene, for the performance smoke test. */
    drawCounts() {
        let objects = 0;
        let instances = 0;
        this.scene.traverseVisible((object) => {
            if (!object.isMesh && !object.isLine) return;
            objects++;
            instances += object.isInstancedMesh ? object.count : 1;
        });
        return { objects, instances, instancedMeshes: this.instanced.length };
    }

    dispose() {
        this.stop();
        this.unbindPointer();
        this.resizeObserver?.disconnect();
        this.reduceQuery?.removeEventListener?.('change', this.onReduceChange);
        this.clearLayout();
        for (const geometry of this.geometries.values()) geometry.dispose();
        this.geometries.clear();
        for (const object of [this.links.main, this.links.lit, this.selectRing, this.hoverRing]) {
            if (object.geometry && !object.geometry.userData.shared) object.geometry.dispose();
            object.material.dispose();
        }
        this.gl.dispose();
        this.canvas.remove();
        this.overlay.remove();
        this.stage.classList.remove('strata-stage');
        this.layout = null;
    }

    // -----------------------------------------------------------------------------------------
    // Scene building.
    // -----------------------------------------------------------------------------------------

    geometry(shape, detail) {
        const key = `${shape}:${detail}`;
        if (!this.geometries.has(key)) {
            const geometry = SHAPES[shape](detail === 'low');
            geometry.userData.shared = true;
            this.geometries.set(key, geometry);
        }
        return this.geometries.get(key);
    }

    track(level, object) {
        (level == null ? this.scene : this.planes[level].group).add(object);
        this.layoutObjects.push(object);
        return object;
    }

    clearLayout() {
        for (const list of [this.layoutObjects, this.hullObjects, this.edgeObjects]) {
            for (const object of list) {
                object.removeFromParent();
                if (object.geometry && !object.geometry.userData.shared) object.geometry.dispose();
                object.material?.dispose();
            }
            list.length = 0;
        }
        this.instanced = [];
        this.halos = [];
        this.blockedRings = [];
        for (const el of this.nodeLabels.values()) el.remove();
        this.nodeLabels.clear();
        this.shownLabels.clear();
    }

    buildPlane(level) {
        const width = WORLD_WIDTH + PLANE_MARGIN * 2;
        const depth = WORLD_DEPTH + PLANE_MARGIN * 2;
        const fill = new THREE.Mesh(
            new THREE.PlaneGeometry(width, depth),
            new THREE.MeshBasicMaterial({ color: this.colors.planeFill, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }),
        );
        fill.rotation.x = -Math.PI / 2;
        this.track(level, fill);
        const bw = width / 2;
        const bd = depth / 2;
        this.track(level, new THREE.LineLoop(positions([-bw, 0, -bd, bw, 0, -bd, bw, 0, bd, -bw, 0, bd]), new THREE.LineBasicMaterial({ color: this.colors.planeLine })));
        const { axis } = this.layout;
        const ticks = [];
        for (let year = Math.ceil(axis.y0 / 10) * 10; year <= axis.y1; year += 10) {
            const x = yearToX(axis, year);
            ticks.push(x, 0.01, -bd, x, 0.01, bd);
        }
        // The edge of the undated strip, between it and the first year.
        const edge = (axis.undatedX + axis.fromX) / 2;
        ticks.push(edge, 0.01, -bd, edge, 0.01, bd);
        this.track(level, new THREE.LineSegments(positions(ticks), new THREE.LineBasicMaterial({ color: this.colors.planeLine, transparent: true, opacity: 0.35 })));
    }

    buildNodes() {
        const matrix = new THREE.Matrix4();
        const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        const none = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        const at = new THREE.Vector3();
        const lod = this.currentLevelOfDetail();
        this.detail = lod.detail;
        for (const level of [0, 1, 2]) {
            const onPlane = this.layout.nodes.filter((node) => node.level === level);
            if (!onPlane.length) continue;
            const byKind = new Map();
            for (const node of onPlane) {
                const kind = renderKind(node);
                if (!byKind.has(kind)) byKind.set(kind, []);
                byKind.get(kind).push(node);
            }
            for (const [kind, nodes] of byKind) {
                const shape = nodeShape(nodes[0]);
                const mesh = new THREE.InstancedMesh(this.geometry(shape, lod.detail), new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.08 }), nodes.length);
                nodes.forEach((node, i) => {
                    const c = nodeCentre(node);
                    mesh.setMatrixAt(i, matrix.compose(at.set(c.x, c.y - planeY(level), c.z), none, scale.setScalar(node.size)));
                });
                mesh.userData = { nodes, level, kind, shape };
                this.track(level, mesh);
                this.instanced.push({ mesh, nodes, level, kind, shape });
            }
            const halo = new THREE.InstancedMesh(this.geometry('halo', lod.detail), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false }), onPlane.length);
            onPlane.forEach((node, i) => halo.setMatrixAt(i, matrix.compose(at.set(node.x, 0.05, node.z), flat, scale.setScalar(node.size * 1.35))));
            halo.userData = { nodes: onPlane, level };
            halo.visible = lod.halos;
            this.halos.push(this.track(level, halo));
            // The spike's blocked-pressing ring: a MusicBrainz-only release has no Discogs alias, so
            // no wantlist or collection edge can carry a change to it (ADR 0009). It is not pickable.
            const blocked = onPlane.filter(isBlocked);
            if (!blocked.length) continue;
            const ring = new THREE.InstancedMesh(this.geometry('ring', 'high'), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }), blocked.length);
            blocked.forEach((node, i) => ring.setMatrixAt(i, matrix.compose(at.set(node.x, 0.15, node.z), upright, scale.setScalar(node.size * 1.75))));
            ring.userData = { nodes: blocked, level, blocked: true };
            this.blockedRings.push(this.track(level, ring));
        }
    }

    buildEdges() {
        for (const object of this.edgeObjects) {
            object.removeFromParent();
            object.geometry.dispose();
            object.material.dispose();
        }
        this.edgeObjects = [];
        const buckets = new Map();
        for (const edge of this.layout.edges) {
            const a = this.byId.get(edge.a);
            const b = this.byId.get(edge.b);
            const style = EDGE_STYLES[edge.kind];
            const segment = a && b && style ? edgeSegment(a, b) : null;
            if (!segment) continue;
            const dim = !!this.selection && !(this.selection.has(a.id) && this.selection.has(b.id));
            const key = `${a.level}|${edge.kind}|${dim}`;
            if (!buckets.has(key)) buckets.set(key, { level: a.level, kind: edge.kind, dim, list: [] });
            ribbon(buckets.get(key).list, segment, style);
        }
        for (const { level, kind, dim, list } of buckets.values()) {
            const mesh = new THREE.Mesh(
                positions(list),
                new THREE.MeshBasicMaterial({ color: this.colors.edge[kind], transparent: true, opacity: dim ? 0.1 : 0.85, depthWrite: false, side: THREE.DoubleSide }),
            );
            mesh.position.y = 0.3;
            this.planes[level].group.add(mesh);
            this.edgeObjects.push(mesh);
        }
    }

    // Credit hulls, merged per plane, color, and dimming; rebuilt on a new layout or selection.
    buildHulls() {
        for (const object of this.hullObjects) {
            object.removeFromParent();
            object.geometry.dispose();
            object.material.dispose();
        }
        this.hullObjects = [];
        this.hullTags = [];
        // The polygons depend on the layout alone, so a selection only re-buckets them.
        if (this.hulls?.layout !== this.layout) {
            const groupIndex = new Map();
            for (const node of this.layout.nodes) if (!groupIndex.has(node.group)) groupIndex.set(node.group, groupIndex.size);
            this.hulls = { layout: this.layout, groupIndex, planes: [0, 1, 2].map((level) => hullPolygons(this.layout, level)) };
        }
        const { groupIndex } = this.hulls;
        const lit = new Set();
        for (const id of this.selection || []) {
            const node = this.byId.get(id);
            lit.add(`${node.level}|${node.group}`);
        }
        for (const level of [0, 1, 2]) {
            const buckets = new Map();
            for (const { group, polygon } of this.hulls.planes[level]) {
                const color = groupIndex.get(group) % HULL_COLORS;
                const dim = !!this.selection && !lit.has(`${level}|${group}`);
                const key = `${color}|${dim}`;
                if (!buckets.has(key)) buckets.set(key, { color, dim, shapes: [], lines: [] });
                const bucket = buckets.get(key);
                bucket.shapes.push(new THREE.Shape(polygon.map(([x, z]) => new THREE.Vector2(x, -z))));
                polygon.forEach(([x, z], i) => {
                    const [nx, nz] = polygon[(i + 1) % polygon.length];
                    bucket.lines.push(x, 0.08, z, nx, 0.08, nz);
                });
                let front = polygon[0];
                for (const point of polygon) if (point[1] > front[1]) front = point;
                const credit = this.byId.get(group);
                this.hullTags.push({ level, color, dim, x: front[0], z: front[1] + 0.5, text: credit ? this.labelOf(credit) : group });
            }
            for (const { color, dim, shapes, lines } of buckets.values()) {
                const fill = new THREE.Mesh(
                    new THREE.ShapeGeometry(shapes),
                    new THREE.MeshBasicMaterial({ color: this.colors.hull[color], transparent: true, opacity: dim ? 0.03 : 0.09, depthWrite: false, side: THREE.DoubleSide }),
                );
                fill.rotation.x = -Math.PI / 2;
                fill.position.y = 0.02;
                const outline = new THREE.LineSegments(positions(lines), new THREE.LineBasicMaterial({ color: this.colors.hull[color], transparent: true, opacity: dim ? 0.12 : 0.55 }));
                for (const object of [fill, outline]) {
                    this.planes[level].group.add(object);
                    this.hullObjects.push(object);
                }
            }
        }
    }

    applySelection() {
        this.selection = this.selected ? lineage(this.byId, this.selected) : null;
        if (this.layout) {
            this.recolor();
            this.buildEdges();
            this.buildHulls();
        }
        this.placeRing(this.selectRing, this.selected);
        this.candidatesKey = null;
        this.dirty = true;
    }

    recolor() {
        const color = new THREE.Color();
        const paint = (mesh, nodes) => {
            nodes.forEach((node, i) => {
                color.copy(this.colors.state(nodeStateKey(node)));
                if (this.selection && !this.selection.has(node.id)) color.lerp(this.colors.canvas, DIM);
                mesh.setColorAt(i, color);
            });
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        };
        for (const { mesh, nodes } of this.instanced) paint(mesh, nodes);
        for (const halo of this.halos) paint(halo, halo.userData.nodes);
        for (const ring of this.blockedRings) {
            ring.userData.nodes.forEach((node, i) => {
                color.copy(this.colors.blocked);
                if (this.selection && !this.selection.has(node.id)) color.lerp(this.colors.canvas, DIM);
                ring.setColorAt(i, color);
            });
            if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
        }
    }

    placeRing(ring, id) {
        const node = id != null ? this.byId.get(id) : null;
        ring.visible = !!node && this.planeVisible(node.level);
        if (!node) return;
        ring.scale.setScalar(node.size * (ring === this.selectRing ? 2.2 : 1.75));
        ring.position.set(node.x, planeY(node.level) + 0.2, node.z);
    }

    planeVisible(level) {
        return this.soloed === null || this.soloed === level;
    }

    currentLevelOfDetail() {
        return levelOfDetail({ distance: this.cam.r, drawn: this.layout ? this.layout.nodes.length : 0, solo: this.soloed });
    }

    applyLevelOfDetail() {
        if (!this.layout) return;
        const lod = this.currentLevelOfDetail();
        this.lod = lod;
        if (lod.detail === this.detail) return;
        this.detail = lod.detail;
        for (const { mesh, shape } of this.instanced) {
            mesh.geometry = this.geometry(shape, lod.detail);
            mesh.boundingSphere = null;
        }
        for (const halo of this.halos) {
            halo.geometry = this.geometry('halo', lod.detail);
            halo.visible = lod.halos;
        }
    }

    // Vertical links depend on the layout, the soloed plane, and the selection, never the camera.
    updateLinks() {
        if (!this.layout) return;
        const key = verticalLinksKey({ layoutVersion: this.layoutVersion, solo: this.soloed, selected: this.selected });
        if (key === this.linksKey) return;
        this.linksKey = key;
        const { main, lit } = verticalLinks(this.layout.nodes, this.byId, { solo: this.soloed, selection: this.selection });
        this.links.main.geometry.dispose();
        this.links.main.geometry = positions(main);
        this.links.lit.geometry.dispose();
        this.links.lit.geometry = positions(lit);
        this.links.main.material.opacity = this.selection ? 0.07 : 0.32;
        this.stats.verticalBuilds++;
    }

    setCamera(to) {
        Object.assign(this.cam, clampCamera({ ...this.cam, ...to }));
        this.applyCamera();
    }

    applyCamera() {
        const { position, target } = cameraPose(this.cam);
        this.camera.position.set(position.x, position.y, position.z);
        this.camera.lookAt(target.x, target.y, target.z);
        this.camera.updateMatrixWorld();
        this.dirty = true;
    }

    // -----------------------------------------------------------------------------------------
    // Labels: only candidates get an element; placement is greedy by priority.
    // -----------------------------------------------------------------------------------------

    nodeLabel(node, text) {
        let el = this.nodeLabels.get(node.id);
        if (!el) {
            el = document.createElement('div');
            el.className = node.level === 0 ? 'strata-label strata-label--credit' : 'strata-label';
            el.dataset.node = node.id;
            el.hidden = true;
            this.overlay.append(el);
            this.nodeLabels.set(node.id, el);
        }
        // A count label's text follows the pressings it stands for, so it can change between frames.
        if (el.textContent !== text) el.textContent = text;
        return el;
    }

    hullTag(index, tag) {
        let el = this.tagPool[index];
        if (!el) {
            el = document.createElement('div');
            el.hidden = true;
            this.overlay.append(el);
            this.tagPool.push(el);
        }
        el.className = `strata-tag strata-tag--hull-${tag.color + 1}`;
        if (el.textContent !== tag.text) el.textContent = tag.text;
        return el;
    }

    layoutLabels() {
        const rect = this.measure();
        const { width, height } = rect;
        const shown = new Set();
        if (!this.layout || !width || !height) {
            this.hideLabelsExcept(shown);
            return;
        }
        const v = new THREE.Vector3();
        const project = (x, y, z) => {
            v.set(x, y, z).project(this.camera);
            return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height, ok: v.z > -1 && v.z < 1 };
        };
        const lod = this.lod || this.currentLevelOfDetail();
        const key = `${this.layoutVersion}|${lod.labelDepth}|${this.soloed}|${this.selected}|${this.hovered}`;
        if (key !== this.candidatesKey) {
            this.candidatesKey = key;
            this.candidates = collapseRepeats(
                labelCandidates(this.layout.nodes, {
                    labelDepth: lod.labelDepth,
                    solo: this.soloed,
                    selected: this.selected,
                    selection: this.selection,
                    hovered: this.hovered,
                }),
                this.labelOf,
            );
        }
        this.stats.labelCandidates = this.candidates.length;

        const reserved = [];
        const bw = WORLD_WIDTH / 2 + PLANE_MARGIN;
        const bd = WORLD_DEPTH / 2 + PLANE_MARGIN;
        this.planeLabels.forEach(({ el }, level) => {
            let best = null;
            if (this.planeVisible(level)) {
                for (const [cx, cz] of [[-bw, -bd], [bw, -bd], [bw, bd], [-bw, bd]]) {
                    const s = project(cx, planeY(level), cz);
                    if (s.ok && s.x >= 0 && (!best || s.x < best.x)) best = s;
                }
            }
            if (!best) return;
            const x = Math.max(4, best.x + 6);
            const y = best.y - 22;
            this.show(el, x, y, shown);
            reserved.push({ x, y, w: 150, h: 20 });
        });

        const tags = this.hullTags.filter((tag) => !tag.dim && this.planeVisible(tag.level));
        const kept = labelBoxes(this.candidates, tags, { project, width, height, maxNodeLabels: MAX_NODE_LABELS });
        const placed = placeLabels(kept, reserved, width, height);
        for (const item of placed) {
            const el = item.node ? this.nodeLabel(item.node, item.text) : this.hullTag(item.index, item.tag);
            this.show(el, item.x, item.y, shown);
        }
        this.stats.labelsShown = placed.length;
        this.hideLabelsExcept(shown);
    }

    show(el, x, y, shown) {
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        el.hidden = false;
        shown.add(el);
    }

    hideLabelsExcept(shown) {
        for (const el of this.shownLabels) if (!shown.has(el)) el.hidden = true;
        this.shownLabels = shown;
    }

    // -----------------------------------------------------------------------------------------
    // Pointer: drag orbits, a click selects through resolve picking, a move hovers once a frame.
    // -----------------------------------------------------------------------------------------

    bindPointer() {
        let down = null;
        const handlers = {
            pointerdown: (event) => {
                if (event.button !== undefined && event.button !== 0) return;
                down = { x: event.clientX, y: event.clientY, moved: false };
                this.canvas.setPointerCapture?.(event.pointerId);
            },
            pointermove: (event) => {
                if (!down) {
                    this.pendingHover = { x: event.clientX, y: event.clientY };
                    this.dirty = true;
                    return;
                }
                const dx = event.clientX - down.x;
                const dy = event.clientY - down.y;
                if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true;
                if (!down.moved) return;
                this.tween = null;
                this.setCamera({ az: this.cam.az - dx * 0.0085, el: this.cam.el + dy * 0.006 });
                down.x = event.clientX;
                down.y = event.clientY;
            },
            pointerup: (event) => {
                const click = down && !down.moved;
                down = null;
                if (!click) return;
                const node = this.pick(event.clientX, event.clientY);
                this.select(node ? node.id : null);
            },
            pointercancel: () => {
                down = null;
            },
            pointerleave: () => {
                this.pendingHover = null;
                this.hover(null);
            },
            wheel: (event) => {
                event.preventDefault();
                this.zoom(event.deltaY < 0 ? 'in' : 'out');
            },
        };
        for (const [type, handler] of Object.entries(handlers)) this.canvas.addEventListener(type, handler, type === 'wheel' ? { passive: false } : undefined);
        this.pointerHandlers = handlers;
    }

    unbindPointer() {
        for (const [type, handler] of Object.entries(this.pointerHandlers || {})) this.canvas.removeEventListener(type, handler);
        this.pointerHandlers = null;
    }

    emit(type, id) {
        this.dispatchEvent(new CustomEvent(type, { detail: { id, node: id != null ? this.byId.get(id) || null : null } }));
    }
}
