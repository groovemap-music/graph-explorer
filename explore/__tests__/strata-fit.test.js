/**
 * The Fit landing point (strata-fit.js): a "Will it fit?" profile drawn on the Genre Atlas.
 *
 * Over the recorded atlas with its landmark masters (tests/fixtures/style-atlas*.json), the
 * synthetic projection (taste-projection.json), and the mock session profile (fit-profile.json):
 *   - each drawn component's mapping: Affinity and Novelty on their genre and style nodes, Bridge
 *     as an edge from hull to hull, Redundancy on the landmark or collector master node;
 *   - the listed components (Depth, artists and labels) never produce a position, whatever their
 *     `drawable` flag says;
 *   - a body without `evidence_entries` is listed whole and draws nothing;
 *   - nothing moves.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { adaptAtlasPayload, genreId, ghostId, layoutAtlas, masterId, polygonDistance, styleId } from '../static/js/strata-atlas-layout.js';
import { atlasMasterSlot } from '../static/js/strata-master-slots.js';
import { adaptTasteProjection, withCollectorMasters } from '../static/js/strata-taste.js';
import {
    FIT_COMPONENTS,
    LANDING_HULLS_TOUCH,
    LANDING_NO_ATLAS,
    LANDING_NO_SLOT,
    LANDING_NOT_ON_ATLAS,
    entrySentence,
    hullGap,
    paintLanding,
    placeLanding,
    planLanding,
} from '../static/js/strata-fit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', name), 'utf8'));
const ATLAS = adaptAtlasPayload({ ...fixture('style-atlas.json').body, masters: fixture('style-atlas-masters.json').masters });
const TASTE = adaptTasteProjection(fixture('taste-projection.json').body);
const PROFILE = fixture('fit-profile.json').body;

const layout = () => layoutAtlas(ATLAS, { masterSlot: atlasMasterSlot });
const tasteLayout = () => layoutAtlas(withCollectorMasters(ATLAS, TASTE).atlas, { masterSlot: atlasMasterSlot });

/** The session profile without `evidence_entries`: an app token's body, or one cached before the field. */
function capped(profile = PROFILE) {
    const copy = structuredClone(profile);
    for (const component of Object.values(copy.components)) delete component.evidence_entries;
    return copy;
}

/** A profile with one component's entries replaced and every other component silent. */
function only(component, entries) {
    return {
        release: { id: '1', title: 'Candidate' },
        components: Object.fromEntries(FIT_COMPONENTS.map((name) => [name, { score: 0, evidence: [], evidence_items: [], evidence_entries: name === component ? entries : [] }])),
    };
}

const marked = (lay, component) => lay.nodes.filter((node) => node.landing === component).map((node) => node.id).sort();

