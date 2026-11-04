import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as realD3 from 'd3';
import { loadScriptDirect } from './helpers.js';

/**
 * Regression for gm-graph-explorer-z59a: the explore API returns some label
 * rows with a null name (David Bowie's ids 11358 and 25487). Those rows used to
 * throw `name.length` inside _render, which left the 'Loading graph...' spinner
 * up forever.
 *
 * These tests use the real d3 rather than the chainable mock in graph.test.js,
 * because the mock never calls the label and tooltip callbacks, so it cannot
 * see a null name reach the render path.
 */

function setupDOM() {
    document.body.textContent = '';

    const container = document.createElement('div');
    container.id = 'graphContainer';
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
        document.body.appendChild(btn);
    });

    const toast = document.createElement('div');
    toast.id = 'shareToast';
    const toastMsg = document.createElement('span');
    toastMsg.id = 'shareToastMsg';
    toast.appendChild(toastMsg);
    document.body.appendChild(toast);
}

const bowieData = {
    center: { id: 'david-bowie', name: 'David Bowie', type: 'artist' },
    categories: [
        { id: 'cat-labels', name: 'Labels', category: 'labels', count: 3 },
    ],
};

const bowieLabels = {
    children: [
        { id: 11358, name: null, type: 'label' },
        { id: 25487, name: null, type: 'label' },
        { id: 2, name: 'Parlophone', type: 'label' },
    ],
    total: 3,
    limit: 30,
    has_more: false,
    offset: 0,
};

function nodeTexts(graph, selector) {
    return graph.g.selectAll(selector).nodes().map(n => n.textContent);
}

describe('GraphLabels', () => {
    beforeAll(() => {
        delete globalThis.window;
        globalThis.window = globalThis;
        loadScriptDirect('graph-labels.js');
    });

    it('treats null, undefined, blank and non-string names as missing', () => {
        const { hasName } = window.GraphLabels;
        expect(hasName(null)).toBe(false);
        expect(hasName(undefined)).toBe(false);
        expect(hasName('')).toBe(false);
        expect(hasName('   ')).toBe(false);
        expect(hasName(42)).toBe(false);
        expect(hasName('Parlophone')).toBe(true);
    });

    it('falls back to a readable type-based label, never the text null', () => {
        const { fallbackName, rowName } = window.GraphLabels;
        expect(fallbackName('label')).toBe('Unknown label');
        expect(fallbackName('load-more')).toBe('Unknown load more');
        expect(fallbackName(undefined)).toBe('Unknown item');
        expect(rowName({ name: null, type: 'label' })).toBe('Unknown label');
        expect(rowName({ name: 'Parlophone', type: 'label' })).toBe('Parlophone');
        expect(rowName(null)).toBe('Unknown item');
    });

    it('prefers displayName for nodes, then name, then the fallback', () => {
        const { nodeName } = window.GraphLabels;
        expect(nodeName({ displayName: 'Releases', name: 'Releases (3)', type: 'category' })).toBe('Releases');
        expect(nodeName({ displayName: null, name: 'Parlophone', type: 'label' })).toBe('Parlophone');
        expect(nodeName({ name: null, type: 'artist' })).toBe('Unknown artist');
    });
});

describe('GraphVisualization with null-named explore rows', () => {
    let graph;

    beforeAll(() => {
        delete globalThis.window;
        globalThis.window = globalThis;
        globalThis.d3 = realD3;
        // jsdom has no SVG layout. d3-zoom sizes its default extent from the root
        // SVG's width/height baseVal, so give it fixed values.
        for (const dim of ['width', 'height']) {
            Object.defineProperty(SVGSVGElement.prototype, dim, {
                configurable: true,
                get() { return { baseVal: { value: dim === 'width' ? 800 : 600 } }; },
            });
        }
        loadScriptDirect('graph-state.js');
        loadScriptDirect('graph-labels.js');
        loadScriptDirect('graph.js');
    });

    beforeEach(() => {
        setupDOM();
        window.apiClient = {
            expand: vi.fn().mockResolvedValue(bowieLabels),
        };
        graph = new GraphVisualization('graphContainer');
    });

    afterEach(() => {
        graph?.simulation?.stop();
        vi.restoreAllMocks();
    });

    it('renders the graph through the real render path and completes expansion with no console error', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const done = new Promise(resolve => { graph.onExpandsComplete = resolve; });

        graph.setExploreData(bowieData);
        await done;

        expect(errorSpy).not.toHaveBeenCalled();
        expect(document.getElementById('shareToast').classList.contains('show')).toBe(false);
        // The render actually ran: labels were drawn for every node, nameless ones included.
        expect(nodeTexts(graph, 'text.node-label')).toEqual(
            expect.arrayContaining(['Unknown label', 'Parlophone', 'David Bowie'])
        );
    });

    it('shows a readable fallback in the node label and tooltip, and keeps the id in the tooltip', async () => {
        const done = new Promise(resolve => { graph.onExpandsComplete = resolve; });
        graph.setExploreData(bowieData);
        await done;

        const labels = nodeTexts(graph, 'text.node-label');
        const tooltips = nodeTexts(graph, 'title');
        const allText = [...labels, ...tooltips].join('\n');
        expect(allText).not.toMatch(/\bnull\b/);

        const nameless = graph.nodes.filter(n => n.unnamed);
        expect(nameless.map(n => n.nodeId).sort()).toEqual(['11358', '25487']);
        expect(nameless.every(n => n.name === 'Unknown label')).toBe(true);

        const tooltipForFirst = tooltips.find(t => t.startsWith('Unknown label [label]'));
        expect(tooltipForFirst).toContain('ID 11358');
        // A named label still gets the double-click hint and no id line.
        const named = tooltips.find(t => t.startsWith('Parlophone [label]'));
        expect(named).toContain('double-click to explore');
        expect(named).not.toContain('ID ');
    });

    it('ignores double-click on a nameless node instead of exploring by a null name', () => {
        const onNodeExpand = vi.fn();
        graph.onNodeExpand = onNodeExpand;
        const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };

        graph._onNodeDblClicked(event, { name: 'Unknown label', type: 'label', unnamed: true, nodeId: '11358' });

        expect(onNodeExpand).not.toHaveBeenCalled();
    });

    it('still clears the wait and shows an error when rendering throws', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(graph, '_drawGraph').mockImplementation(() => {
            throw new TypeError("Cannot read properties of null (reading 'length')");
        });
        const done = new Promise(resolve => { graph.onExpandsComplete = resolve; });

        graph.setExploreData(bowieData);
        // Resolves only if onExpandsComplete fires; before the fix this hung.
        await done;

        const toast = document.getElementById('shareToast');
        expect(toast.classList.contains('show')).toBe(true);
        expect(document.getElementById('shareToastMsg').textContent).toContain("Couldn't draw the graph");
        expect(errorSpy).toHaveBeenCalledWith('Graph render failed', expect.any(TypeError));
    });
});
