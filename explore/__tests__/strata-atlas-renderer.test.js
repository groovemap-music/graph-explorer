/**
 * The Genre Atlas renderer builds the real three.js scene in jsdom with a stub for the WebGL
 * context, as strata-renderer.test.js does for concept A: lifecycle color from the tokens, ghosts
 * as wireframes, the provisional dashed ring, hulls that count their ghosts, emergence links only
 * where the payload marks them, lateral edges only for a selection, and the engine's resolve
 * picking unchanged.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { STRATA_TOKENS } from '../static/js/strata-renderer.js';
import { AtlasRenderer, FIT_DRAWN, LIFECYCLE_STAGES, atlasLabel, fitTokenName, lifecycleTokenName } from '../static/js/strata-atlas-renderer.js';
import { adaptAtlasPayload, layoutAtlas } from '../static/js/strata-atlas-layout.js';
import { resolvePick } from '../static/js/strata-scene.js';
import { atlasMasterSlot } from '../static/js/strata-master-slots.js';
import { stateTokenName } from '../static/js/strata-collector.js';
import { adaptTasteProjection, paintTaste, withCollectorMasters } from '../static/js/strata-taste.js';
import { paintLanding, placeLanding, planLanding } from '../static/js/strata-fit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'style-atlas.json'), 'utf8')).body;
const RECT = { left: 0, top: 0, width: 1000, height: 700 };

const TOKENS = new Map([
    ...[STRATA_TOKENS.canvas, STRATA_TOKENS.planeFill, STRATA_TOKENS.planeLine, STRATA_TOKENS.link, STRATA_TOKENS.accent, STRATA_TOKENS.hover, STRATA_TOKENS.stateless, STRATA_TOKENS.blocked].map((name, i) => [name, `#10203${i}`]),
    ...STRATA_TOKENS.hull.map((name, i) => [name, `#4040${i}0`]),
    ...Object.values(STRATA_TOKENS.edge).map((name, i) => [name, `#5050${i}0`]),
    ...[...LIFECYCLE_STAGES, 'provisional'].flatMap((stage, i) => ['light', 'dark'].map((theme) => [lifecycleTokenName(stage, theme), `#c0${i}0${theme === 'dark' ? 'f' : '0'}0`])),
    ...FIT_DRAWN.flatMap((component, i) => ['light', 'dark'].map((theme) => [fitTokenName(component, theme), `#a${i}a0${theme === 'dark' ? 'f' : '0'}0`])),
]);
TOKENS.set(STRATA_TOKENS.canvas, '#000000');
const COLLECTOR_TOKENS = new Map(['none', 'wanted', 'owned', 'wanted-owned'].map((state, i) => [stateTokenName(state, 'dark'), `#e0${i}0e0`]));

let mounted = [];

function mount({ layout = layoutAtlas(adaptAtlasPayload(BODY)), cotags, tokens = TOKENS } = {}) {
    const stage = document.createElement('div');
    document.body.append(stage);
    const gl = { draws: 0, setPixelRatio() {}, setSize() {}, render() { this.draws++; }, dispose() {} };
    const renderer = new AtlasRenderer(stage, {
        createRenderer: () => gl,
        readToken: (name) => tokens.get(name) || '',
        theme: () => 'dark',
        matchMedia: null,
        measure: () => RECT,
        now: () => 0,
        requestFrame: () => 1,
        cancelFrame: () => {},
        pixelRatio: 1,
        cotags,
    });
    renderer.setLayout(layout);
    mounted.push(renderer);
    return { renderer, stage, layout, gl };
}

afterEach(() => {
    for (const renderer of mounted) if (renderer.canvas.isConnected) renderer.dispose();
    mounted = [];
    vi.restoreAllMocks();
    document.body.textContent = '';
});

function colorOf(renderer, id) {
    const entry = renderer.instanced.find((e) => e.nodes.some((n) => n.id === id));
    const color = new THREE.Color();
    entry.mesh.getColorAt(entry.nodes.findIndex((n) => n.id === id), color);
    return `#${color.getHexString()}`;
}

const stageToken = (stage) => TOKENS.get(lifecycleTokenName(stage, 'dark'));

describe('scene', () => {
    it('draws genres, styles, and ghosts as instanced meshes, ghosts as wireframes, and nothing on the master plane', () => {
        const { renderer, layout } = mount();
        expect(renderer.instanced.map((e) => `${e.level}|${e.kind}`).sort()).toEqual(['0|solid', '1|ghost', '1|solid']);
        const ghosts = renderer.instanced.find((e) => e.kind === 'ghost');
        expect(ghosts.mesh.material.wireframe).toBe(true);
        expect(ghosts.nodes.every((n) => n.entity === 'ghost')).toBe(true);
        const held = renderer.instanced.flatMap((e) => e.nodes.map((n) => n.id));
        expect(held.sort()).toEqual(layout.nodes.map((n) => n.id).sort());
        // The served positions, unchanged, are the instance positions.
        const matrix = new THREE.Matrix4();
        ghosts.mesh.getMatrixAt(0, matrix);
        const at = new THREE.Vector3().setFromMatrixPosition(matrix);
        expect(at.x).toBeCloseTo(ghosts.nodes[0].x, 5);
        expect(at.z).toBeCloseTo(ghosts.nodes[0].z, 5);
    });

    it('draws placed landmark masters on the master plane, without the provisional ring', () => {
        const body = { ...BODY, masters: BODY.styles.slice(0, 5).map((s, i) => ({ master_id: i + 1, title: `M${i}`, year: 1970, style: s.style, release_count: 9 })) };
        const layout = layoutAtlas(adaptAtlasPayload(body), { masterSlot: (m, { style }) => ({ x: style.x * 1.01, y: style.y * 1.01, radius: 0.001 }) });
        const { renderer, stage } = mount({ layout });
        const masters = renderer.instanced.find((e) => e.level === 2);
        expect(masters.nodes.map((n) => n.id)).toEqual(body.masters.map((m) => `m:${m.master_id}@${m.style}`));
        expect(masters.shape).toBe('disc');
        expect(renderer.provisionalRings.every((ring) => ring.userData.nodes.every((n) => n.level === 1))).toBe(true);
        expect(stage.querySelectorAll('.strata-plane-label')[2].textContent).toBe('Masters5');
    });

    it('names the planes and counts styles and ghosts', () => {
        const { stage } = mount();
        const labels = [...stage.querySelectorAll('.strata-plane-label')].map((el) => el.textContent);
        expect(labels).toEqual([`Genres${BODY.genres.length}`, `Styles${BODY.styles.length} + ${BODY.ghosts.length} ghosts`, 'Mastersnone served']);
    });

    it('colors each node by its lifecycle stage token, and a scrub repaints without rebuilding', () => {
        const { renderer, layout } = mount();
        const style = layout.nodes.find((n) => n.entity === 'style' && new Set(n.data.stages).size > 2);
        const { timeline } = layout.atlas;
        expect(colorOf(renderer, style.id)).toBe(stageToken(style.data.stage));
        const meshes = renderer.instanced.map((e) => e.mesh);
        const index = style.data.stages.findIndex((s, k) => BODY.rule.stages[s] !== style.data.stage && k > 0);
        renderer.setYear(timeline.firstYear + index);
        expect(colorOf(renderer, style.id)).toBe(stageToken(BODY.rule.stages[style.data.stages[index]]));
        for (const ghost of style.ghosts) expect(colorOf(renderer, ghost)).toBe(colorOf(renderer, style.id));
        expect(renderer.instanced.map((e) => e.mesh)).toEqual(meshes);
    });

    it('colors a genre absent before it emerges and state-less after', () => {
        const { renderer, layout } = mount();
        const genre = layout.nodes.find((n) => n.entity === 'genre' && n.emergenceYear > layout.atlas.timeline.firstYear);
        renderer.setYear(genre.emergenceYear - 1);
        expect(colorOf(renderer, genre.id)).toBe(stageToken('absent'));
        renderer.setYear(genre.emergenceYear);
        expect(colorOf(renderer, genre.id)).toBe(TOKENS.get(STRATA_TOKENS.stateless));
    });

    it('shows the provisional dashed ring only in a provisional year, in the provisional token', () => {
        const { renderer, layout } = mount();
        const { timeline } = layout.atlas;
        expect(renderer.provisionalRings).toHaveLength(1);
        const [ring] = renderer.provisionalRings;
        expect(ring.userData.nodes).toHaveLength(BODY.styles.length + BODY.ghosts.length);
        expect(renderer.instanced.some((entry) => entry.mesh === ring)).toBe(false);
        expect(`#${ring.material.color.getHexString()}`).toBe(stageToken('provisional'));
        expect(ring.visible).toBe(true);
        renderer.setYear(timeline.provisionalFrom - 1);
        expect(ring.visible).toBe(false);
        renderer.setYear(timeline.provisionalFrom);
        expect(ring.visible).toBe(true);
        // Dashes: the ring geometry is broken into separate arcs.
        expect(ring.geometry.getAttribute('position').count).toBeGreaterThan(0);
    });

    it('throws when a lifecycle token is missing rather than inventing a color', () => {
        const tokens = new Map(TOKENS);
        tokens.delete(lifecycleTokenName('emerging', 'dark'));
        expect(() => mount({ tokens })).toThrow(/--groovemap-state-lifecycle-emerging-dark/);
    });

    it('draws one hull per genre and tags it with the styles and ghosts it counts', () => {
        const { renderer, layout } = mount();
        expect(renderer.hullTags).toHaveLength(layout.hulls.length);
        for (const hull of layout.hulls) {
            const tag = renderer.hullTags.find((t) => t.group === hull.group);
            expect(tag.text).toContain(hull.genre);
            expect(tag.text).toContain(`${hull.styles} style`);
            if (hull.ghosts) expect(tag.text).toContain(`${hull.ghosts} ghost`);
        }
        expect(renderer.hullObjects.length).toBeGreaterThan(0);
    });
});

describe('edges', () => {
    it('draws vertical links for the emergence edges only, dashed for a ghost', () => {
        const { renderer, layout } = mount();
        renderer.render();
        const segments = (line) => line.geometry.getAttribute('position').count / 2;
        const ghostLinks = layout.emergence.filter((link) => link.ghost).length;
        expect(segments(renderer.links.main) + segments(renderer.ghostLinks)).toBe(layout.emergence.length);
        expect(segments(renderer.ghostLinks)).toBe(ghostLinks);
        expect(layout.emergence.length).toBeLessThan(layout.nodes.filter((n) => n.level === 1).length);
    });

    it('draws no lateral edge until a style is selected, then its star only', () => {
        const { renderer, layout } = mount();
        expect(renderer.edgeObjects).toEqual([]);
        const ghost = layout.nodes.find((n) => n.entity === 'ghost');
        renderer.select(ghost.ghostOf);
        expect(renderer.edgeObjects.map((m) => m.userData.kind)).toEqual(['ghost']);
        expect(layout.edges.every((edge) => edge.a === ghost.ghostOf)).toBe(true);
        renderer.select(null);
        expect(renderer.edgeObjects).toEqual([]);
    });

    it('draws co-tag edges from the co-tag source for the selected style only', () => {
        const layout = layoutAtlas(adaptAtlasPayload(BODY));
        const [a, b] = layout.nodes.filter((n) => n.entity === 'style' && Math.hypot(n.x, n.z) > 15);
        const { renderer } = mount({ layout, cotags: (style) => (style === a.style ? [{ other: b.style, release_count: 50, rank: 1 }] : []) });
        renderer.select(a.id);
        expect(renderer.edgeObjects.some((m) => m.userData.kind === 'cotag')).toBe(true);
        renderer.select(b.id);
        expect(renderer.edgeObjects.some((m) => m.userData.kind === 'cotag')).toBe(false);
    });

    it('draws only the co-tag pairs whose two styles are drawn, and clears them with the selection', () => {
        const layout = layoutAtlas(adaptAtlasPayload(BODY));
        const [a, b, c] = layout.nodes.filter((n) => n.entity === 'style');
        const entries = [
            { other: b.style, release_count: 50, rank: 1 },
            { other: 'Not Drawn', release_count: 40, rank: 2 },
            { other: c.style, release_count: 30, rank: 3 },
        ];
        const { renderer, stage } = mount({ layout, cotags: (style) => (style === a.style ? entries : []) });
        const cotagEdges = () => renderer.layout.edges.filter((edge) => edge.kind === 'cotag');
        expect(stage.dataset.atlasCotagEdges).toBe('0');
        renderer.select(a.id);
        expect(cotagEdges().map((edge) => edge.b)).toEqual([b.id, c.id]);
        expect(stage.dataset.atlasCotagEdges).toBe('2');
        renderer.select(null);
        expect(cotagEdges()).toEqual([]);
        expect(renderer.edgeObjects).toEqual([]);
        expect(stage.dataset.atlasCotagEdges).toBe('0');
    });

    it('draws the co-tags that arrive after the selection once the view refreshes the lateral edges', () => {
        const layout = layoutAtlas(adaptAtlasPayload(BODY));
        const [a, b] = layout.nodes.filter((n) => n.entity === 'style');
        const served = new Map();
        const { renderer, stage } = mount({ layout, cotags: (style) => served.get(style) || [] });
        renderer.select(a.id);
        expect(stage.dataset.atlasCotagEdges).toBe('0');
        served.set(a.style, [{ other: b.style, release_count: 9, rank: 1 }]);
        renderer.refreshLateral();
        expect(stage.dataset.atlasCotagEdges).toBe('1');
        expect(renderer.edgeObjects.some((m) => m.userData.kind === 'cotag')).toBe(true);
    });

    it('lights the selected style, its ghosts, and its parent genres', () => {
        const { renderer, layout } = mount();
        const ghost = layout.nodes.find((n) => n.entity === 'ghost');
        renderer.select(ghost.id);
        const primary = layout.nodes.find((n) => n.id === ghost.ghostOf);
        expect(renderer.selection.has(primary.id)).toBe(true);
        expect(renderer.selection.has(`g:${ghost.genre}`)).toBe(true);
        const stranger = layout.nodes.find((n) => n.entity === 'style' && !renderer.selection.has(n.id));
        expect(colorOf(renderer, stranger.id)).not.toBe(stageToken(stranger.stage));
    });
});

describe('picking and labels', () => {
    it('picks through the engine’s resolve picking: the node under the pointer, a ghost included', () => {
        const { renderer, layout } = mount();
        renderer.render();
        for (const node of [layout.nodes.find((n) => n.entity === 'genre'), layout.nodes.find((n) => n.entity === 'ghost')]) {
            const at = renderer.screenPosition(node);
            const { node: picked, candidates } = renderer.hitsAt(at.x, at.y);
            expect(picked.id).toBe(node.id);
            // The winner is the pure function's over the same hits.
            expect(resolvePick(candidates.map((c) => ({ node: c.node, screen: renderer.screenPosition(c.node) })), { pointer: at }).node.id).toBe(node.id);
        }
    });

    it('labels a ghost as one, and marks its label', () => {
        const { renderer, layout, stage } = mount();
        const ghost = layout.nodes.find((n) => n.entity === 'ghost');
        expect(atlasLabel(ghost)).toBe(`${ghost.label} ↗`);
        renderer.hover(ghost.id);
        renderer.render();
        const label = stage.querySelector(`.strata-label[data-node="${CSS.escape(ghost.id)}"]`);
        expect(label.textContent).toBe(`${ghost.label} ↗`);
        expect(label.classList.contains('strata-label--ghost')).toBe(true);
    });

    it('builds, renders, labels, and picks without writing a style attribute or parsing HTML', () => {
        const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
        const innerHTML = vi.spyOn(Element.prototype, 'innerHTML', 'set');
        const { renderer, layout } = mount();
        renderer.render();
        renderer.select(layout.nodes.find((n) => n.entity === 'ghost').id);
        renderer.setYear(1970);
        renderer.solo(1);
        renderer.render();
        renderer.pick(500, 350);
        renderer.refreshColors();
        expect(setAttribute.mock.calls.filter(([name]) => String(name).toLowerCase() === 'style')).toEqual([]);
        expect(innerHTML).not.toHaveBeenCalled();
    });

    it('releases its own objects on dispose', () => {
        const { renderer, stage } = mount();
        renderer.dispose();
        expect(renderer.ghostLinks.parent).toBeNull();
        expect(stage.querySelector('canvas')).toBeNull();
    });
});

describe('the Taste Strata layer', () => {
    const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', name), 'utf8'));
    const ATLAS = { ...BODY, masters: fixture('style-atlas-masters.json').masters };
    const TASTE = adaptTasteProjection(fixture('taste-projection.json').body);
    const tokens = new Map([...TOKENS, ...COLLECTOR_TOKENS]);
    const collectorToken = (state) => COLLECTOR_TOKENS.get(stateTokenName(state, 'dark'));

    function tasteMount(year = null) {
        const layout = layoutAtlas(withCollectorMasters(adaptAtlasPayload(ATLAS), TASTE).atlas, { masterSlot: atlasMasterSlot });
        paintTaste(layout, TASTE, year);
        return mount({ layout, tokens });
    }

    function ringColor(renderer, id) {
        const ring = renderer.heldRings.find((r) => r.userData.nodes.some((n) => n.id === id));
        if (!ring) return null;
        const color = new THREE.Color();
        ring.getColorAt(ring.userData.nodes.findIndex((n) => n.id === id), color);
        return `#${color.getHexString()}`;
    }

    it('rings every held genre, style, ghost, and landmark master in its collector state token, and nothing else', () => {
        const { renderer, layout, stage } = tasteMount();
        const ringed = renderer.heldRings.flatMap((ring) => ring.userData.nodes.map((n) => n.id)).sort();
        expect(ringed).toEqual(layout.nodes.filter((n) => n.held && !n.master?.collector).map((n) => n.id).sort());
        // The count a journey reads once the frame settles.
        expect(stage.dataset.atlasHeldMarks).toBe(String(ringed.length));
        expect(ringColor(renderer, 's:Copper Drift')).toBe(collectorToken('wanted-owned'));
        expect(ringColor(renderer, 'h:Copper Drift@Blues')).toBe(collectorToken('wanted-owned'));
        expect(ringColor(renderer, 'm:910001@Amber Bop')).toBe(collectorToken('owned'));
        expect(renderer.instanced.some((entry) => renderer.heldRings.includes(entry.mesh))).toBe(false);
    });

    it('draws the collector\'s masters in their state color on the master plane, and counts them there', () => {
        const { renderer, stage } = tasteMount();
        expect(colorOf(renderer, 'm:7100002@Amber Bop')).toBe(collectorToken('wanted'));
        expect(colorOf(renderer, 'm:7100001@Copper Drift')).toBe(collectorToken('wanted-owned'));
        expect(ringColor(renderer, 'm:7100001@Copper Drift')).toBeNull();
        expect(stage.querySelectorAll('.strata-plane-label')[2].textContent).toBe(`Masters${ATLAS.masters.length} + 3 yours`);
        expect(atlasLabel(renderer.byId.get('s:Copper Drift'))).toBe('Copper Drift · 1 yours');
    });

    it('follows the recorded-as-of year: a later node loses its ring and a later master fades, and nothing moves', () => {
        const { renderer, layout, stage } = tasteMount();
        const at = layout.nodes.map((n) => [n.id, n.x, n.z]);
        const before = Number(stage.dataset.atlasHeldMarks);
        paintTaste(layout, TASTE, 2016);
        renderer.refreshTaste();
        expect(Number(stage.dataset.atlasHeldMarks)).toBeLessThan(before);
        expect(ringColor(renderer, 's:Amber Bop')).toBeNull();
        expect(ringColor(renderer, 's:Copper Drift')).toBe(collectorToken('wanted-owned'));
        expect(colorOf(renderer, 'm:7100002@Amber Bop')).not.toBe(collectorToken('wanted'));
        expect(layout.nodes.map((n) => [n.id, n.x, n.z])).toEqual(at);
        paintTaste(layout, TASTE, null);
        renderer.refreshTaste();
        expect(ringColor(renderer, 's:Amber Bop')).toBe(collectorToken('wanted-owned'));
        expect(renderer.layoutObjects.filter((object) => object.userData?.held)).toHaveLength(renderer.heldRings.length);
    });
});

describe('the Fit landing point', () => {
    const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', name), 'utf8'));
    const ATLAS = { ...BODY, masters: fixture('style-atlas-masters.json').masters };
    const PROFILE = fixture('fit-profile.json').body;
    const fitToken = (component) => TOKENS.get(fitTokenName(component, 'dark'));

    function landingMount(profile = PROFILE) {
        const layout = layoutAtlas(adaptAtlasPayload(ATLAS), { masterSlot: atlasMasterSlot });
        paintLanding(layout, placeLanding(layout, planLanding(profile)));
        return mount({ layout });
    }

    function diamondColor(renderer, id) {
        const ring = renderer.landingRings.find((r) => r.userData.nodes.some((n) => n.id === id));
        if (!ring) return null;
        const color = new THREE.Color();
        ring.getColorAt(ring.userData.nodes.findIndex((n) => n.id === id), color);
        return `#${color.getHexString()}`;
    }

    it('draws a diamond in the component token around every node the landing marks, and nothing else', () => {
        const { renderer, layout, stage } = landingMount();
        const ringed = renderer.landingRings.flatMap((ring) => ring.userData.nodes.map((n) => n.id)).sort();
        expect(ringed).toEqual(layout.nodes.filter((n) => n.landing).map((n) => n.id).sort());
        expect(stage.dataset.atlasLandingMarks).toBe(String(ringed.length));
        expect(diamondColor(renderer, 'g:Electronic')).toBe(fitToken('affinity'));
        expect(diamondColor(renderer, 's:Amber Bop')).toBe(fitToken('affinity'));
        expect(diamondColor(renderer, 's:Glass Drift')).toBe(fitToken('novelty'));
        expect(diamondColor(renderer, 'h:Glass Drift@Jazz')).toBe(fitToken('novelty'));
        expect(diamondColor(renderer, 'm:910001@Amber Bop')).toBe(fitToken('redundancy'));
        expect(diamondColor(renderer, 's:Copper Drift')).toBeNull();
        expect(renderer.instanced.some((entry) => renderer.landingRings.includes(entry.mesh))).toBe(false);
    });

    it('draws the Bridge as one ribbon on the style plane, in the bridge token', () => {
        const { renderer } = landingMount();
        expect(renderer.landingObjects).toHaveLength(1);
        const [bridge] = renderer.landingObjects;
        expect(bridge.userData).toEqual({ kind: 'bridge', edges: 1 });
        expect(bridge.parent).toBe(renderer.planes[1].group);
        expect(`#${bridge.material.color.getHexString()}`).toBe(fitToken('bridge'));
    });

    it('says in each marked node\'s label what the mark means, so the cue is never color alone', () => {
        const { renderer } = landingMount();
        expect(atlasLabel(renderer.byId.get('s:Glass Drift'))).toBe('Glass Drift · new to you');
        expect(atlasLabel(renderer.byId.get('h:Glass Drift@Jazz'))).toBe('Glass Drift ↗ · new to you');
        expect(atlasLabel(renderer.byId.get('g:Electronic'))).toBe('Electronic · shared');
        expect(atlasLabel(renderer.byId.get('m:910001@Amber Bop'))).toBe('Amber Bop Landmark 1 · you hold this record');
    });

    it('draws nothing for a body without evidence_entries', () => {
        const capped = structuredClone(PROFILE);
        for (const component of Object.values(capped.components)) delete component.evidence_entries;
        const { renderer } = landingMount(capped);
        expect(renderer.landingRings).toEqual([]);
        expect(renderer.landingObjects).toEqual([]);
    });

    it('redraws a cleared landing without moving a node, and releases what it drew', () => {
        const { renderer, layout } = landingMount();
        const at = layout.nodes.map((n) => [n.id, n.x, n.z]);
        paintLanding(layout, null);
        renderer.refreshLanding();
        expect(renderer.landingRings).toEqual([]);
        expect(renderer.landingObjects).toEqual([]);
        expect(renderer.layoutObjects.filter((object) => object.userData?.landing)).toEqual([]);
        expect(layout.nodes.map((n) => [n.id, n.x, n.z])).toEqual(at);
    });

    it('throws when a Fit token is missing rather than inventing a color', () => {
        const tokens = new Map(TOKENS);
        tokens.delete(fitTokenName('bridge', 'dark'));
        expect(() => mount({ tokens })).toThrow(/--groovemap-state-fit-bridge-dark/);
    });
});
