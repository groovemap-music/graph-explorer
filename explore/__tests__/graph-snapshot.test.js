import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScriptDirect } from './helpers.js';

/**
 * Minimal d3 stub sufficient for GraphVisualization constructor in jsdom.
 */
function createD3Stub() {
    function makeChainSel() {
        const sel = {};
        const chainMethods = [
            'attr', 'style', 'text', 'call', 'on', 'classed', 'remove',
            'each', 'data', 'join', 'transition', 'duration', 'filter',
        ];
        chainMethods.forEach(m => { sel[m] = vi.fn().mockReturnValue(sel); });
        sel.append = vi.fn().mockImplementation(() => makeChainSel());
        sel.select = vi.fn().mockImplementation(() => makeChainSel());
        sel.selectAll = vi.fn().mockImplementation(() => makeChainSel());
        return sel;
    }

    const zoomMock = {
        scaleExtent: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
        transform: vi.fn(),
        scaleBy: vi.fn(),
    };

    return {
        select: vi.fn().mockImplementation(() => makeChainSel()),
        zoom: vi.fn().mockReturnValue(zoomMock),
        zoomIdentity: {},
        forceSimulation: vi.fn().mockReturnValue({
            force: vi.fn().mockReturnThis(),
            on: vi.fn().mockReturnThis(),
            stop: vi.fn(),
            alpha: vi.fn().mockReturnThis(),
            alphaTarget: vi.fn().mockReturnThis(),
            restart: vi.fn(),
        }),
        forceLink: vi.fn().mockReturnValue({ id: vi.fn().mockReturnThis(), distance: vi.fn().mockReturnThis() }),
        forceManyBody: vi.fn().mockReturnValue({ strength: vi.fn().mockReturnThis() }),
        forceCenter: vi.fn(),
        forceCollide: vi.fn().mockReturnValue({ radius: vi.fn().mockReturnThis() }),
        drag: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis() }),
    };
}

function setupDOM() {
    document.body.textContent = '';

    const container = document.createElement('div');
    container.id = 'graphContainer';
    container.style.width = '400px';
    container.style.height = '400px';
    document.body.appendChild(container);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'graphSvg';
    document.body.appendChild(svg);

    const placeholder = document.createElement('div');
    placeholder.id = 'graphPlaceholder';
    document.body.appendChild(placeholder);

    ['zoomInBtn', 'zoomOutBtn', 'zoomResetBtn', 'fullscreenBtn'].forEach(id => {
        const btn = document.createElement('button');
        btn.id = id;
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        btn.appendChild(icon);
        document.body.appendChild(btn);
    });
}

describe('GraphVisualization snapshot/restore/clearAll/addEntity', () => {
    let graph;

    beforeAll(() => {
        delete globalThis.window;
        globalThis.window = globalThis;
        globalThis.d3 = createD3Stub();
        setupDOM();
        loadScriptDirect('graph-state.js');
        loadScriptDirect('graph.js');
    });

    beforeEach(() => {
        setupDOM();
        globalThis.d3 = createD3Stub();
        graph = new GraphVisualization('graphContainer'); // eslint-disable-line no-undef
    });

    it('snapshot returns deep copies of current nodes and links', () => {
        graph.nodes = [{ id: '1', name: 'Kraftwerk' }];
        graph.links = [{ source: '1', target: '2' }];
        const snap = graph.snapshot();
        expect(snap.nodes).toEqual([{ id: '1', name: 'Kraftwerk' }]);
        expect(snap.links).toEqual([{ source: '1', target: '2' }]);
        // Verify deep copy — mutations don't affect original
        snap.nodes[0].name = 'changed';
        expect(graph.nodes[0].name).toBe('Kraftwerk');
    });

    it('restore replaces nodes and links and calls _render', () => {
        graph._render = vi.fn();
        graph.restore({ nodes: [{ id: '2' }], links: [] });
        expect(graph.nodes).toEqual([{ id: '2' }]);
        expect(graph.links).toEqual([]);
        expect(graph._render).toHaveBeenCalled();
    });

    it('clearAll empties nodes and links and calls _render', () => {
        graph.nodes = [{ id: '1' }];
        graph.links = [{ source: '1', target: '2' }];
        graph._render = vi.fn();
        graph.clearAll();
        expect(graph.nodes).toEqual([]);
        expect(graph.links).toEqual([]);
        expect(graph._render).toHaveBeenCalled();
    });

    it('addEntity appends a node and calls _render', () => {
        graph.nodes = [];
        graph._render = vi.fn();
        graph.addEntity({ name: 'Aphex Twin', entity_type: 'artist' });
        expect(graph.nodes).toHaveLength(1);
        expect(graph.nodes[0]).toMatchObject({ id: 'Aphex Twin', name: 'Aphex Twin', type: 'artist' });
        expect(graph._render).toHaveBeenCalled();
    });
});

