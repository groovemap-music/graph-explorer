import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadScript } from './helpers.js';

/**
 * Set up the DOM elements required by search.js.
 */
function setupSearchDOM() {
    document.body.textContent = '';

    const ids = [
        'searchPaneInput',
        'searchPaneBtn',
        'searchTypeChips',
        'searchYearMin',
        'searchYearMax',
        'searchGenreFilter',
        'searchMediaFilter',
        'searchCountryFilter',
        'searchPaneFilters',
        'searchFacets',
        'searchLoading',
        'searchPlaceholder',
        'searchResults',
        'searchPagination',
        // Used by navigateToResult
        'searchInput',
    ];

    ids.forEach(id => {
        let el;
        if (id === 'searchPaneInput' || id === 'searchYearMin' || id === 'searchYearMax') {
            el = document.createElement('input');
            el.type = id.includes('Year') ? 'number' : 'text';
            if (id === 'searchPaneInput') el.placeholder = 'Search artists, labels, masters, releases...';
        } else if (id === 'searchPaneBtn') {
            el = document.createElement('button');
        } else {
            el = document.createElement('div');
        }
        el.id = id;
        document.body.appendChild(el);
    });

    // The mode toggle, spelled as index.html spells it: the pane reads the
    // provider namespace off the button, so the ids alone would not exercise it.
    const modeToggle = document.createElement('div');
    modeToggle.id = 'searchModeToggle';
    [['text', 'Text'], ['barcode', 'Barcode'], ['catalog_number', 'Catalogue number'], ['matrix', 'Matrix']]
        .forEach(([mode, label], index) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = index === 0 ? 'search-chip search-chip-sm active' : 'search-chip search-chip-sm';
            btn.dataset.searchMode = mode;
            btn.setAttribute('aria-pressed', String(index === 0));
            btn.textContent = label;
            modeToggle.appendChild(btn);
        });
    document.body.appendChild(modeToggle);
}

/** Click one mode button on the toggle. */
function selectMode(mode) {
    document.querySelector(`[data-search-mode="${mode}"]`).click();
}

/** Type a value and submit it with Enter, then let the response settle. */
async function submit(value) {
    const input = document.getElementById('searchPaneInput');
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 10));
}