describe('planLanding', () => {
    it('reads the drawable entries into claims in their component\'s shape, and lists the rest', () => {
        const plan = planLanding(PROFILE);
        expect(plan.structured).toBe(true);
        expect(plan.release).toEqual({ id: '249504', title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
        expect(plan.claims.map(({ component, kind, name, genres, masterId: id }) => [component, kind, name ?? genres ?? id])).toEqual([
            ['affinity', 'node', 'Electronic'],
            ['affinity', 'node', 'Amber Bop'],
            ['novelty', 'node', 'Glass Drift'],
            ['novelty', 'node', 'Hi NRG'],
            ['bridge', 'edge', ['Electronic', 'Rock']],
            ['redundancy', 'master', '910001'],
        ]);
        expect(plan.listed.map(({ component }) => component)).toEqual(['affinity', 'affinity', 'novelty', 'novelty', 'novelty', 'bridge', 'depth', 'depth']);
    });

    it('draws the novelty the three-entry cap hides, from the uncapped entries', () => {
        const plan = planLanding(PROFILE);
        expect(PROFILE.components.novelty.evidence.some((line) => line.includes('Glass Drift'))).toBe(false);
        expect(plan.claims.find((claim) => claim.name === 'Glass Drift').text).toBe('Glass Drift is a style your collection has never held');
    });

    it('lists an uncapped entry in the producer\'s own sentence', () => {
        const listed = planLanding(PROFILE).listed.map(({ text }) => text);
        expect(listed).toContain('shares label RCA with 1 release you hold');
        expect(listed).toContain('deepens label RCA (1 held)');
        expect(listed).toContain('region boundaries are the v0 genre heuristic, not a computed community');
    });

    it('is null without a profile', () => {
        expect(planLanding(null)).toBeNull();
    });
});

describe('entrySentence', () => {
    it('words every claim kind as catalog-api api/fit.py _render_entry does', () => {
        expect(entrySentence({ kind: 'shared', dimension: 'genre', entity: 'Jazz', count: 1 })).toBe('shares genre Jazz with 1 release you hold');
        expect(entrySentence({ kind: 'unheld', dimension: 'artist', entity: 'Autechre' })).toBe('Autechre is an artist your collection has never held');
        expect(entrySentence({ kind: 'thread', dimension: 'label', entity: 'Warp', count: 4 })).toBe('deepens label Warp (4 held)');
        expect(entrySentence({ kind: 'bridge', entity: 'Jazz and Rock' })).toBe('bridges Jazz and Rock, which share no artist or label in your collection');
        expect(entrySentence({ kind: 'duplicate', entity: '249504' })).toBe('you already hold this exact release');
        expect(entrySentence({ kind: 'duplicate', entity: 'Kid A', detail: 'optical' })).toBe('you hold Kid A, the same record on optical');
        expect(entrySentence({ kind: 'duplicate_title', entity: 'Kid A', detail: 'Radiohead' })).toBe('you hold Kid A by Radiohead, which no master links to this pressing');
    });
});

describe('the drawn components', () => {
    it('Affinity marks the shared genre and style nodes, a style on its primary node and every ghost copy', () => {
        const lay = layout();
        const placed = placeLanding(lay, planLanding(only('affinity', [
            { dimension: 'genre', entity: 'Electronic', kind: 'shared', count: 3, entity_type: 'genre', entity_id: 'Electronic', drawable: true },
            { dimension: 'style', entity: 'Copper Drift', kind: 'shared', count: 1, entity_type: 'style', entity_id: 'Copper Drift', drawable: true },
        ])));
        paintLanding(lay, placed);
        expect(marked(lay, 'affinity')).toEqual([genreId('Electronic'), ghostId('Copper Drift', 'Blues'), styleId('Copper Drift')].sort());
        expect(placed.edges).toEqual([]);
    });

    it('Novelty marks the candidate\'s unheld style nodes, and names a style the atlas does not draw instead of placing it', () => {
        const lay = layout();
        const placed = placeLanding(lay, planLanding(PROFILE));
        paintLanding(lay, placed);
        expect(marked(lay, 'novelty')).toEqual([styleId('Glass Drift'), ghostId('Glass Drift', 'Jazz')].sort());
        expect(placed.notDrawn).toEqual([{ component: 'novelty', text: 'Hi NRG is a style your collection has never held', reason: LANDING_NOT_ON_ATLAS }]);
    });

    it('Bridge is an edge between the two genre hulls, from a point on one boundary to a point on the other', () => {
        const lay = layout();
        const placed = placeLanding(lay, planLanding(PROFILE));
        expect(placed.edges).toHaveLength(1);
        const [edge] = placed.edges;
        expect(edge.genres).toEqual(['Electronic', 'Rock']);
        const hullOf = (genre) => lay.hulls.find((h) => h.genre === genre).polygon;
        expect(polygonDistance(edge.from, hullOf('Electronic'))).toBeLessThan(1e-9);
        expect(polygonDistance(edge.to, hullOf('Rock'))).toBeLessThan(1e-9);
        // The shortest gap: no point of either hull is nearer the other.
        const length = Math.hypot(edge.to[0] - edge.from[0], edge.to[1] - edge.from[1]);
        expect(length).toBeGreaterThan(0);
        for (const p of hullOf('Electronic')) expect(polygonDistance(p, hullOf('Rock'))).toBeGreaterThanOrEqual(length - 1e-9);
        // It marks no node: the hulls are what it joins.
        expect(lay.nodes.some((node) => placed.marks.get(node.id) === 'bridge')).toBe(false);
        expect(placed.drawn.find((d) => d.component === 'bridge').nodes).toEqual([genreId('Electronic'), genreId('Rock')]);
    });

    it('Bridge over three regions joins every pair, since the regions are mutually separate, and names a pair whose hulls touch', () => {
        const placed = placeLanding(layout(), planLanding(only('bridge', [
            { dimension: 'genre', entity: 'Jazz, Rock and Blues', kind: 'bridge', count: 3, genres: ['Jazz', 'Rock', 'Blues'], drawable: true },
        ])));
        // On the recorded atlas the Rock and Blues hulls, neighbours where the ring closes, touch.
        expect(placed.edges.map((edge) => edge.genres)).toEqual([['Jazz', 'Rock'], ['Jazz', 'Blues']]);
        expect(placed.drawn.map(({ component, nodes }) => [component, nodes])).toEqual([['bridge', [genreId('Jazz'), genreId('Rock'), genreId('Blues')]]]);
        expect(placed.notDrawn).toEqual([{ component: 'bridge', text: 'Rock and Blues', reason: LANDING_HULLS_TOUCH }]);
    });

    it('Bridge reads `genres`, so a genre whose name holds commas is one region', () => {
        const placed = placeLanding(layout(), planLanding(only('bridge', [
            { dimension: 'genre', entity: 'Folk, World, & Country and Jazz', kind: 'bridge', count: 2, genres: ['Folk, World, & Country', 'Jazz'], drawable: true },
        ])));
        expect(placed.edges.map((edge) => edge.genres)).toEqual([['Folk, World, & Country', 'Jazz']]);
    });

    it('Redundancy marks the owned sibling\'s master on its landmark nodes, without the collector layer', () => {
        const lay = layout();
        paintLanding(lay, placeLanding(lay, planLanding(PROFILE)));
        // 910001 is a landmark of two styles, so it is drawn, and marked, in both cells.
        expect(marked(lay, 'redundancy')).toEqual([masterId('910001', 'Amber Bop'), masterId('910001', 'Amber Chant')]);
    });

    it('Redundancy marks the collector\'s own master in its slot when it is no landmark', () => {
        const duplicate = [{ dimension: 'release', entity: 'Sibling', kind: 'duplicate', detail: 'cd', entity_type: 'release', entity_id: '5', master_id: '7100001', drawable: true }];
        const anonymous = placeLanding(layout(), planLanding(only('redundancy', duplicate)));
        expect(anonymous.marks.size).toBe(0);
        expect(anonymous.notDrawn).toEqual([{ component: 'redundancy', text: 'you hold Sibling, the same record on cd', reason: LANDING_NO_SLOT }]);

        const lay = tasteLayout();
        paintLanding(lay, placeLanding(lay, planLanding(only('redundancy', duplicate))));
        const [node] = lay.nodes.filter((n) => n.landing === 'redundancy');
        expect(node.id).toBe(masterId('7100001', 'Copper Drift'));
        expect(node.master.collector).toBe(true);
    });
});

describe('the listed components', () => {
    const everyList = only('depth', [
        { dimension: 'artist', entity: 'A', kind: 'thread', count: 2, entity_type: 'artist', entity_id: '1', drawable: true },
        { dimension: 'label', entity: 'L', kind: 'thread', count: 2, entity_type: 'label', entity_id: '2', drawable: true },
        // A depth entry naming a drawn style is still Depth: listed.
        { dimension: 'style', entity: 'Amber Bop', kind: 'thread', count: 2, entity_type: 'style', entity_id: 'Amber Bop', drawable: true },
    ]);
    everyList.components.novelty.evidence_entries = [
        { dimension: 'artist', entity: 'Amber Bop', kind: 'unheld', entity_type: 'artist', entity_id: 'Amber Bop', drawable: true },
        { dimension: 'label', entity: 'Electronic', kind: 'unheld', entity_type: 'label', entity_id: 'Electronic', drawable: true },
    ];
    everyList.components.affinity.evidence_entries = [{ dimension: 'artist', entity: 'Rock', kind: 'shared', count: 1, entity_type: 'artist', entity_id: 'Rock', drawable: true }];
    everyList.components.redundancy.evidence_entries = [{ dimension: 'release', entity: 'T', kind: 'duplicate_title', detail: 'A', entity_type: 'release', entity_id: '9', drawable: true }];

    it('never produce a position: Depth, artists, and labels, even flagged drawable and even named like an atlas node', () => {
        const lay = tasteLayout();
        const before = lay.nodes.map((node) => [node.id, node.x, node.z]);
        const plan = planLanding(everyList);
        expect(plan.claims).toEqual([]);
        const placed = placeLanding(lay, plan);
        expect(paintLanding(lay, placed)).toBe(0);
        expect(placed.marks.size).toBe(0);
        expect(placed.edges).toEqual([]);
        expect(lay.landingEdges).toEqual([]);
        expect(lay.nodes.map((node) => [node.id, node.x, node.z])).toEqual(before);
        expect(plan.listed.map(({ component }) => component).sort()).toEqual(['affinity', 'depth', 'depth', 'depth', 'novelty', 'novelty', 'redundancy']);
    });

    it('lists every Depth entry and every artist or label of the session profile, and draws none', () => {
        const lay = layout();
        paintLanding(lay, placeLanding(lay, planLanding(PROFILE)));
        const plan = planLanding(PROFILE);
        const listedEntities = PROFILE.components.depth.evidence_entries.concat(
            ...['affinity', 'novelty'].map((name) => PROFILE.components[name].evidence_entries.filter((entry) => ['artist', 'label'].includes(entry.entity_type))),
        );
        for (const entry of listedEntities) expect(plan.listed.map(({ text }) => text)).toContain(entrySentence(entry));
        expect(lay.nodes.filter((node) => node.landing).every((node) => ['genre', 'style', 'ghost', 'master'].includes(node.entity))).toBe(true);
    });

    it('a masterless duplicate is listed, since it has no master to sit under', () => {
        const plan = planLanding(only('redundancy', [{ dimension: 'release', entity: 'X', kind: 'duplicate', detail: 'vinyl', entity_type: 'release', entity_id: '3', drawable: false }]));
        expect(plan.claims).toEqual([]);
        expect(plan.listed).toEqual([{ component: 'redundancy', text: 'you hold X, the same record on vinyl' }]);
    });
});

describe('the fallback', () => {
    it('lists a body without evidence_entries sentence by sentence, draws nothing, and invents no position', () => {
        const body = capped();
        const plan = planLanding(body);
        expect(plan.structured).toBe(false);
        expect(plan.claims).toEqual([]);
        expect(plan.listed.map(({ text }) => text)).toEqual(FIT_COMPONENTS.flatMap((name) => body.components[name].evidence));
        const lay = layout();
        const before = lay.nodes.map((node) => [node.id, node.x, node.z]);
        const placed = placeLanding(lay, plan);
        expect(paintLanding(lay, placed)).toBe(0);
        expect(placed).toEqual({ marks: new Map(), edges: [], drawn: [], notDrawn: [] });
        expect(lay.nodes.map((node) => [node.id, node.x, node.z])).toEqual(before);
    });

    it('says what it could not draw before the atlas has a layout, and places nothing', () => {
        const placed = placeLanding(null, planLanding(PROFILE));
        expect(placed.marks.size).toBe(0);
        expect(placed.edges).toEqual([]);
        expect(placed.notDrawn.map(({ reason }) => reason)).toEqual(Array(6).fill(LANDING_NO_ATLAS));
    });
});

describe('paint', () => {
    it('moves nothing, and a null placement clears every mark and edge', () => {
        const lay = tasteLayout();
        const before = lay.nodes.map((node) => [node.id, node.x, node.z, node.size]);
        const count = paintLanding(lay, placeLanding(lay, planLanding(PROFILE)));
        expect(count).toBe(marked(lay, 'affinity').length + marked(lay, 'novelty').length + marked(lay, 'redundancy').length);
        expect(lay.landingEdges).toHaveLength(1);
        expect(lay.nodes.map((node) => [node.id, node.x, node.z, node.size])).toEqual(before);
        expect(paintLanding(lay, null)).toBe(0);
        expect(lay.nodes.every((node) => node.landing === null)).toBe(true);
        expect(lay.landingEdges).toEqual([]);
    });
});

describe('hullGap', () => {
    const square = (x, z, side = 1) => [[x, z], [x + side, z], [x + side, z + side], [x, z + side]];

    it('is the shortest segment between two hulls, from the first to the second', () => {
        const gap = hullGap(square(0, 0), square(3, 0.5));
        expect(gap.length).toBe(2);
        expect([gap.from[0], gap.to[0]]).toEqual([1, 3]);
        expect(gap.from[1]).toBe(gap.to[1]);
        const back = hullGap(square(3, 0.5), square(0, 0));
        expect(back.length).toBe(2);
        expect([back.from[0], back.to[0]]).toEqual([3, 1]);
    });

    it('joins a genre with no hull through its own node', () => {
        expect(hullGap([[5, 0]], square(0, 0))).toEqual({ from: [5, 0], to: [1, 0], length: 4 });
    });

    it('is null when the hulls touch, overlap, or cross', () => {
        expect(hullGap(square(0, 0), square(1, 0))).toBeNull();
        expect(hullGap(square(0, 0, 4), square(1, 1))).toBeNull();
        // A plus sign: neither has a corner inside the other, but their sides cross.
        expect(hullGap([[0, 1], [3, 1], [3, 2], [0, 2]], [[1, 0], [2, 0], [2, 3], [1, 3]])).toBeNull();
    });

    it('leaves a touching pair of genres listed, not drawn', () => {
        const touching = {
            ...ATLAS,
            masters: [],
        };
        const lay = layoutAtlas(touching);
        lay.hulls = [
            { genre: 'Jazz', polygon: square(0, 0) },
            { genre: 'Rock', polygon: square(1, 0) },
        ];
        const placed = placeLanding(lay, planLanding(only('bridge', [{ dimension: 'genre', entity: 'Jazz and Rock', kind: 'bridge', count: 2, genres: ['Jazz', 'Rock'], drawable: true }])));
        expect(placed.edges).toEqual([]);
        expect(placed.notDrawn.map(({ reason }) => reason)).toEqual([LANDING_HULLS_TOUCH]);
    });
});
