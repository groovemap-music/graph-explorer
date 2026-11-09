import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadScript } from './helpers.js';

const REAL = [
    { rank: 1, label_id: '1', label_name: 'Columbia', first_year: 1889, last_year: null, years_active: 137, total_releases: 351183, peak_decade: 1960, still_active: true, is_placeholder: false },
    { rank: 2, label_id: '2', label_name: 'Decca', first_year: 1929, last_year: 1999, years_active: 70, total_releases: 90000, peak_decade: 1950, still_active: false, is_placeholder: false },
];
const NOT_ON_LABEL = {
    rank: 51, label_id: '0', label_name: 'Not On Label', first_year: 1900, last_year: null,
    years_active: 126, total_releases: 3000000, peak_decade: 2010, still_active: true, is_placeholder: true,
};

function setupDOM() {
    document.body.textContent = '';
    const section = document.createElement('details');
    section.id = 'labelTimelineSection';
    section.open = true;
    const chart = document.createElement('div');
    chart.id = 'labelTimelineChart';
    const status = document.createElement('div');
    status.id = 'labelTimelineStatus';
    status.className = 'hidden';
    const trendsToggle = document.createElement('input');
    trendsToggle.type = 'checkbox';
    trendsToggle.id = 'trendsIncludePlaceholders';
    const showAll = document.createElement('button');
    showAll.id = 'labelTimelineShowAll';
    showAll.textContent = 'Show all';
    section.append(trendsToggle, showAll, status, chart);
    document.body.appendChild(section);

    for (const id of ['insightsPane', 'insightsLoading', 'insightsPlaceholder', 'insightsContent', 'insightsLabelLongevity']) {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
    }
    const insightsToggle = document.createElement('input');
    insightsToggle.type = 'checkbox';
    insightsToggle.id = 'insightsIncludePlaceholders';
    document.body.appendChild(insightsToggle);
}

function stubApi(items = (include) => (include ? [REAL[0], NOT_ON_LABEL, REAL[1]] : REAL)) {
    const getInsightsLabelLongevity = vi.fn(async (_limit, include) => ({ items: items(include) }));
    window.apiClient = { getInsightsLabelLongevity };
    return getInsightsLabelLongevity;
}

const lastTraces = () => window.Plotly.newPlot.mock.calls.at(-1)[1];
const lastLayout = () => window.Plotly.newPlot.mock.calls.at(-1)[2];
const buildModel = (items) => window.labelTimeline.constructor.buildModel(items, 2026);