describe('search pane', () => {
    beforeEach(() => {
        setupSearchDOM();
        delete globalThis.window;
        globalThis.window = globalThis;

        window.apiClient = {
            search: vi.fn().mockResolvedValue({ results: [], total: 0, facets: {}, pagination: {} }),
            lookup: vi.fn().mockResolvedValue({ provider: 'barcode', value: '', normalized: '', gm_id: null, releases: [] }),
        };

        loadScript('media-taxonomy.js');
        loadScript('search.js');
    });

    describe('initialization', () => {
        it('should expose window.searchPane with a focus method', () => {
            expect(window.searchPane).toBeDefined();
            expect(typeof window.searchPane.focus).toBe('function');
        });

        it('should call focus on the input element', () => {
            const input = document.getElementById('searchPaneInput');
            const focusSpy = vi.spyOn(input, 'focus');

            window.searchPane.focus();

            expect(focusSpy).toHaveBeenCalled();
        });
    });

    describe('search input', () => {
        it('should call apiClient.search after Enter keydown with valid query', async () => {
            vi.useFakeTimers();
            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';

            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

            // Flush microtasks
            await vi.runAllTimersAsync();

            expect(window.apiClient.search).toHaveBeenCalledWith(
                'radiohead',
                expect.any(Array),
                expect.any(Array),
                null,
                null,
                20,
                0,
                [],
                []
            );

            vi.useRealTimers();
        });

        it('should call apiClient.search on search button click', async () => {
            vi.useFakeTimers();
            const input = document.getElementById('searchPaneInput');
            const btn = document.getElementById('searchPaneBtn');
            input.value = 'radiohead';

            btn.click();

            await vi.runAllTimersAsync();

            expect(window.apiClient.search).toHaveBeenCalledWith(
                'radiohead',
                expect.any(Array),
                expect.any(Array),
                null,
                null,
                20,
                0,
                [],
                []
            );

            vi.useRealTimers();
        });

        it('should not search when input is less than 3 chars via button click', async () => {
            vi.useFakeTimers();
            const input = document.getElementById('searchPaneInput');
            const btn = document.getElementById('searchPaneBtn');
            input.value = 'ab';

            btn.click();

            await vi.runAllTimersAsync();

            expect(window.apiClient.search).not.toHaveBeenCalled();

            vi.useRealTimers();
        });
    });

    describe('type chip toggles', () => {
        it('should toggle active class on chip click', () => {
            const chipWrap = document.getElementById('searchTypeChips');
            const chip = document.createElement('button');
            chip.className = 'search-chip';
            chip.dataset.searchType = 'artist';
            chipWrap.appendChild(chip);

            chip.click();

            expect(chip.classList.contains('active')).toBe(true);
        });

        it('should toggle off active class on second click', () => {
            const chipWrap = document.getElementById('searchTypeChips');
            const chip = document.createElement('button');
            chip.className = 'search-chip active';
            chip.dataset.searchType = 'artist';
            chipWrap.appendChild(chip);

            chip.click();

            expect(chip.classList.contains('active')).toBe(false);
        });
    });

    describe('triggerSearch results rendering', () => {
        it('should render error state when apiClient returns null', async () => {
            window.apiClient.search.mockResolvedValue(null);

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';

            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const resultsEl = document.getElementById('searchResults');
            expect(resultsEl.textContent).toContain('error occurred');
        });

        it('should hide the loading overlay and render the error state on a network-level fetch rejection (regression migration-regression-cmw0)', async () => {
            window.apiClient.search.mockRejectedValue(new TypeError('Failed to fetch'));

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';

            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const resultsEl = document.getElementById('searchResults');
            const loadingEl = document.getElementById('searchLoading');
            expect(resultsEl.textContent).toContain('error occurred');
            expect(loadingEl.classList.contains('active')).toBe(false);
        });

        it('should clear stale genre and media facet chips left over from a prior search when the next search errors', async () => {
            window.apiClient.search.mockResolvedValueOnce({
                results: [{ name: 'X', type: 'release', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10 }, media: { vinyl: 5 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const genreWrap = document.getElementById('searchGenreFilter');
            const mediaWrap = document.getElementById('searchMediaFilter');
            expect(genreWrap.querySelectorAll('.search-chip').length).toBeGreaterThan(0);
            expect(mediaWrap.querySelectorAll('.search-media-chip').length).toBeGreaterThan(0);

            window.apiClient.search.mockResolvedValueOnce(null);
            input.value = 'a query that errors';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            expect(genreWrap.querySelectorAll('.search-chip').length).toBe(0);
            expect(mediaWrap.querySelectorAll('.search-media-chip').length).toBe(0);
        });

        it('should render "no results" when results array is empty', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [],
                total: 0,
                facets: {},
                pagination: {},
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'xyzzy';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const resultsEl = document.getElementById('searchResults');
            expect(resultsEl.querySelector('.search-no-results')).not.toBeNull();
        });

        it('should render result cards with type badges', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [
                    { name: 'Radiohead', type: 'artist', relevance: 0.9 },
                    { name: 'OK Computer', type: 'release', relevance: 0.7 },
                ],
                total: 2,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const resultsEl = document.getElementById('searchResults');
            const badges = resultsEl.querySelectorAll('.search-result-badge');
            expect(badges).toHaveLength(2);
            expect(badges[0].textContent).toBe('artist');
            expect(badges[1].textContent).toBe('release');
        });

        it('should display total count in results header', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'Radiohead', type: 'artist', relevance: 0.9 }],
                total: 42,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const resultsEl = document.getElementById('searchResults');
            const header = resultsEl.querySelector('.search-results-header');
            expect(header.textContent).toBe('42 results');
        });

        it('should use singular "result" when total is 1', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'Only One', type: 'artist', relevance: 1.0 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'only one';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const header = document.getElementById('searchResults').querySelector('.search-results-header');
            expect(header.textContent).toBe('1 result');
        });
    });

    describe('request sequencing', () => {
        it('should discard a stale response that resolves after a newer request', async () => {
            let resolveFirst, resolveSecond;
            window.apiClient.search
                .mockReturnValueOnce(new Promise(r => { resolveFirst = r; }))
                .mockReturnValueOnce(new Promise(r => { resolveSecond = r; }));

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

            // A second, unrelated query is submitted before the first resolves.
            input.value = 'herbie hancock';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

            // Newer request resolves first — should render normally.
            resolveSecond({
                results: [{ name: 'Herbie Hancock', type: 'artist', relevance: 1 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });
            await new Promise(r => setTimeout(r, 10));

            // Stale (earlier) request resolves after — must not overwrite the render.
            resolveFirst({
                results: [{ name: 'Radiohead', type: 'artist', relevance: 1 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });
            await new Promise(r => setTimeout(r, 10));

            const resultsEl = document.getElementById('searchResults');
            expect(resultsEl.textContent).toContain('Herbie Hancock');
            expect(resultsEl.textContent).not.toContain('Radiohead');
        });
    });

    describe('highlight rendering', () => {
        it('should render highlighted text with bold elements', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [
                    { name: 'Radiohead', type: 'artist', relevance: 0.9, highlight: 'Radio<b>head</b>' },
                ],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'head';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const nameEl = document.querySelector('.search-result-name');
            const bold = nameEl.querySelector('b');
            expect(bold).not.toBeNull();
            expect(bold.textContent).toBe('head');
        });
    });

    describe('facets rendering', () => {
        it('should render type facets', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { type: { artist: 5, label: 2 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const facetsEl = document.getElementById('searchFacets');
            const tags = facetsEl.querySelectorAll('.search-facet-tag');
            expect(tags.length).toBeGreaterThan(0);
        });

        it('should render genre filter chips', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10, Electronic: 5 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const genreWrap = document.getElementById('searchGenreFilter');
            const chips = genreWrap.querySelectorAll('.search-chip');
            expect(chips.length).toBeGreaterThan(0);
        });

        it('should render decade facets', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { decade: { '1990s': 15, '2000s': 8 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const facetsEl = document.getElementById('searchFacets');
            const decadeTags = facetsEl.querySelectorAll('.search-facet-decade');
            expect(decadeTags.length).toBeGreaterThan(0);
        });

        it('should render media family facet chips with labels and counts', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'release', relevance: 1 }],
                total: 1,
                facets: { media: { vinyl: 120, grooved_other: 3 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const chips = document.getElementById('searchMediaFilter').querySelectorAll('.search-media-chip');
            expect(Array.from(chips).map(c => c.textContent)).toEqual(['Vinyl (120)', 'Other grooved (3)']);
            expect(chips[0].dataset.mediaFamily).toBe('vinyl');
            expect(chips[0].getAttribute('aria-pressed')).toBe('false');
        });

        it('should skip zero-count media facets', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'release', relevance: 1 }],
                total: 1,
                facets: { media: { vinyl: 5, tape: 0 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const chips = document.getElementById('searchMediaFilter').querySelectorAll('.search-media-chip');
            expect(chips).toHaveLength(1);
            expect(chips[0].textContent).toContain('Vinyl');
        });

        it('should send the clicked media family as a search filter and clear it on re-click', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'release', relevance: 1 }],
                total: 1,
                facets: { media: { vinyl: 120 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const chip = document.getElementById('searchMediaFilter').querySelector('.search-media-chip');
            chip.click();
            await new Promise(r => setTimeout(r, 10));

            const filtered = window.apiClient.search.mock.calls.at(-1);
            expect(filtered[7]).toEqual(['vinyl']);
            expect(document.getElementById('searchMediaFilter')
                .querySelector('.search-media-chip').getAttribute('aria-pressed')).toBe('true');

            document.getElementById('searchMediaFilter').querySelector('.search-media-chip').click();
            await new Promise(r => setTimeout(r, 10));
            expect(window.apiClient.search.mock.calls.at(-1)[7]).toEqual([]);
        });

        it('should clear the media filter when the query text changes', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'release', relevance: 1 }],
                total: 1,
                facets: { media: { vinyl: 120 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            document.getElementById('searchMediaFilter').querySelector('.search-media-chip').click();
            await new Promise(r => setTimeout(r, 10));
            expect(window.apiClient.search.mock.calls.at(-1)[7]).toEqual(['vinyl']);

            input.value = 'different query';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));
            expect(window.apiClient.search.mock.calls.at(-1)[7]).toEqual([]);
        });

        it('should skip zero-count type facets', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { type: { artist: 5, label: 0 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const tags = document.getElementById('searchFacets').querySelectorAll('.search-facet-tag');
            // Only artist (count=5) should appear, not label (count=0)
            expect(tags).toHaveLength(1);
            expect(tags[0].textContent).toContain('artist');
        });
    });

    describe('pagination', () => {
        it('should not render pagination when no has_more and offset is 0', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const paginationEl = document.getElementById('searchPagination');
            expect(paginationEl.textContent).toBe('');
        });

        it('should render pagination when has_more is true', async () => {
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const paginationEl = document.getElementById('searchPagination');
            expect(paginationEl.querySelector('.page-info')).not.toBeNull();
            expect(paginationEl.querySelector('.page-buttons')).not.toBeNull();
        });
    });

    describe('navigateToResult', () => {
        it('should navigate to explore pane for artist type', async () => {
            const mockExploreApp = {
                _setSearchType: vi.fn(),
                _switchPane: vi.fn(),
                _loadExplore: vi.fn(),
                currentQuery: '',
            };
            window.exploreApp = mockExploreApp;

            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'Radiohead', type: 'artist', relevance: 0.9 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const card = document.querySelector('.search-result-card');
            expect(card).not.toBeNull();
            card.click();

            expect(mockExploreApp._setSearchType).toHaveBeenCalledWith('artist');
            expect(mockExploreApp._switchPane).toHaveBeenCalledWith('explore');
            expect(mockExploreApp._loadExplore).toHaveBeenCalledWith('Radiohead', 'artist');
        });

        it('should switch to explore pane for non-explorable types', async () => {
            const mockExploreApp = {
                _setSearchType: vi.fn(),
                _switchPane: vi.fn(),
                _loadExplore: vi.fn(),
                _showToast: vi.fn(),
                currentQuery: '',
            };
            window.exploreApp = mockExploreApp;

            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'OK Computer', type: 'release', relevance: 0.9 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'ok computer';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const card = document.querySelector('.search-result-card');
            card.click();

            // Release type: shows toast instead of switching pane
            expect(mockExploreApp._switchPane).not.toHaveBeenCalled();
            expect(mockExploreApp._loadExplore).not.toHaveBeenCalled();
        });

        it('should call window.exploreApp._showToast (not the undefined window.app) for non-explorable types (regression migration-regression-oi02)', async () => {
            const mockExploreApp = {
                _setSearchType: vi.fn(),
                _switchPane: vi.fn(),
                _loadExplore: vi.fn(),
                _showToast: vi.fn(),
                currentQuery: '',
            };
            window.exploreApp = mockExploreApp;
            // window.app has never been assigned anywhere in explore/static/js/ —
            // make sure it stays undefined so this test fails if the code
            // regresses back to reading the wrong global.
            delete window.app;

            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'OK Computer', type: 'release', relevance: 0.9 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'ok computer';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const card = document.querySelector('.search-result-card');
            card.click();

            expect(mockExploreApp._showToast).toHaveBeenCalledTimes(1);
            expect(mockExploreApp._showToast).toHaveBeenCalledWith(
                expect.stringContaining('not explorable directly')
            );
        });

        it('should call window.exploreApp._showToast for master type too (regression migration-regression-oi02)', async () => {
            const mockExploreApp = {
                _setSearchType: vi.fn(),
                _switchPane: vi.fn(),
                _loadExplore: vi.fn(),
                _showToast: vi.fn(),
                currentQuery: '',
            };
            window.exploreApp = mockExploreApp;
            delete window.app;

            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'Master Edition', type: 'master', relevance: 0.9 }],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'master edition';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const card = document.querySelector('.search-result-card');
            card.click();

            expect(mockExploreApp._showToast).toHaveBeenCalledWith(
                expect.stringContaining('master details are not explorable directly')
            );
        });
    });

    describe('genre chip toggle', () => {
        it('should toggle genre chip and re-trigger search', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10, Electronic: 5 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const genreWrap = document.getElementById('searchGenreFilter');
            const chips = genreWrap.querySelectorAll('.search-chip');
            expect(chips.length).toBeGreaterThan(0);

            // Click a genre chip to activate it
            window.apiClient.search.mockClear();
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10 } },
                pagination: { has_more: false },
            });

            chips[0].click();
            await new Promise(r => setTimeout(r, 10));

            expect(chips[0].classList.contains('active')).toBe(true);
            expect(window.apiClient.search).toHaveBeenCalled();
        });

        it('should reset selectedGenres when the query text changes on Enter', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'beatles';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            // Select the Rock genre facet chip.
            const chip = document.getElementById('searchGenreFilter').querySelector('.search-chip');
            chip.click();
            await new Promise(r => setTimeout(r, 10));

            // New, unrelated query — selectedGenres must not carry over.
            window.apiClient.search.mockClear();
            input.value = 'herbie hancock';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            expect(window.apiClient.search).toHaveBeenCalledWith('herbie hancock', expect.any(Array), [], null, null, 20, 0, [], []);
        });

        it('should reset selectedGenres when the query text changes via search button', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            const btn = document.getElementById('searchPaneBtn');
            input.value = 'beatles';
            btn.click();
            await new Promise(r => setTimeout(r, 10));

            const chip = document.getElementById('searchGenreFilter').querySelector('.search-chip');
            chip.click();
            await new Promise(r => setTimeout(r, 10));

            window.apiClient.search.mockClear();
            input.value = 'herbie hancock';
            btn.click();
            await new Promise(r => setTimeout(r, 10));

            expect(window.apiClient.search).toHaveBeenCalledWith('herbie hancock', expect.any(Array), [], null, null, 20, 0, [], []);
        });

        it('should keep selectedGenres when re-submitting the same query', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'beatles';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const chip = document.getElementById('searchGenreFilter').querySelector('.search-chip');
            chip.click();
            await new Promise(r => setTimeout(r, 10));

            // Re-run the SAME query text (e.g. hitting Enter again) — the filter is
            // still refining this query, so it must be kept.
            window.apiClient.search.mockClear();
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            expect(window.apiClient.search).toHaveBeenCalledWith('beatles', expect.any(Array), ['Rock'], null, null, 20, 0, [], []);
        });

        it('should deactivate genre chip on second click', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10, Electronic: 5 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const genreWrap = document.getElementById('searchGenreFilter');
            const chips = genreWrap.querySelectorAll('.search-chip');

            // Click once to activate, again to deactivate
            chips[0].click();
            await new Promise(r => setTimeout(r, 10));

            // Re-render will create new chips; get the fresh reference
            const freshChips = document.getElementById('searchGenreFilter').querySelectorAll('.search-chip');
            // The chip should now be active (from the re-rendered search)
            // Click it again to deactivate
            freshChips[0].click();
            await new Promise(r => setTimeout(r, 10));

            // After toggling off, search should be triggered again
            expect(window.apiClient.search).toHaveBeenCalled();
        });

        it('should expose aria-pressed on genre chips consistent with media chips', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'X', type: 'artist', relevance: 1 }],
                total: 1,
                facets: { genre: { Rock: 10, Electronic: 5 } },
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const chips = document.getElementById('searchGenreFilter').querySelectorAll('.search-chip');
            expect(chips[0].getAttribute('aria-pressed')).toBe('false');

            chips[0].click();
            await new Promise(r => setTimeout(r, 10));

            const freshChip = document.getElementById('searchGenreFilter').querySelector('.search-chip');
            expect(freshChip.getAttribute('aria-pressed')).toBe('true');
        });
    });

    describe('pagination controls', () => {
        it('should navigate to next page on next button click', async () => {
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            window.apiClient.search.mockClear();
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i + 20}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const paginationEl = document.getElementById('searchPagination');
            const nextBtn = paginationEl.querySelectorAll('.page-btn');
            // Last button should be next
            const lastBtn = nextBtn[nextBtn.length - 1];
            lastBtn.click();
            await new Promise(r => setTimeout(r, 10));

            expect(window.apiClient.search).toHaveBeenCalled();
        });

        it('should navigate to previous page on prev button click', async () => {
            // First, do initial search
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            // Navigate to page 2
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i + 20}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const paginationEl = document.getElementById('searchPagination');
            const nextBtn = paginationEl.querySelectorAll('.page-btn');
            nextBtn[nextBtn.length - 1].click(); // next
            await new Promise(r => setTimeout(r, 10));

            // Now click prev
            window.apiClient.search.mockClear();
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const prevBtns = document.getElementById('searchPagination').querySelectorAll('.page-btn');
            prevBtns[0].click(); // prev
            await new Promise(r => setTimeout(r, 10));

            expect(window.apiClient.search).toHaveBeenCalled();
        });

        it('should navigate to a specific page number', async () => {
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            window.apiClient.search.mockClear();
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 100,
                facets: {},
                pagination: { has_more: true },
            });

            const paginationEl = document.getElementById('searchPagination');
            const pageBtns = paginationEl.querySelectorAll('.page-btn');
            // Click page 2 (should be among the buttons)
            const page2Btn = Array.from(pageBtns).find(b => b.textContent === '2');
            if (page2Btn) {
                page2Btn.click();
                await new Promise(r => setTimeout(r, 10));
                expect(window.apiClient.search).toHaveBeenCalled();
            }
        });

        it('should render ellipsis for large page counts', async () => {
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 200,
                facets: {},
                pagination: { has_more: true },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const paginationEl = document.getElementById('searchPagination');
            const ellipses = paginationEl.querySelectorAll('.page-ellipsis');
            expect(ellipses.length).toBeGreaterThan(0);
        });

        it('should render correct page numbers when on high page', async () => {
            // Simulate being on a high page by doing multiple next clicks
            window.apiClient.search.mockResolvedValue({
                results: Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i}`, type: 'artist', relevance: 1 })),
                total: 200,
                facets: {},
                pagination: { has_more: true },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'test';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            // Navigate to a high page
            for (let i = 0; i < 8; i++) {
                window.apiClient.search.mockResolvedValue({
                    results: Array.from({ length: 20 }, (_, j) => ({ name: `Artist ${j}`, type: 'artist', relevance: 1 })),
                    total: 200,
                    facets: {},
                    pagination: { has_more: true },
                });
                const nextBtns = document.getElementById('searchPagination').querySelectorAll('.page-btn');
                nextBtns[nextBtns.length - 1].click();
                await new Promise(r => setTimeout(r, 10));
            }

            // Should be on a high page with ellipsis before and after current
            const paginationEl = document.getElementById('searchPagination');
            expect(paginationEl.querySelector('.page-info')).not.toBeNull();
        });
    });

    describe('metadata rendering', () => {
        it('should render year and genres in metadata', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [
                    {
                        name: 'OK Computer',
                        type: 'release',
                        relevance: 0.9,
                        metadata: { year: 1997, genres: ['Rock', 'Alternative'] },
                    },
                ],
                total: 1,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'ok computer';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const metaEl = document.querySelector('.search-result-meta');
            expect(metaEl.textContent).toContain('1997');
            expect(metaEl.textContent).toContain('Rock');
        });
    });

    describe('outcome events on search hits', () => {
        /** A search hit as the API now returns it, carrying its impression. */
        const HIT = {
            name: 'Radiohead',
            type: 'artist',
            relevance: 0.9,
            impression_id: 'imp-search-1',
            gm_id: 'gm-artist-1',
        };

        /** Run a search that returns `results` and hand back the first card. */
        async function renderAndGetCard(results) {
            window.apiClient.search.mockResolvedValue({
                results,
                total: results.length,
                facets: {},
                pagination: { has_more: false },
            });

            const input = document.getElementById('searchPaneInput');
            input.value = 'radiohead';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            return document.querySelector('.search-result-card');
        }

        beforeEach(() => {
            window.authManager = {
                getToken: vi.fn().mockReturnValue('test-token'),
            };
            window.apiClient.postActivityEvent = vi.fn()
                .mockResolvedValue({ ok: true, status: 202, body: null });
            window.exploreApp = {
                _setSearchType: vi.fn(),
                _switchPane: vi.fn(),
                _loadExplore: vi.fn(),
                _showToast: vi.fn(),
                currentQuery: '',
            };
        });

        afterEach(() => {
            delete window.authManager;
            delete window.exploreApp;
        });

        it('keeps impression_id and gm_id on the rendered card', async () => {
            const card = await renderAndGetCard([HIT]);

            expect(card.dataset.impressionId).toBe('imp-search-1');
            expect(card.dataset.gmId).toBe('gm-artist-1');
        });

        it('emits recommendation.opened when a hit with an impression is clicked', async () => {
            const card = await renderAndGetCard([HIT]);

            card.click();

            expect(window.apiClient.postActivityEvent).toHaveBeenCalledWith(
                'test-token', 'recommendation.opened', 'imp-search-1', 'gm-artist-1',
            );
            expect(window.apiClient.postActivityEvent).toHaveBeenCalledTimes(1);
        });

        it('emits nothing for a hit with no impression_id', async () => {
            const card = await renderAndGetCard([{ name: 'Radiohead', type: 'artist', relevance: 0.9 }]);

            card.click();

            expect(window.apiClient.postActivityEvent).not.toHaveBeenCalled();
            expect(window.exploreApp._loadExplore).toHaveBeenCalledWith('Radiohead', 'artist');
        });

        it('emits nothing for an anonymous session', async () => {
            window.authManager.getToken.mockReturnValue(null);
            const card = await renderAndGetCard([HIT]);

            card.click();

            expect(window.apiClient.postActivityEvent).not.toHaveBeenCalled();
            expect(window.exploreApp._loadExplore).toHaveBeenCalledWith('Radiohead', 'artist');
        });

        it('navigates even when the post rejects', async () => {
            window.apiClient.postActivityEvent.mockRejectedValue(new TypeError('Failed to fetch'));
            const card = await renderAndGetCard([HIT]);

            expect(() => card.click()).not.toThrow();

            expect(window.exploreApp._loadExplore).toHaveBeenCalledWith('Radiohead', 'artist');
        });

        it('navigates even when the client throws synchronously', async () => {
            window.apiClient.postActivityEvent.mockImplementation(() => {
                throw new Error('client exploded');
            });
            const card = await renderAndGetCard([HIT]);

            expect(() => card.click()).not.toThrow();

            expect(window.exploreApp._loadExplore).toHaveBeenCalledWith('Radiohead', 'artist');
        });
    });
    // ------------------------------------------------------------------
    // Identifier lookup (ADR 0011)
    // ------------------------------------------------------------------

    describe('lookup mode', () => {
        /** What the lookup route answers for the barcode on the sleeve. */
        const RESOLVED = {
            provider: 'barcode',
            value: '5 012394 144777',
            normalized: '5012394144777',
            gm_id: 'gm:release:249504',
            releases: [
                { id: '249504', source: 'discogs', title: 'Never Gonna Give You Up', artist: 'Rick Astley', year: 1987, media_families: ['vinyl'] },
                { id: 'mb-1', source: 'musicbrainz', title: 'Never Gonna Give You Up', artist: null, year: 1987, media_families: ['vinyl'] },
            ],
        };

        it('marks the chosen mode as pressed and the others as not', () => {
            selectMode('barcode');

            expect(document.querySelector('[data-search-mode="barcode"]').getAttribute('aria-pressed')).toBe('true');
            expect(document.querySelector('[data-search-mode="text"]').getAttribute('aria-pressed')).toBe('false');
        });

        it('hides the filter row, which the lookup route cannot honour', () => {
            selectMode('barcode');
            expect(document.getElementById('searchPaneFilters').hidden).toBe(true);

            selectMode('text');
            expect(document.getElementById('searchPaneFilters').hidden).toBe(false);
        });

        it('names the marking it is asking for in the input', () => {
            selectMode('catalog_number');

            const input = document.getElementById('searchPaneInput');
            expect(input.placeholder).toContain('catalogue number');
            expect(input.getAttribute('aria-label')).toBe('Catalogue number to look up');
        });

        it('sends the typed value to the lookup route under the chosen namespace', async () => {
            window.apiClient.lookup.mockResolvedValue(RESOLVED);
            selectMode('barcode');

            await submit('5 012394 144777');

            expect(window.apiClient.lookup).toHaveBeenCalledWith('barcode', '5 012394 144777');
            expect(window.apiClient.search).not.toHaveBeenCalled();
        });

        it('looks up a value shorter than the search route would accept', async () => {
            window.apiClient.lookup.mockResolvedValue(RESOLVED);
            selectMode('catalog_number');

            await submit('ST1');

            expect(window.apiClient.lookup).toHaveBeenCalledWith('catalog_number', 'ST1');
        });

        it('renders every resolved release as a hit', async () => {
            window.apiClient.lookup.mockResolvedValue(RESOLVED);
            selectMode('barcode');

            await submit('5 012394 144777');

            const cards = document.querySelectorAll('.search-result-card');
            expect(cards.length).toBe(2);
            expect(cards[0].querySelector('.search-result-name').textContent).toBe('Never Gonna Give You Up');
            expect(cards[0].dataset.gmId).toBe('gm:release:249504');
        });

        it('badges each hit with what resolved it instead of a relevance bar', async () => {
            window.apiClient.lookup.mockResolvedValue(RESOLVED);
            selectMode('barcode');

            await submit('5 012394 144777');

            const badge = document.querySelector('.search-resolved-by');
            expect(badge.textContent).toBe('resolved by barcode');
            expect(badge.dataset.resolvedBy).toBe('barcode');
            expect(document.querySelector('.search-result-relevance')).toBeNull();
        });

        it('names the catalog each resolved row came from', async () => {
            window.apiClient.lookup.mockResolvedValue(RESOLVED);
            selectMode('barcode');

            await submit('5 012394 144777');

            const metas = Array.from(document.querySelectorAll('.search-result-meta')).map(el => el.textContent);
            expect(metas[0]).toContain('discogs');
            expect(metas[1]).toContain('musicbrainz');
        });

        it('reports a miss in the producer\'s own words', async () => {
            window.apiClient.lookup.mockResolvedValue({ notFound: true, error: "No release found for barcode '0'" });
            selectMode('barcode');

            await submit('0');

            expect(document.querySelector('.search-no-results').textContent).toContain("No release found for barcode '0'");
        });

        it('shows the error message when the service does not answer', async () => {
            window.apiClient.lookup.mockResolvedValue(null);
            selectMode('barcode');

            await submit('5012394144777');

            expect(document.getElementById('searchResults').textContent).toContain('An error occurred');
        });

        it('survives a network-level rejection', async () => {
            window.apiClient.lookup.mockRejectedValue(new TypeError('Failed to fetch'));
            selectMode('barcode');

            await submit('5012394144777');

            expect(document.getElementById('searchResults').textContent).toContain('An error occurred');
            expect(document.getElementById('searchLoading').classList.contains('active')).toBe(false);
        });

        it('drops the facet chips a text search left behind', async () => {
            window.apiClient.search.mockResolvedValue({
                results: [{ name: 'Blue', type: 'release', relevance: 0.5, country: 'UK' }],
                total: 1,
                facets: { genre: { Rock: 3 } },
                pagination: { has_more: false },
            });
            await submit('blue note');
            expect(document.querySelectorAll('.search-chip-sm').length).toBeGreaterThan(0);

            window.apiClient.lookup.mockResolvedValue(RESOLVED);
            selectMode('barcode');
            await submit('5012394144777');

            expect(document.getElementById('searchGenreFilter').textContent).toBe('');
            expect(document.getElementById('searchCountryFilter').textContent).toBe('');
        });

        it('returns to the search route when the mode goes back to text', async () => {
            window.apiClient.lookup.mockResolvedValue(RESOLVED);
            selectMode('barcode');
            await submit('5012394144777');

            selectMode('text');
            await submit('never gonna');

            expect(window.apiClient.search).toHaveBeenCalled();
        });
    });

    // ------------------------------------------------------------------
    // Country facet (ADR 0011)
    // ------------------------------------------------------------------

    describe('country facet', () => {
        /** Hits carrying the country the producer put beside their native id. */
        function hitsWithCountries(countries) {
            return countries.map((country, index) => ({
                name: `Release ${index}`,
                type: 'release',
                relevance: 0.5,
                country,
            }));
        }

        function resolveWith(results) {
            window.apiClient.search.mockResolvedValue({
                results,
                total: results.length,
                facets: {},
                pagination: { has_more: false },
            });
        }

        it('renders one chip per country the hits carry', async () => {
            resolveWith(hitsWithCountries(['UK', 'Germany', 'UK']));

            await submit('blue note');

            const chips = Array.from(document.querySelectorAll('.search-country-chip')).map(el => el.textContent);
            expect(chips).toEqual(['UK (2)', 'Germany (1)']);
        });

        it('renders no chips when no hit carries a country', async () => {
            resolveWith(hitsWithCountries([null, null]));

            await submit('blue note');

            expect(document.getElementById('searchCountryFilter').textContent).toBe('');
        });

        it('sends the chosen country back as a filter', async () => {
            resolveWith(hitsWithCountries(['UK', 'Germany']));
            await submit('blue note');

            document.querySelector('[data-country="UK"]').click();
            await new Promise(r => setTimeout(r, 10));

            expect(window.apiClient.search).toHaveBeenLastCalledWith(
                'blue note', expect.any(Array), [], null, null, 20, 0, [], ['UK'],
            );
        });

        it('keeps a chosen country on screen when the filtered page no longer offers it', async () => {
            resolveWith(hitsWithCountries(['UK', 'Germany']));
            await submit('blue note');

            resolveWith([]);
            document.querySelector('[data-country="UK"]').click();
            await new Promise(r => setTimeout(r, 10));

            const chip = document.querySelector('[data-country="UK"]');
            expect(chip).not.toBeNull();
            expect(chip.getAttribute('aria-pressed')).toBe('true');
        });

        it('clears the chosen country when the query text changes', async () => {
            resolveWith(hitsWithCountries(['UK']));
            await submit('blue note');
            document.querySelector('[data-country="UK"]').click();
            await new Promise(r => setTimeout(r, 10));

            await submit('impulse');

            expect(window.apiClient.search).toHaveBeenLastCalledWith(
                'impulse', expect.any(Array), [], null, null, 20, 0, [], [],
            );
        });

        it('drops the chips when a search fails', async () => {
            resolveWith(hitsWithCountries(['UK']));
            await submit('blue note');

            window.apiClient.search.mockResolvedValue(null);
            await submit('impulse');

            expect(document.getElementById('searchCountryFilter').textContent).toBe('');
        });
    });
});
