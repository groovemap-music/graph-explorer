/**
 * Genre Atlas renderer: the Strata webgl-inst engine (strata-renderer.js) drawing a layoutAtlas()
 * result (strata-atlas-layout.js) instead of a discography.
 *
 * It is a subclass, so the engine's camera, pointer input, resolve picking, level of detail,
 * reduced motion, and greedy label placement apply unchanged. It replaces what concept B draws
 * differently:
 *   - the planes carry the served ring: the genre plane shows each sector's pinned frame;
 *   - one InstancedMesh per plane for nodes, and one for ghost copies, drawn as wireframes;
 *   - node color is the lifecycle stage in the scrubbed year, from the promoted
 *     `--groovemap-state-lifecycle-<stage>-<theme>` tokens;
 *   - provisional years get a dashed ring in the `provisional` token around every style and ghost,
 *     so the cue is never color alone (design brand/README.md);
 *   - genre hulls on the style plane, tagged with the styles and ghosts each one counts;
 *   - vertical links are the emergence edges only, dashed for a ghost;
 *   - lateral edges are the selected style's star only (strata-atlas-layout.js lateralEdges);
 *   - the signed-in collector's layer (strata-taste.js paintTaste), when the view painted one: a
 *     ring in the collector state's token around each held genre, style, ghost, and landmark master,
 *     and the collector's own masters on the master plane in their state's color. A node first
 *     recorded after the "recorded as of" year loses its ring, and a collector master is dimmed;
 *   - the Fit landing point (strata-fit.js paintLanding), when the view painted one: a diamond in
 *     the Fit component's token around each node the candidate's evidence names, and the Bridge as
 *     a ribbon between the bridged genres' hulls on the style plane. The label says what each
 *     diamond means, so the cue is never color alone.
 *
 * Like the engine, it writes no style attribute and parses no HTML.
 */

import * as THREE from 'three';
import { StrataRenderer, ribbon } from './strata-renderer.js';
import { WORLD_DEPTH, WORLD_WIDTH, edgeSegment } from './strata-layout.js';
import { ATLAS_PLANES, ATLAS_RADIUS, MASTER_PLANE, atlasSelection, lateralEdges, paintAtlas } from './strata-atlas-layout.js';
import { nodeCentre, nodeShape, planeY, verticalLinksKey } from './strata-scene.js';
import { FIT_MARK_WORDS } from './strata-fit.js';

const PLANE_MARGIN = 7;
const HULL_COLORS = 4;
const DIM = 0.8;
const DASHES = 10;
/** A held ring's radius, as a share of its node's size: inside the footprint check's gap. */
const HELD_RING = 1.2;
/** How far a collector master not yet recorded in the "recorded as of" year fades to the canvas. */
const NOT_YET = 0.6;
/** A landing diamond's radius, as a share of its node's size: outside the held ring, inside the provisional one. */
const LANDING_RING = 1.55;
/** The Bridge ribbon's width, in world units. */
const BRIDGE_WIDTH = 0.7;

/** The lifecycle stages the promoted tokens name, and the provisional treatment's color. */
export const LIFECYCLE_STAGES = Object.freeze(['absent', 'emerging', 'established', 'reviving', 'declining']);

/** The promoted token for a lifecycle stage (or `provisional`) in a theme. */
export function lifecycleTokenName(stage, theme) {
    return `--groovemap-state-lifecycle-${stage}-${theme}`;
}

/** The Fit components the atlas can draw, and so the ones with a promoted token. */
export const FIT_DRAWN = Object.freeze(['affinity', 'novelty', 'bridge', 'redundancy']);

/** The promoted token for a drawn Fit component in a theme. */
export function fitTokenName(component, theme) {
    return `--groovemap-state-fit-${component}-${theme}`;
}

/** Atlas edge styles: ribbon width in world units, dashed, and an arrow head. Both are in the accent color; the dash tells a ghost link from a co-tag. */
export const ATLAS_EDGE_STYLES = Object.freeze({
    ghost: Object.freeze({ width: 0.5, dash: true, arrow: false }),
    cotag: Object.freeze({ width: 0.45, dash: false, arrow: false }),
});