describe('LabelTimeline', () => {
    beforeEach(() => {
        setupDOM();
        delete globalThis.window;
        globalThis.window = globalThis;
        globalThis.Plotly = { newPlot: vi.fn(), purge: vi.fn(), relayout: vi.fn(), restyle: vi.fn() };
        loadScript('chart-theme.js');
        loadScript('label-longevity-state.js');
        loadScript('insights.js');
        loadScript('label-timeline.js');
    });

    describe('buildModel', () => {
        it('keeps rank order and spans first_year..last_year inclusive', () => {
            const { rows } = buildModel(REAL);
            expect(rows.map((r) => r.tick)).toEqual(['1. Columbia', '2. Decca']);
            expect(rows[1].start).toBe(1929);
            expect(rows[1].span).toBe(1999 - 1929 + 1);
        });

        it('runs a still-active label to the current year and flags it open-ended', () => {
            const { rows } = buildModel(REAL);
            expect(rows[0].stillActive).toBe(true);
            expect(rows[0].span).toBe(2026 - 1889 + 1);
            expect(rows[1].stillActive).toBe(false);
        });

        it('marks the midpoint of the peak decade, or nothing without one', () => {
            const { rows } = buildModel([REAL[0], { ...REAL[1], peak_decade: null }]);
            expect(rows[0].peak).toBe(1965);
            expect(rows[1].peak).toBeNull();
        });

        it('mutes a placeholder and never shows its stored rank', () => {
            const { rows } = buildModel([NOT_ON_LABEL]);
            expect(rows[0].placeholder).toBe(true);
            expect(rows[0].tick).not.toContain('51');
            expect(rows[0].hover).toContain('Not On Label (placeholder)');
        });

        it('escapes a label name so Plotly cannot render it as markup', () => {
            const evil = { ...REAL[1], label_name: '<a href="javascript:alert(1)">x</a> & <b>' };
            const { rows } = buildModel([evil]);
            expect(rows[0].tick).not.toContain('<');
            expect(rows[0].hover).not.toMatch(/<a|<b>/);
            expect(rows[0].hover).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;');
            expect(rows[0].hover).toContain('&amp;');
            // The only markup left is our own line break.
            expect(rows[0].hover.match(/<[^>]+>/g)).toEqual(['<br>', '<br>']);
        });

        it('truncates a long tick label but keeps the full name in the hover text', () => {
            const { rows } = buildModel([{ ...REAL[0], label_name: 'A'.repeat(60) }]);
            expect(rows[0].tick.length).toBeLessThanOrEqual(24);
            expect(rows[0].tick.endsWith('…')).toBe(true);
            expect(rows[0].hover).toContain('A'.repeat(60));
        });
    });

    describe('load', () => {
        it('asks for the top 20 without placeholders and draws floating bars', async () => {
            const api = stubApi();
            await window.labelTimeline.load();
            expect(api).toHaveBeenCalledWith(20, false);
            const [bars, active, peaks] = lastTraces();
            expect(bars.orientation).toBe('h');
            expect(bars.base).toEqual([1889, 1929]);
            expect(bars.x[1]).toBe(1999 - 1929 + 1);
            expect(active.y).toEqual([0]);
            expect(peaks.x).toEqual([1965, 1955]);
            expect(lastLayout().yaxis.autorange).toBe('reversed');
        });

        it('"Show all" asks for the stored maximum and toggles back', async () => {
            const api = stubApi();
            await window.labelTimeline.setShowAll(true);
            expect(api).toHaveBeenLastCalledWith(50, false);
            expect(document.getElementById('labelTimelineShowAll').textContent).toBe('Show top 20');
            await window.labelTimeline.setShowAll(false);
            expect(api).toHaveBeenLastCalledWith(20, false);
        });

        it('shows the empty state and draws no chart when there are no labels', async () => {
            stubApi(() => []);
            await window.labelTimeline.load();
            const status = document.getElementById('labelTimelineStatus');
            expect(status.textContent).toBe('No label data available yet');
            expect(status.classList.contains('hidden')).toBe(false);
            expect(window.Plotly.newPlot).not.toHaveBeenCalled();
        });

        it.each([
            ['a null response', () => ({ getInsightsLabelLongevity: vi.fn().mockResolvedValue(null) })],
            ['a rejected request', () => ({ getInsightsLabelLongevity: vi.fn().mockRejectedValue(new Error('down')) })],
        ])('shows an error state for %s', async (_name, makeApi) => {
            window.apiClient = makeApi();
            await window.labelTimeline.load();
            expect(document.getElementById('labelTimelineStatus').textContent).toContain('Could not load');
            expect(window.Plotly.newPlot).not.toHaveBeenCalled();
        });

        it('shows a loading message while the request is in flight', async () => {
            let release;
            window.apiClient = { getInsightsLabelLongevity: vi.fn(() => new Promise((r) => { release = r; })) };
            const pending = window.labelTimeline.load();
            expect(document.getElementById('labelTimelineStatus').textContent).toContain('Loading');
            release({ items: REAL });
            await pending;
            expect(document.getElementById('labelTimelineStatus').classList.contains('hidden')).toBe(true);
        });

        it('ignores a slow response for an earlier choice', async () => {
            let release;
            const slow = new Promise((r) => { release = r; });
            window.apiClient = {
                getInsightsLabelLongevity: vi.fn((_limit, include) => (include ? slow : Promise.resolve({ items: REAL }))),
            };
            await window.labelTimeline.activate();
            const stale = window.labelLongevityState.setIncludePlaceholders(true);
            await window.labelLongevityState.setIncludePlaceholders(false);
            release({ items: [REAL[0], NOT_ON_LABEL, REAL[1]] });
            await stale;
            expect(lastTraces()[0].y).toEqual([0, 1]);
        });

        it('does not fetch while the section is collapsed', async () => {
            const api = stubApi();
            document.getElementById('labelTimelineSection').open = false;
            await window.labelTimeline.load();
            expect(api).not.toHaveBeenCalled();
        });
    });

    describe('shared include-placeholders state', () => {
        it('the timeline waits for the pane to be shown before fetching', async () => {
            const api = stubApi();
            await window.labelLongevityState.setIncludePlaceholders(true);
            // Only the Insights table follows the change.
            expect(api).toHaveBeenCalledTimes(1);
            expect(window.Plotly.newPlot).not.toHaveBeenCalledWith(
                document.getElementById('labelTimelineChart'), expect.anything(), expect.anything(), expect.anything());
        });

        it('the Trends checkbox updates the Insights checkbox, both views and the query', async () => {
            const api = stubApi();
            await window.labelTimeline.activate();
            const trends = document.getElementById('trendsIncludePlaceholders');
            const insights = document.getElementById('insightsIncludePlaceholders');
            trends.checked = true;
            trends.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(lastTraces()[0].y).toEqual([0, 1, 2]));

            expect(insights.checked).toBe(true);
            expect(api).toHaveBeenCalledWith(20, true);
            await vi.waitFor(() => expect(document.querySelectorAll('#insightsLabelLongevity tbody tr')).toHaveLength(3));
            expect(lastLayout().yaxis.ticktext.join()).toContain('Not On Label (placehold');
        });

        it('the Insights checkbox updates the Trends checkbox and the timeline', async () => {
            stubApi();
            await window.labelTimeline.activate();
            const trends = document.getElementById('trendsIncludePlaceholders');
            const insights = document.getElementById('insightsIncludePlaceholders');
            insights.checked = true;
            insights.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(lastTraces()[0].y).toEqual([0, 1, 2]));
            expect(trends.checked).toBe(true);

            insights.checked = false;
            insights.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(lastTraces()[0].y).toEqual([0, 1]));
            expect(trends.checked).toBe(false);
            expect(lastLayout().yaxis.ticktext.join()).not.toContain('Not On Label');
        });
    });
});
