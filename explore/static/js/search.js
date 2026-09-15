/**
 * Search pane — full-text search with type/genre/year filters and faceted results,
 * and identifier lookup for a record somebody is holding.
 *
 * The two modes share one input because they are one gesture: a collector types
 * what they can read off the object. Which route answers depends on whether that
 * is a title or a marking, and the toggle beside the box is where they say which.
 */
(function initSearchPane() {
    'use strict';

    // DOM refs
    const input       = document.getElementById('searchPaneInput');
    const chipWrap    = document.getElementById('searchTypeChips');
    const yearMinEl   = document.getElementById('searchYearMin');
    const yearMaxEl   = document.getElementById('searchYearMax');
    const genreWrap   = document.getElementById('searchGenreFilter');
    const mediaWrap   = document.getElementById('searchMediaFilter');
    const countryWrap = document.getElementById('searchCountryFilter');
    const modeWrap    = document.getElementById('searchModeToggle');
    const filtersWrap = document.getElementById('searchPaneFilters');
    const facetsEl    = document.getElementById('searchFacets');
    const loadingEl   = document.getElementById('searchLoading');
    const placeholder = document.getElementById('searchPlaceholder');
    const resultsEl   = document.getElementById('searchResults');
    const paginationEl = document.getElementById('searchPagination');

    if (!input) return;

    const PAGE_SIZE = 20;
    const searchBtn = document.getElementById('searchPaneBtn');

    // The full-text mode, named so the lookup branches read as the exception they
    // are rather than as "not one of the three providers".
    const TEXT_MODE = 'text';

    // The ADR 0009 alias namespaces the lookup route can resolve, spelled for a
    // person. The key is the provider the route takes; the label is what a
    // collector calls the marking they are reading off the sleeve or the groove.
    const LOOKUP_MODES = [
        ['barcode', 'Barcode'],
        ['catalog_number', 'Catalogue number'],
        ['matrix', 'Matrix'],
    ];

    function modeLabel(mode) {
        const found = LOOKUP_MODES.find(([provider]) => provider === mode);
        return found ? found[1] : mode;
    }

    let currentOffset = 0;
    let lastQuery = '';
    let lastResult = null;
    let selectedGenres = [];
    // Canonical media family ids from the `media` facet, sent back as filters.
    let selectedMedia = [];
    // Release countries (ADR 0011) taken from the hits themselves, sent back as
    // filters. The producer publishes no country facet — country is an open
    // vocabulary it does not own — so the chip list is derived from what came back.
    let selectedCountries = [];
    // Which route answers the box: TEXT_MODE for /api/search, otherwise the alias
    // namespace /api/lookup resolves the typed value under.
    let currentMode = TEXT_MODE;
    const textPlaceholder = input.placeholder;
    // Monotonic request id — discards a response from an earlier request that
    // resolves after a newer one was issued (type-chip toggle, year debounce,
    // genre chip, pagination, or a fresh Enter/search-button submit can all
    // fire while a prior search is still in flight).
    let searchRequestId = 0;

    // ------------------------------------------------------------------
    // Parse ts_headline highlight into DOM nodes (no innerHTML)
    // ts_headline output contains only <b>matched</b> segments.
    // ------------------------------------------------------------------

    function buildHighlightNodes(highlight) {
        const fragment = document.createDocumentFragment();
        if (!highlight || typeof highlight !== 'string') return fragment;
        // Split on <b>...</b> boundaries
        const parts = highlight.split(/(<b>.*?<\/b>)/gi);
        parts.forEach(part => {
            const match = part.match(/^<b>(.*?)<\/b>$/i);
            if (match) {
                const b = document.createElement('b');
                b.textContent = match[1];
                fragment.appendChild(b);
            } else if (part) {
                fragment.appendChild(document.createTextNode(part));
            }
        });
        return fragment;
    }

    // ------------------------------------------------------------------
    // Lookup mode toggle
    // ------------------------------------------------------------------

    if (modeWrap) {
        modeWrap.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-search-mode]');
            if (!btn) return;
            const mode = btn.dataset.searchMode || TEXT_MODE;
            if (mode === currentMode) return;
            setMode(mode);
        });
    }

    /**
     * Switch the box between full-text search and one lookup namespace.
     *
     * Every facet selection is dropped on the way across. A genre chip is
     * coupled to the query that produced it (see resetGenresOnNewQuery); a mode
     * change is a stronger break than a new query, and the lookup route takes no
     * filters at all, so carrying one over would leave a filter on screen that
     * narrows nothing and then silently narrows the next text search.
     *
     * @param {string} mode - TEXT_MODE or a lookup provider namespace
     */
    function setMode(mode) {
        currentMode = mode;
        modeWrap?.querySelectorAll('[data-search-mode]').forEach(el => {
            const active = (el.dataset.searchMode || TEXT_MODE) === mode;
            el.classList.toggle('active', active);
            el.setAttribute('aria-pressed', String(active));
        });

        // The filter row describes a full-text search across the catalog. The
        // lookup route takes one identifier and nothing else, so offering a year
        // range beside a barcode would promise a narrowing that cannot happen.
        if (filtersWrap) filtersWrap.hidden = mode !== TEXT_MODE;

        if (mode === TEXT_MODE) {
            input.placeholder = textPlaceholder;
            input.removeAttribute('aria-label');
        } else {
            input.placeholder = `Scan or type a ${modeLabel(mode).toLowerCase()}...`;
            input.setAttribute('aria-label', `${modeLabel(mode)} to look up`);
        }

        selectedGenres = [];
        selectedMedia = [];
        selectedCountries = [];
        currentOffset = 0;
        lastQuery = '';
        if (input.value.trim()) triggerSearch();
        else showPlaceholder();
    }

    // ------------------------------------------------------------------
    // Type chip toggles
    // ------------------------------------------------------------------

    chipWrap.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-search-type]');
        if (!chip) return;
        chip.classList.toggle('active');
        triggerSearch();
    });

    function getActiveTypes() {
        return Array.from(chipWrap.querySelectorAll('.active[data-search-type]'))
            .map(el => el.dataset.searchType);
    }

    // ------------------------------------------------------------------
    // Year range inputs
    // ------------------------------------------------------------------

    let yearTimer;
    [yearMinEl, yearMaxEl].forEach(el => {
        el.addEventListener('input', () => {
            clearTimeout(yearTimer);
            yearTimer = setTimeout(() => triggerSearch(), 500);
        });
    });

    // ------------------------------------------------------------------
    // Debounced search input
    // ------------------------------------------------------------------

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            resetGenresOnNewQuery();
            currentOffset = 0;
            triggerSearch();
        }
    });

    searchBtn.addEventListener('click', () => {
        resetGenresOnNewQuery();
        currentOffset = 0;
        triggerSearch();
    });

    // A genre facet chip is semantically coupled to the query that produced
    // it — carrying it forward silently narrows (or zeroes) an unrelated
    // query with no on-screen indication why. Clear it only when the query
    // text actually changed; refining/re-running the same query keeps it.
    function resetGenresOnNewQuery() {
        const q = input.value.trim();
        if (q === lastQuery) return;
        selectedGenres = [];
        // The media and country facets are coupled to their query for the same
        // reason — and the country chips are built from the hits themselves, so a
        // carried-over country can describe a value the new query never returns.
        selectedMedia = [];
        selectedCountries = [];
    }

    // ------------------------------------------------------------------
    // Core search
    // ------------------------------------------------------------------

    async function triggerSearch() {
        if (currentMode !== TEXT_MODE) return runLookup();

        const q = input.value.trim();
        if (q.length < 3) {
            showPlaceholder();
            return;
        }

        const requestId = ++searchRequestId;

        lastQuery = q;
        setVisible(placeholder, false);
        setVisible(loadingEl, true);
        setVisible(resultsEl, false);
        paginationEl.textContent = '';
        facetsEl.textContent = '';

        const types = getActiveTypes();
        const yearMin = yearMinEl.value ? parseInt(yearMinEl.value, 10) : null;
        const yearMax = yearMaxEl.value ? parseInt(yearMaxEl.value, 10) : null;

        let data;
        try {
            data = await window.apiClient.search(q, types, selectedGenres, yearMin, yearMax, PAGE_SIZE, currentOffset, selectedMedia, selectedCountries);
        } catch {
            // A network-level fetch rejection (offline, DNS, connection reset,
            // CORS) — not an HTTP error status — falls through to the same
            // null-data error rendering below instead of leaving the loading
            // overlay stuck on-screen forever.
            data = null;
        }

        // A newer search has since been issued — discard this stale response
        // rather than let it overwrite results/pagination for the current one.
        if (requestId !== searchRequestId) return;

        setVisible(loadingEl, false);

        if (!data || !data.results) {
            resultsEl.textContent = '';
            // Facet chips from a prior successful search describe a result set
            // that no longer exists once this search has failed — leaving them
            // on screen would let the user filter/toggle a facet that renders
            // nothing anymore.
            clearFacetChips();
            const msg = document.createElement('p');
            msg.className = 'text-text-mid text-center py-8';
            msg.textContent = 'An error occurred. Please try again.';
            resultsEl.appendChild(msg);
            setVisible(resultsEl, true);
            return;
        }

        lastResult = data;
        renderFacets(data.facets);
        renderCountryFacet(data.results);
        renderResults(data.results, data.total);
        renderPagination(data.total, data.pagination);
        setVisible(resultsEl, true);
    }

    // ------------------------------------------------------------------
    // Identifier lookup
    // ------------------------------------------------------------------

    /**
     * Resolve the typed identifier and render what it resolved to as hits.
     *
     * No minimum length: a catalogue number can be four characters, and the
     * three-character floor on full-text search exists because the producer
     * rejects a shorter query, which the lookup route does not.
     */
    async function runLookup() {
        const value = input.value.trim();
        if (!value) {
            showPlaceholder();
            return;
        }

        const requestId = ++searchRequestId;

        lastQuery = value;
        setVisible(placeholder, false);
        setVisible(loadingEl, true);
        setVisible(resultsEl, false);
        paginationEl.textContent = '';
        facetsEl.textContent = '';

        let data;
        try {
            data = await window.apiClient.lookup(currentMode, value);
        } catch {
            data = null;
        }

        if (requestId !== searchRequestId) return;

        setVisible(loadingEl, false);
        // A lookup takes no filters, so no chip on screen describes this answer.
        clearFacetChips();
        resultsEl.textContent = '';

        if (!data) {
            const msg = document.createElement('p');
            msg.className = 'text-text-mid text-center py-8';
            msg.textContent = 'An error occurred. Please try again.';
            resultsEl.appendChild(msg);
            setVisible(resultsEl, true);
            return;
        }

        // A miss is an answer about the record, not a failure of the service, so
        // it is reported in the producer's own words rather than as an error.
        if (data.notFound) {
            lastResult = null;
            renderNoResults(data.error || `Nothing carries that ${modeLabel(currentMode).toLowerCase()}.`);
            setVisible(resultsEl, true);
            return;
        }

        lastResult = data;
        const hits = lookupHits(data);
        renderResults(hits, hits.length);
        setVisible(resultsEl, true);
    }

    /**
     * Convert a lookup response into the hit shape the result list renders.
     *
     * `resolved_by` is what marks a hit as resolved rather than ranked: the
     * lookup route returns the row an identifier names, so there is no relevance
     * to draw, and the badge takes the relevance bar's place in the card.
     *
     * @param {object} data - The lookup response
     * @returns {Array<object>} Hits in the search-result shape
     */
    function lookupHits(data) {
        return (data.releases || []).map(release => ({
            type: 'release',
            id: release.id,
            gm_id: data.gm_id,
            name: release.title || '(Unknown title)',
            resolved_by: data.provider,
            source: release.source,
            metadata: {
                year: release.year ?? null,
                artist: release.artist ?? null,
                media_families: release.media_families || [],
            },
        }));
    }

    // ------------------------------------------------------------------
    // Facets
    // ------------------------------------------------------------------

    function renderFacets(facets) {
        facetsEl.textContent = '';
        if (!facets) return;

        // Type facets
        if (facets.type) {
            const row = document.createElement('div');
            row.className = 'search-facet-row';
            Object.entries(facets.type).forEach(([type, count]) => {
                if (count === 0) return;
                const tag = document.createElement('span');
                tag.className = 'search-facet-tag';
                tag.textContent = `${type} (${count.toLocaleString()})`;
                row.appendChild(tag);
            });
            if (row.children.length) facetsEl.appendChild(row);
        }

        // Genre facets as clickable chips
        if (facets.genre && Object.keys(facets.genre).length) {
            genreWrap.textContent = '';
            const label = document.createElement('label');
            label.className = 'search-filter-label';
            label.textContent = 'Genres';
            genreWrap.appendChild(label);

            const chips = document.createElement('div');
            chips.className = 'search-genre-chips';
            const entries = Object.entries(facets.genre).slice(0, 12);
            entries.forEach(([genre, count]) => {
                const chip = document.createElement('button');
                chip.className = 'search-chip search-chip-sm';
                const selected = selectedGenres.includes(genre);
                chip.classList.toggle('active', selected);
                chip.setAttribute('aria-pressed', String(selected));
                chip.textContent = `${genre} (${count})`;
                chip.addEventListener('click', () => {
                    const idx = selectedGenres.indexOf(genre);
                    if (idx >= 0) {
                        selectedGenres.splice(idx, 1);
                    } else {
                        selectedGenres.push(genre);
                    }
                    const nowSelected = idx < 0;
                    chip.classList.toggle('active', nowSelected);
                    chip.setAttribute('aria-pressed', String(nowSelected));
                    currentOffset = 0;
                    triggerSearch();
                });
                chips.appendChild(chip);
            });
            genreWrap.appendChild(chips);
        }

        // Media family facets as clickable chips. Counts arrive keyed by
        // canonical family id; the label map is shared with the gap pane so a
        // family is spelled identically in both places.
        if (mediaWrap) mediaWrap.textContent = '';
        if (mediaWrap && facets.media && Object.keys(facets.media).length) {
            const label = document.createElement('label');
            label.className = 'search-filter-label';
            label.textContent = 'Media';
            mediaWrap.appendChild(label);

            const chips = document.createElement('div');
            chips.className = 'search-media-chips';
            Object.entries(facets.media).forEach(([family, count]) => {
                if (!count) return;
                const chip = document.createElement('button');
                chip.className = 'search-chip search-chip-sm search-media-chip';
                chip.type = 'button';
                chip.dataset.mediaFamily = family;
                const familyName = window.mediaTaxonomy?.familyLabel(family) || family;
                const selected = selectedMedia.includes(family);
                chip.classList.toggle('active', selected);
                chip.setAttribute('aria-pressed', String(selected));
                chip.textContent = `${familyName} (${count.toLocaleString()})`;
                chip.addEventListener('click', () => {
                    const idx = selectedMedia.indexOf(family);
                    if (idx >= 0) selectedMedia.splice(idx, 1);
                    else selectedMedia.push(family);
                    const nowSelected = idx < 0;
                    chip.classList.toggle('active', nowSelected);
                    chip.setAttribute('aria-pressed', String(nowSelected));
                    currentOffset = 0;
                    triggerSearch();
                });
                chips.appendChild(chip);
            });
            if (chips.children.length) mediaWrap.appendChild(chips);
            else mediaWrap.textContent = '';
        }

        // Decade facets
        if (facets.decade && Object.keys(facets.decade).length) {
            const row = document.createElement('div');
            row.className = 'search-facet-row';
            Object.entries(facets.decade)
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([decade, count]) => {
                    if (count === 0) return;
                    const tag = document.createElement('span');
                    tag.className = 'search-facet-tag search-facet-decade';
                    tag.textContent = `${decade} (${count.toLocaleString()})`;
                    row.appendChild(tag);
                });
            if (row.children.length) facetsEl.appendChild(row);
        }
    }

    /**
     * Render the country chips for a result page.
     *
     * Built from the hits rather than from a facet block: the producer treats
     * country as an open vocabulary it does not own (Discogs writes names,
     * MusicBrainz writes codes) and publishes no counts for it, so the only
     * countries this pane can honestly offer are the ones it was just sent.
     *
     * @param {Array<object>} results - The hits of the current page
     */
    function renderCountryFacet(results) {
        if (!countryWrap) return;
        countryWrap.textContent = '';

        const counts = new Map();
        (results || []).forEach(r => {
            const country = r.country;
            if (!country) return;
            counts.set(country, (counts.get(country) || 0) + 1);
        });

        // A selected country keeps its chip even when this page no longer shows
        // it. Filtering to a country can remove every hit that would have
        // offered the chip back, which would otherwise strand the filter on with
        // nothing on screen to turn it off.
        selectedCountries.forEach(country => {
            if (!counts.has(country)) counts.set(country, 0);
        });

        if (!counts.size) return;

        const label = document.createElement('label');
        label.className = 'search-filter-label';
        label.textContent = 'Country';
        countryWrap.appendChild(label);

        const chips = document.createElement('div');
        chips.className = 'search-country-chips';
        Array.from(counts.entries())
            .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName))
            .slice(0, 12)
            .forEach(([country, count]) => {
                const chip = document.createElement('button');
                chip.className = 'search-chip search-chip-sm search-country-chip';
                chip.type = 'button';
                chip.dataset.country = country;
                const selected = selectedCountries.includes(country);
                chip.classList.toggle('active', selected);
                chip.setAttribute('aria-pressed', String(selected));
                chip.textContent = `${country} (${count.toLocaleString()})`;
                chip.addEventListener('click', () => {
                    const idx = selectedCountries.indexOf(country);
                    if (idx >= 0) selectedCountries.splice(idx, 1);
                    else selectedCountries.push(country);
                    const nowSelected = idx < 0;
                    chip.classList.toggle('active', nowSelected);
                    chip.setAttribute('aria-pressed', String(nowSelected));
                    currentOffset = 0;
                    triggerSearch();
                });
                chips.appendChild(chip);
            });
        countryWrap.appendChild(chips);
    }

    // ------------------------------------------------------------------
    // Results
    // ------------------------------------------------------------------

    function renderResults(results, total) {
        resultsEl.textContent = '';

        if (results.length === 0) {
            renderNoResults(`No results found for "${lastQuery}"`);
            return;
        }

        const header = document.createElement('div');
        header.className = 'search-results-header';
        header.textContent = `${total.toLocaleString()} result${total === 1 ? '' : 's'}`;
        resultsEl.appendChild(header);

        const list = document.createElement('div');
        list.className = 'search-results-list';

        results.forEach(r => {
            const card = document.createElement('div');
            card.className = 'search-result-card';
            // Keep the impression the hit was served under and the id of what
            // was served, so an opened hit can be attributed without re-reading
            // the response.
            if (r.impression_id) card.dataset.impressionId = r.impression_id;
            if (r.gm_id) card.dataset.gmId = r.gm_id;
            card.addEventListener('click', () => {
                emitResultOpened(r);
                navigateToResult(r);
            });

            // Type badge
            const badge = document.createElement('span');
            badge.className = `search-result-badge search-badge-${r.type}`;
            badge.textContent = r.type;

            // Name — use sanitized highlight if available, plain text otherwise
            const name = document.createElement('span');
            name.className = 'search-result-name';
            if (r.highlight) {
                name.appendChild(buildHighlightNodes(r.highlight));
            } else {
                name.textContent = r.name;
            }

            // Metadata line. A resolved hit names its artist and the catalog the
            // row came from — one identifier legitimately resolves to a Discogs
            // row and a MusicBrainz row for the same pressing, and the collector
            // is the one who has to tell them apart.
            const meta = document.createElement('span');
            meta.className = 'search-result-meta';
            const parts = [];
            if (r.metadata?.year) parts.push(String(r.metadata.year));
            if (r.resolved_by) {
                if (r.metadata?.artist) parts.push(r.metadata.artist);
                if (r.source) parts.push(r.source);
            } else if (r.metadata?.genres?.length) {
                parts.push(r.metadata.genres.slice(0, 3).join(', '));
            }
            meta.textContent = parts.join(' \u00B7 ');

            // Where the relevance bar goes: a ranked hit shows how well it
            // matched, a resolved hit shows what resolved it. An identifier match
            // is exact, so drawing a relevance bar for one would invite a reading
            // of "how good a match is this" that has no answer.
            const trailing = r.resolved_by
                ? buildResolvedByBadge(r.resolved_by)
                : buildRelevanceBar(r.relevance);

            card.append(badge, name, meta, trailing);
            list.appendChild(card);
        });

        resultsEl.appendChild(list);
    }

    function renderNoResults(message) {
        const msg = document.createElement('div');
        msg.className = 'search-no-results';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined icon-2x mb-2';
        icon.textContent = 'search';
        msg.appendChild(icon);
        const txt = document.createElement('p');
        txt.textContent = message;
        msg.appendChild(txt);
        resultsEl.appendChild(msg);
    }

    function buildRelevanceBar(relevance) {
        const rel = document.createElement('span');
        rel.className = 'search-result-relevance';
        const pct = Math.min(100, Math.round((relevance || 0) * 100));
        rel.title = `Relevance: ${pct}%`;
        const bar = document.createElement('span');
        bar.className = 'search-relevance-bar';
        bar.style.width = `${pct}%`;
        rel.appendChild(bar);
        return rel;
    }

    function buildResolvedByBadge(provider) {
        const badge = document.createElement('span');
        badge.className = 'search-resolved-by';
        badge.dataset.resolvedBy = provider;
        badge.textContent = `resolved by ${modeLabel(provider).toLowerCase()}`;
        return badge;
    }

    // ------------------------------------------------------------------
    // Pagination
    // ------------------------------------------------------------------

    function renderPagination(total, pagination) {
        paginationEl.textContent = '';
        if (!pagination || (!pagination.has_more && currentOffset === 0)) return;

        const totalPages = Math.ceil(total / PAGE_SIZE);
        const currentPage = Math.floor(currentOffset / PAGE_SIZE) + 1;

        const info = document.createElement('span');
        info.className = 'page-info';
        const start = currentOffset + 1;
        const end = Math.min(currentOffset + PAGE_SIZE, total);
        info.textContent = `${start}-${end} of ${total.toLocaleString()}`;

        const buttons = document.createElement('div');
        buttons.className = 'page-buttons';

        // Previous
        const prevBtn = document.createElement('button');
        prevBtn.className = 'page-btn';
        const prevIcon = document.createElement('span');
        prevIcon.className = 'material-symbols-outlined';
        prevIcon.textContent = 'chevron_left';
        prevBtn.appendChild(prevIcon);
        prevBtn.disabled = currentPage === 1;
        prevBtn.addEventListener('click', () => {
            currentOffset = Math.max(0, currentOffset - PAGE_SIZE);
            triggerSearch();
        });
        buttons.appendChild(prevBtn);

        // Page numbers
        const pages = getPageNumbers(currentPage, totalPages);
        pages.forEach(p => {
            if (p === '...') {
                const ell = document.createElement('span');
                ell.className = 'page-ellipsis';
                ell.textContent = '...';
                buttons.appendChild(ell);
            } else {
                const btn = document.createElement('button');
                btn.className = 'page-btn';
                if (p === currentPage) btn.classList.add('active');
                btn.textContent = String(p);
                btn.addEventListener('click', () => {
                    currentOffset = (p - 1) * PAGE_SIZE;
                    triggerSearch();
                });
                buttons.appendChild(btn);
            }
        });

        // Next
        const nextBtn = document.createElement('button');
        nextBtn.className = 'page-btn';
        const nextIcon = document.createElement('span');
        nextIcon.className = 'material-symbols-outlined';
        nextIcon.textContent = 'chevron_right';
        nextBtn.appendChild(nextIcon);
        nextBtn.disabled = currentPage >= totalPages || !pagination.has_more;
        nextBtn.addEventListener('click', () => {
            currentOffset += PAGE_SIZE;
            triggerSearch();
        });
        buttons.appendChild(nextBtn);

        paginationEl.append(info, buttons);
    }

    function getPageNumbers(current, total) {
        if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
        const pages = [];
        if (current <= 4) {
            for (let i = 1; i <= 5; i++) pages.push(i);
            pages.push('...', total);
        } else if (current >= total - 3) {
            pages.push(1, '...');
            for (let i = total - 4; i <= total; i++) pages.push(i);
        } else {
            pages.push(1, '...', current - 1, current, current + 1, '...', total);
        }
        return pages;
    }

    // ------------------------------------------------------------------
    // Navigate to Explore pane on result click
    // ------------------------------------------------------------------

    /**
     * Record that the user opened a search hit, fire and forget.
     *
     * Search hits are logged server side as `search.result_impression`, and the
     * outcome vocabulary has no search-specific open term, so an opened hit is
     * recorded as `recommendation.opened` against the impression the hit
     * carries and nothing else is recorded here. A hit with no impression_id
     * and an anonymous session both record nothing. The post is never awaited,
     * so a failure cannot block or break navigation.
     *
     * @param {object} result - The search hit as the API returned it
     */
    function emitResultOpened(result) {
        const token = window.authManager?.getToken?.();
        if (!token) return;
        if (!result || !result.impression_id) return;
        if (typeof window.apiClient?.postActivityEvent !== 'function') return;
        try {
            const posted = window.apiClient.postActivityEvent(
                token, 'recommendation.opened', result.impression_id, result.gm_id ?? null,
            );
            if (posted && typeof posted.catch === 'function') posted.catch(() => {});
        } catch {
            // Best effort by design — telemetry never breaks the click-through.
        }
    }

    function navigateToResult(result) {
        const explorableTypes = ['artist', 'label'];
        const type = result.type;
        const name = result.name;

        if (explorableTypes.includes(type) && window.exploreApp) {
            window.exploreApp._setSearchType(type);
            window.exploreApp.currentQuery = name;
            document.getElementById('searchInput').value = name;
            window.exploreApp._switchPane('explore');
            window.exploreApp._loadExplore(name, type);
        } else if (window.exploreApp) {
            // For release/master — not directly explorable
            if (window.exploreApp._showToast) {
                window.exploreApp._showToast(`${type} details are not explorable directly — try searching for the artist or label instead`);
            }
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function setVisible(el, visible) {
        if (!el) return;
        if (el === loadingEl) {
            el.classList.toggle('active', visible);
        } else {
            el.classList.toggle('hidden', !visible);
        }
    }

    /**
     * Drop every facet chip on screen.
     *
     * Chips describe the result set that produced them: once that set is gone —
     * replaced by an error, a lookup answer, or the empty placeholder — a chip
     * left behind is a filter the user can toggle against nothing.
     */
    function clearFacetChips() {
        genreWrap.textContent = '';
        if (mediaWrap) mediaWrap.textContent = '';
        if (countryWrap) countryWrap.textContent = '';
    }

    function showPlaceholder() {
        setVisible(loadingEl, false);
        setVisible(resultsEl, false);
        paginationEl.textContent = '';
        facetsEl.textContent = '';
        clearFacetChips();
        setVisible(placeholder, true);
    }

    // ------------------------------------------------------------------
    // Public API for app.js pane switching
    // ------------------------------------------------------------------

    window.searchPane = {
        focus() {
            input.focus();
        },
    };
})();