/**
 * Personal layers stay out of shareable snapshots (ADR 0016 section 6). The Taste Strata layer
 * lives in the Genre Atlas, beside the graph; a share link sends `shareableSnapshot()` and nothing
 * else (app.js _shareSnapshot). These load the real atlas with a signed-in collector's projection
 * next to a graph and show that no part of the projection reaches the snapshot body.
 */
describe('shareable snapshots carry no Taste Strata layer', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', name), 'utf8'));
    const ATLAS = { ...fixture('style-atlas.json').body, masters: fixture('style-atlas-masters.json').masters };
    const TASTE = fixture('taste-projection.json').body;
    let graph;

    beforeAll(() => {
        // The scripts declare globals, so they load once per file, whichever describe runs first.
        if (typeof GraphVisualization === 'function') return; // eslint-disable-line no-undef
        delete globalThis.window;
        globalThis.window = globalThis;
        globalThis.d3 = createD3Stub();
        setupDOM();
        loadScriptDirect('graph-state.js');
        loadScriptDirect('graph.js');
    });

    beforeEach(() => {
        setupDOM();
        globalThis.d3 = createD3Stub();
        graph = new GraphVisualization('graphContainer'); // eslint-disable-line no-undef
        graph.centerName = 'Copper Drift';
        graph.centerType = 'style';
        graph.nodes = [
            { id: 'c', name: 'Copper Drift', type: 'style', isCenter: true },
            { id: 'cat', name: 'Artists', type: 'category', isCategory: true },
            { id: 'a', name: 'Kraftwerk', nodeId: '123', type: 'artist' },
        ];
    });

    async function signedInAtlas() {
        const { GenreAtlas } = await import('../static/js/strata-atlas.js');
        const auth = { isLoggedIn: () => true, getToken: () => 'tok', onChange: () => () => {} };
        const api = {
            getStyleAtlas: async () => ({ ok: true, status: 200, body: ATLAS }),
            getTasteProjection: async () => ({ ok: true, status: 200, body: TASTE }),
        };
        const renderer = Object.assign(new EventTarget(), { setLayout() {}, setYear() {}, select() {}, start() {}, stop() {}, resize() {}, refreshTaste() {}, dispose() {} });
        const atlas = new GenreAtlas({ doc: document, api, auth, createRenderer: () => renderer, observeTheme: false });
        document.body.append(atlas.root);
        await atlas.show();
        return atlas;
    }

    /** Every id, count, state, and recorded time of the projection, as text that must not leak. */
    function personalTokens() {
        const tokens = new Set(['recorded', 'owned', 'wanted', 'held', 'taste', 'collector']);
        for (const master of TASTE.masters) tokens.add(master.id);
        for (const list of [TASTE.genres, TASTE.styles, TASTE.masters]) {
            for (const entry of list) for (const span of Object.values(entry.recorded_at)) if (span) for (const at of [span.first, span.last]) if (at) tokens.add(at);
        }
        return [...tokens];
    }

    it('sends only each drawn entity\'s id and type, and the centre', () => {
        expect(graph.shareableSnapshot()).toEqual({
            nodes: [{ id: 'Copper Drift', type: 'style' }, { id: '123', type: 'artist' }],
            center: { id: 'Copper Drift', type: 'style' },
        });
        graph.centerName = null;
        expect(graph.shareableSnapshot()).toBeNull();
    });

    it('is the same body, with no part of the projection in it, while the layer is on screen', async () => {
        const before = JSON.stringify(graph.shareableSnapshot());
        const atlas = await signedInAtlas();
        // The layer is really there: the collector's masters are placed and their styles marked.
        expect(atlas.tasteStatus).toBe('ready');
        expect(atlas.layout.nodes.filter((node) => node.master?.collector)).toHaveLength(3);
        expect(atlas.layout.nodes.find((node) => node.id === 's:Copper Drift').held).not.toBeNull();
        const body = JSON.stringify(graph.shareableSnapshot());
        expect(body).toBe(before);
        for (const token of personalTokens()) expect(body).not.toContain(token);
        const undo = JSON.stringify(graph.snapshot());
        for (const token of personalTokens().filter((t) => /\d{4}-|^\d+$/.test(t))) expect(undo).not.toContain(token);
        atlas.dispose();
    });

    it('drops anything personal a graph node might carry, since only id and type are sent', () => {
        graph.nodes[2] = { ...graph.nodes[2], held: { state: 'owned', items: 3 }, recorded_at: { owned: { first: '2019-03-02T10:00:00Z' } }, taste: TASTE };
        const body = JSON.stringify(graph.shareableSnapshot());
        for (const token of personalTokens()) expect(body).not.toContain(token);
    });
});