/**
 * A node's label: a ghost copy is marked as one, a node the collector holds says how many items,
 * and a node the Fit landing point marks says what the mark means.
 */
export function atlasLabel(node) {
    const label = node.entity === 'ghost' ? `${node.label} ↗` : node.label || node.id;
    const held = node.held ? `${label} · ${node.held.items} yours` : label;
    return node.landing ? `${held} · ${FIT_MARK_WORDS[node.landing]}` : held;
}

function positions(list) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    return geometry;
}

// A flat ring of DASHES arcs in the xz plane, radius 1: the provisional treatment.
function dashedRing() {
    const out = [];
    const step = (Math.PI * 2) / DASHES;
    for (let i = 0; i < DASHES; i++) {
        const piece = new THREE.RingGeometry(0.86, 1, 6, 1, i * step, step * 0.55).toNonIndexed();
        out.push(...piece.getAttribute('position').array);
        piece.dispose();
    }
    const geometry = positions(out);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

// A flat solid ring in the xz plane, radius 1: the collector's held mark.
function heldRing() {
    const geometry = new THREE.RingGeometry(0.78, 1, 32, 1);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

// A flat diamond outline in the xz plane, radius 1: the Fit landing mark. Its corners tell it from
// the round held and provisional rings.
function landingRing() {
    const geometry = new THREE.RingGeometry(0.8, 1, 4, 1);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

// A sector boundary angle (radians, counter-clockwise from east, y north) as world x, z.
function polar(angle, radius) {
    return [Math.cos(angle) * radius * ATLAS_RADIUS, -Math.sin(angle) * radius * ATLAS_RADIUS];
}

export class AtlasRenderer extends StrataRenderer {
    /**
     * @param {HTMLElement} stage
     * @param {object} [options] - every StrataRenderer option, plus `cotags(style)`: the selected
     *   style's co-tag entries (`{other, release_count, rank}`) drawn as lateral edges. None are
     *   served yet. A caller that fetches them calls refreshLateral() once they arrive.
     */
    constructor(stage, options = {}) {
        super(stage, { labelOf: atlasLabel, ...options });
        this.cotags = options.cotags || (() => []);
        this.year = null;
        this.provisionalRings = [];
        this.heldRings = [];
        this.landingRings = [];
        this.landingObjects = [];
        this.ghostLinks = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ transparent: true, opacity: 0.45, dashSize: 1.2, gapSize: 1.2 }));
        this.ghostLinks.material.color.copy(this.colors.link);
        this.scene.add(this.ghostLinks);
        this.planeLabels.forEach(({ el }, level) => {
            el.querySelector('b').textContent = ATLAS_PLANES[level];
        });
    }

    /** Draw a layoutAtlas() result, painted for the current year (the timeline's last by default). */
    setLayout(layout) {
        this.year = paintAtlas(layout, this.year ?? layout.atlas.timeline.lastYear).year;
        super.setLayout(layout);
        const styles = layout.nodes.filter((node) => node.entity === 'style').length;
        const ghosts = layout.nodes.filter((node) => node.entity === 'ghost').length;
        this.planeLabels[0].count.textContent = String(layout.nodes.filter((node) => node.level === 0).length);
        this.planeLabels[1].count.textContent = `${styles} + ${ghosts} ghosts`;
        const masters = layout.nodes.filter((node) => node.level === MASTER_PLANE);
        const collectors = masters.filter((node) => node.master.collector).length;
        const landmarks = masters.length - collectors;
        this.planeLabels[MASTER_PLANE].count.textContent = collectors ? `${landmarks} + ${collectors} yours` : landmarks ? String(landmarks) : layout.atlas.masters?.length ? 'not placed yet' : 'none served';
    }

    /** Redraw the collector's layer after the view repainted it (strata-taste.js paintTaste). Nothing moves. */
    refreshTaste() {
        if (!this.layout) return;
        this.buildHeldRings();
        this.recolor();
        this.candidatesKey = null;
        this.invalidate();
    }

    /** Redraw the Fit landing point after the view repainted it (strata-fit.js paintLanding). Nothing moves. */
    refreshLanding() {
        if (!this.layout) return;
        this.buildLandingRings();
        this.buildLanding();
        this.recolor();
        this.candidatesKey = null;
        this.invalidate();
    }

    /** Rebuild the selected style's lateral edges, after its co-tags arrive. */
    refreshLateral() {
        if (this.layout) this.applySelection();
    }

    /** Repaint every node for a year of valid time. Nothing moves and no mesh is rebuilt. */
    setYear(year) {
        if (!this.layout) {
            this.year = year;
            return;
        }
        this.year = paintAtlas(this.layout, year).year;
        this.recolor();
        this.dirty = true;
    }

    refreshColors() {
        const theme = this.themeOf();
        const token = (name) => {
            const value = this.readToken(name);
            if (!value) throw new Error(`design token ${name} is not defined; is brand/tokens.css loaded?`);
            return new THREE.Color(value);
        };
        this.lifecycle = {
            stages: new Map(LIFECYCLE_STAGES.map((stage) => [stage, token(lifecycleTokenName(stage, theme))])),
            provisional: token(lifecycleTokenName('provisional', theme)),
        };
        this.fit = new Map(FIT_DRAWN.map((component) => [component, token(fitTokenName(component, theme))]));
        super.refreshColors();
        this.ghostLinks?.material.color.copy(this.colors.link);
    }

    dispose() {
        this.clearLanding();
        this.ghostLinks.removeFromParent();
        this.ghostLinks.geometry.dispose();
        this.ghostLinks.material.dispose();
        super.dispose();
    }

    // -----------------------------------------------------------------------------------------
    // Scene building.
    // -----------------------------------------------------------------------------------------

    clearLayout() {
        this.clearLanding();
        super.clearLayout();
        this.provisionalRings = [];
        this.heldRings = [];
        this.landingRings = [];
    }

    geometry(shape, detail) {
        const own = { 'dashed-ring': dashedRing, 'held-ring': heldRing, 'landing-ring': landingRing }[shape];
        if (!own) return super.geometry(shape, detail);
        if (!this.geometries.has(shape)) {
            const geometry = own();
            geometry.userData.shared = true;
            this.geometries.set(shape, geometry);
        }
        return this.geometries.get(shape);
    }

    // The engine's plane, with the served ring in place of the year axis: the disc's edge on every
    // plane, and each sector's pinned frame on the genre plane.
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
        const rim = [];
        for (let i = 0; i <= 96; i++) {
            const [x, z] = polar((i / 96) * Math.PI * 2, 1);
            rim.push(x, 0.01, z);
        }
        this.track(level, new THREE.Line(positions(rim), new THREE.LineBasicMaterial({ color: this.colors.planeLine, transparent: true, opacity: 0.5 })));
        if (level !== 0) return;
        const frames = [];
        for (const node of this.layout.nodes) {
            if (node.entity !== 'genre') continue;
            const [ix, iz] = polar(node.sector[0], 0.3);
            const [ox, oz] = polar(node.sector[0], 1);
            frames.push(ix, 0.01, iz, ox, 0.01, oz);
        }
        this.track(level, new THREE.LineSegments(positions(frames), new THREE.LineBasicMaterial({ color: this.colors.planeLine, transparent: true, opacity: 0.6 })));
    }

    buildNodes() {
        const matrix = new THREE.Matrix4();
        const none = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        const at = new THREE.Vector3();
        const lod = this.currentLevelOfDetail();
        this.detail = lod.detail;
        for (const level of [0, 1, 2]) {
            const onPlane = this.layout.nodes.filter((node) => node.level === level);
            for (const kind of ['solid', 'ghost']) {
                const nodes = onPlane.filter((node) => (node.entity === 'ghost') === (kind === 'ghost'));
                if (!nodes.length) continue;
                const shape = nodeShape(nodes[0]);
                const material =
                    kind === 'ghost'
                        ? new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.75 })
                        : new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.08 });
                const mesh = new THREE.InstancedMesh(this.geometry(shape, lod.detail), material, nodes.length);
                nodes.forEach((node, i) => {
                    const c = nodeCentre(node);
                    mesh.setMatrixAt(i, matrix.compose(at.set(c.x, c.y - planeY(level), c.z), none, scale.setScalar(node.size)));
                });
                mesh.userData = { nodes, level, kind, shape };
                this.track(level, mesh);
                this.instanced.push({ mesh, nodes, level, kind, shape });
            }
            // The provisional treatment: a dashed ring around every style and ghost, shown only in a
            // provisional year. It is not pickable.
            const staged = onPlane.filter((node) => node.entity === 'style' || node.entity === 'ghost');
            if (!staged.length) continue;
            const ring = new THREE.InstancedMesh(this.geometry('dashed-ring'), new THREE.MeshBasicMaterial({ color: this.lifecycle.provisional, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }), staged.length);
            staged.forEach((node, i) => ring.setMatrixAt(i, matrix.compose(at.set(node.x, 0.12, node.z), none, scale.setScalar(node.size * 1.9))));
            ring.userData = { nodes: staged, level, provisional: true };
            this.provisionalRings.push(this.track(level, ring));
        }
        this.buildHeldRings();
        this.buildLandingRings();
        this.buildLanding();
    }

    // The collector's held mark: a ring in the state's color around every held node but the
    // collector's own masters, which carry the color themselves. Not pickable. Rebuilt whenever the
    // "recorded as of" year changes which nodes are held.
    buildHeldRings() {
        for (const ring of this.heldRings) {
            ring.removeFromParent();
            ring.material.dispose();
            this.layoutObjects.splice(this.layoutObjects.indexOf(ring), 1);
        }
        this.heldRings = [];
        let marks = 0;
        const matrix = new THREE.Matrix4();
        const none = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        const at = new THREE.Vector3();
        for (const level of [0, 1, 2]) {
            const held = this.layout.nodes.filter((node) => node.level === level && node.held && !node.master?.collector);
            if (!held.length) continue;
            const ring = new THREE.InstancedMesh(this.geometry('held-ring'), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }), held.length);
            held.forEach((node, i) => ring.setMatrixAt(i, matrix.compose(at.set(node.x, 0.1, node.z), none, scale.setScalar(node.size * HELD_RING))));
            ring.userData = { nodes: held, level, held: true };
            this.heldRings.push(this.track(level, ring));
            marks += held.length;
        }
        // For anything reading the frame once `data-strata-frame` settles: how many held rings it drew.
        this.stage.dataset.atlasHeldMarks = String(marks);
    }

    // The Fit landing mark: a diamond in the component's token around every node the landing names.
    // Not pickable. Rebuilt whenever the view paints another landing.
    buildLandingRings() {
        for (const ring of this.landingRings) {
            ring.removeFromParent();
            ring.material.dispose();
            this.layoutObjects.splice(this.layoutObjects.indexOf(ring), 1);
        }
        this.landingRings = [];
        let marks = 0;
        const matrix = new THREE.Matrix4();
        const none = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        const at = new THREE.Vector3();
        for (const level of [0, 1, 2]) {
            const marked = this.layout.nodes.filter((node) => node.level === level && node.landing);
            if (!marked.length) continue;
            const ring = new THREE.InstancedMesh(this.geometry('landing-ring'), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }), marked.length);
            marked.forEach((node, i) => ring.setMatrixAt(i, matrix.compose(at.set(node.x, 0.11, node.z), none, scale.setScalar(node.size * LANDING_RING))));
            ring.userData = { nodes: marked, level, landing: true };
            this.landingRings.push(this.track(level, ring));
            marks += marked.length;
        }
        // The same for the Fit landing point's marks.
        this.stage.dataset.atlasLandingMarks = String(marks);
    }

    // The Bridge: one ribbon per bridged pair of genres, from hull to hull on the style plane, in the
    // bridge token. It is not an edge between nodes, so it stays out of the selection's edges.
    buildLanding() {
        this.clearLanding();
        const list = [];
        for (const edge of this.layout.landingEdges || []) ribbon(list, [...edge.from, ...edge.to], { width: BRIDGE_WIDTH, dash: false, arrow: false });
        if (!list.length) return;
        const mesh = new THREE.Mesh(positions(list), new THREE.MeshBasicMaterial({ color: this.fit.get('bridge'), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
        mesh.position.y = 0.35;
        mesh.userData = { kind: 'bridge', edges: this.layout.landingEdges.length };
        this.planes[1].group.add(mesh);
        this.landingObjects.push(mesh);
    }

    clearLanding() {
        for (const object of this.landingObjects || []) {
            object.removeFromParent();
            object.geometry.dispose();
            object.material.dispose();
        }
        this.landingObjects = [];
    }

    stageColor(stage) {
        return (stage && this.lifecycle.stages.get(stage)) || this.colors.stateless;
    }

    // A node's fill: its lifecycle stage, or for the collector's own master its collector state.
    nodeColor(node, color) {
        if (!node.master?.collector) return color.copy(this.stageColor(node.stage));
        if (node.held) return color.copy(this.colors.state(node.held.state));
        return color.copy(this.colors.stateless).lerp(this.colors.canvas, NOT_YET);
    }

    recolor() {
        const color = new THREE.Color();
        for (const { mesh, nodes } of this.instanced) {
            nodes.forEach((node, i) => {
                this.nodeColor(node, color);
                if (this.selection && !this.selection.has(node.id)) color.lerp(this.colors.canvas, DIM);
                mesh.setColorAt(i, color);
            });
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
        for (const ring of this.provisionalRings) {
            ring.visible = ring.userData.nodes.some((node) => node.provisional);
            ring.material.color.copy(this.lifecycle.provisional);
            ring.userData.nodes.forEach((node, i) => {
                color.setRGB(1, 1, 1);
                if (this.selection && !this.selection.has(node.id)) color.lerp(this.colors.canvas, DIM);
                ring.setColorAt(i, color);
            });
            if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
        }
        for (const ring of this.heldRings) {
            ring.userData.nodes.forEach((node, i) => {
                color.copy(this.colors.state(node.held.state));
                if (this.selection && !this.selection.has(node.id)) color.lerp(this.colors.canvas, DIM);
                ring.setColorAt(i, color);
            });
            if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
        }
        for (const ring of this.landingRings) {
            ring.userData.nodes.forEach((node, i) => {
                color.copy(this.fit.get(node.landing));
                if (this.selection && !this.selection.has(node.id)) color.lerp(this.colors.canvas, DIM);
                ring.setColorAt(i, color);
            });
            if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
        }
        this.dirty = true;
    }

    applySelection() {
        this.selection = this.selected ? atlasSelection(this.byId, this.selected) : null;
        if (this.layout) {
            this.layout.edges = lateralEdges(this.layout, this.byId, this.selected, this.cotags);
            this.recolor();
            this.buildEdges();
            this.buildHulls();
            // For anything reading the frame once `data-strata-frame` settles: how many co-tag edges it drew.
            this.stage.dataset.atlasCotagEdges = String(this.layout.edges.filter((edge) => edge.kind === 'cotag').length);
        }
        this.placeRing(this.selectRing, this.selected);
        this.candidatesKey = null;
        this.dirty = true;
    }

    // The selected style's star, merged per kind. Nothing is drawn without a selected style.
    buildEdges() {
        for (const object of this.edgeObjects) {
            object.removeFromParent();
            object.geometry.dispose();
            object.material.dispose();
        }
        this.edgeObjects = [];
        const lists = new Map();
        for (const edge of this.layout.edges) {
            const a = this.byId.get(edge.a);
            const b = this.byId.get(edge.b);
            const style = ATLAS_EDGE_STYLES[edge.kind];
            const segment = a && b && style ? edgeSegment(a, b) : null;
            if (!segment) continue;
            if (!lists.has(edge.kind)) lists.set(edge.kind, []);
            ribbon(lists.get(edge.kind), segment, style);
        }
        for (const [kind, list] of lists) {
            const mesh = new THREE.Mesh(
                positions(list),
                new THREE.MeshBasicMaterial({ color: this.colors.accent, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
            );
            mesh.position.y = 0.3;
            mesh.userData = { kind };
            this.planes[1].group.add(mesh);
            this.edgeObjects.push(mesh);
        }
    }

    // Genre hulls on the style plane, merged per color and dimming. A ghost is in its host's hull,
    // and the hull's tag counts it.
    buildHulls() {
        for (const object of this.hullObjects) {
            object.removeFromParent();
            object.geometry.dispose();
            object.material.dispose();
        }
        this.hullObjects = [];
        this.hullTags = [];
        const lit = new Set();
        for (const id of this.selection || []) {
            const node = this.byId.get(id);
            if (node.entity === 'genre') lit.add(node.id);
            else lit.add(node.group);
        }
        const buckets = new Map();
        for (const { group, genre, polygon, styles, ghosts, ringOrder } of this.layout.hulls) {
            const color = ringOrder % HULL_COLORS;
            const dim = !!this.selection && !lit.has(group);
            const key = `${color}|${dim}`;
            if (!buckets.has(key)) buckets.set(key, { color, dim, shapes: [], lines: [] });
            const bucket = buckets.get(key);
            bucket.shapes.push(new THREE.Shape(polygon.map(([x, z]) => new THREE.Vector2(x, -z))));
            polygon.forEach(([x, z], i) => {
                const [nx, nz] = polygon[(i + 1) % polygon.length];
                bucket.lines.push(x, 0.08, z, nx, 0.08, nz);
            });
            // The tag sits at the hull's outermost point, away from the ring's centre.
            let outer = polygon[0];
            for (const point of polygon) if (Math.hypot(...point) > Math.hypot(...outer)) outer = point;
            const counted = `${styles} ${styles === 1 ? 'style' : 'styles'}${ghosts ? `, ${ghosts} ${ghosts === 1 ? 'ghost' : 'ghosts'}` : ''}`;
            this.hullTags.push({ level: 1, color, dim, x: outer[0], z: outer[1], text: `${genre} · ${counted}`, group });
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
                this.planes[1].group.add(object);
                this.hullObjects.push(object);
            }
        }
    }

    // Vertical links are the emergence edges only: a style's copy to the genre it is drawn under,
    // where the payload marks the edge. A ghost's link is dashed.
    updateLinks() {
        if (!this.layout) return;
        const key = verticalLinksKey({ layoutVersion: this.layoutVersion, solo: this.soloed, selected: this.selected });
        if (key === this.linksKey) return;
        this.linksKey = key;
        const main = [];
        const lit = [];
        const ghost = [];
        if (this.soloed === null) {
            for (const { from, to, ghost: dashed } of this.layout.emergence) {
                const node = this.byId.get(from);
                const genre = this.byId.get(to);
                const c = nodeCentre(node);
                const segment = [c.x, c.y, c.z, genre.x, planeY(genre.level) + 0.05, genre.z];
                if (this.selection && this.selection.has(from) && this.selection.has(to)) lit.push(...segment);
                else (dashed ? ghost : main).push(...segment);
            }
        }
        for (const [line, list] of [[this.links.main, main], [this.links.lit, lit], [this.ghostLinks, ghost]]) {
            line.geometry.dispose();
            line.geometry = positions(list);
        }
        this.ghostLinks.computeLineDistances();
        this.links.main.material.opacity = this.selection ? 0.07 : 0.32;
        this.ghostLinks.material.opacity = this.selection ? 0.07 : 0.45;
        this.stats.verticalBuilds++;
    }

    nodeLabel(node, text) {
        const el = super.nodeLabel(node, text);
        if (node.entity === 'ghost') el.classList.add('strata-label--ghost');
        return el;
    }
}
