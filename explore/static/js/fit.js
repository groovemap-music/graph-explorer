/**
 * "Will it fit?" — the item-in-hand fit profile pane (CrateFit v0).
 *
 * A collector with a record in their hands is asking five questions at once, so
 * the pane renders the decomposition rather than the combined number: the
 * overall fit as one bar, then affinity, novelty, bridge, depth and redundancy
 * each with their own bar and the evidence the API drew from the caller's own
 * shelves. The combined score is an arithmetic consequence of the five; the five
 * are the part a person reads.
 *
 * Depends on: window.apiClient (api-client.js), window.authManager (auth.js),
 * and window.exploreApp.graph (graph.js) for the landing point.
 */
class FitPane {
    /**
     * How long a dismissed or hidden profile card stays in the DOM while it
     * collapses. Mirrors UserPanes.OUTCOME_COLLAPSE_MS — the two use the same
     * rec-outcome-* transition, so one duration governs both.
     */
    static COLLAPSE_MS = 180;

    /**
     * The five components in the order the decomposition names them. Fixed
     * rather than read off the response with Object.keys: the API closes the
     * component set precisely so a consumer that renders five named rows breaks
     * loudly if a future version ever drops one, and iterating the response
     * would silently render four.
     */
    static COMPONENTS = [
        ['affinity', 'Affinity', 'How much of this you already collect'],
        ['novelty', 'Novelty', 'How much of it is new to you'],
        ['bridge', 'Bridge', 'Whether it joins corners that do not touch'],
        ['depth', 'Depth', 'What it extends that you are already building'],
        ['redundancy', 'Redundancy', 'Whether you already have this record'],
    ];

    /** Hits shown for one picker query. The picker is a shortlist, not a search pane. */
    static CANDIDATE_LIMIT = 8;

    /** Minimum query length the search route accepts. */
    static MIN_QUERY = 3;

    /** The picker's title mode, as opposed to one of the lookup namespaces. */
    static TEXT_MODE = 'text';

    /**
     * The ADR 0011 alias namespaces the picker can resolve, spelled for a person.
     * Mirrors the search pane's toggle, because it is the same gesture: the
     * collector types whatever the object in their hand will give them.
     */
    static LOOKUP_MODES = [
        ['barcode', 'Barcode'],
        ['catalog_number', 'Catalogue number'],
        ['matrix', 'Matrix'],
    ];

    /**
     * The catalog whose release ids the fit route scores.
     *
     * One identifier resolves to every catalog that describes the pressing, but
     * `/api/fit/release/{id}` takes a Discogs release id. Offering a MusicBrainz
     * row as a scoreable candidate would send an id the route cannot read and
     * return "no profile" for a record that is in fact scoreable under its other
     * row, so those candidates are shown and named, and not selectable.
     */
    static SCOREABLE_SOURCE = 'discogs';

    constructor() {
        this._selected = null;
        this._profile = null;
        // Monotonic request ids — a slower earlier response must never clobber
        // a faster, more recent one, the same guard the search and collection
        // panes carry.
        this._searchRequestId = 0;
        this._profileRequestId = 0;
        this._bound = false;
        this._mode = FitPane.TEXT_MODE;
        this._textPlaceholder = '';
    }

    /** Spell one picker mode for a person. */
    static modeLabel(mode) {
        const found = FitPane.LOOKUP_MODES.find(([provider]) => provider === mode);
        return found ? found[1] : mode;
    }

    // ------------------------------------------------------------------ //
    // Wiring
    // ------------------------------------------------------------------ //

    /**
     * Bind the picker controls once and render the pane for the current
     * session. Safe to call on every pane switch: binding is idempotent and the
     * session state is re-read each time, so logging in or out while the pane
     * is open is reflected the next time it is shown.
     */
    init() {
        this._bind();
        this.refreshSession();
    }

    _bind() {
        if (this._bound) return;
        const input = document.getElementById('fitSearchInput');
        const searchBtn = document.getElementById('fitSearchBtn');
        const runBtn = document.getElementById('fitRunBtn');
        if (!input || !searchBtn || !runBtn) return;

        this._textPlaceholder = input.placeholder;

        searchBtn.addEventListener('click', () => this.findCandidates(input.value));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.findCandidates(input.value);
            }
        });
        runBtn.addEventListener('click', () => this.loadProfile());

        const modeWrap = document.getElementById('fitModeToggle');
        modeWrap?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-fit-mode]');
            if (!btn) return;
            const mode = btn.dataset.fitMode || FitPane.TEXT_MODE;
            if (mode !== this._mode) this.setMode(mode);
        });

        this._bound = true;
    }

    /**
     * Switch the picker between searching titles and resolving one identifier.
     *
     * The shortlist is cleared on the way across: candidates found by title are
     * an answer to a different question than the row a barcode names, and
     * leaving a selection standing would let the collector score a record they
     * found before they changed what they were asking.
     *
     * @param {string} mode - FitPane.TEXT_MODE or a lookup provider namespace
     */
    setMode(mode) {
        this._mode = mode;
        const input = document.getElementById('fitSearchInput');
        document.getElementById('fitModeToggle')?.querySelectorAll('[data-fit-mode]').forEach(el => {
            const active = (el.dataset.fitMode || FitPane.TEXT_MODE) === mode;
            el.classList.toggle('active', active);
            el.setAttribute('aria-pressed', String(active));
        });
        if (input) {
            const label = FitPane.modeLabel(mode);
            input.placeholder = mode === FitPane.TEXT_MODE
                ? this._textPlaceholder
                : `Scan or type a ${label.toLowerCase()}...`;
            input.setAttribute('aria-label', mode === FitPane.TEXT_MODE
                ? 'Find the release in your hand'
                : `${label} of the release in your hand`);
        }
        this._setCandidates([]);
        const results = document.getElementById('fitCandidates');
        if (results) results.replaceChildren();
    }

    /**
     * Show the picker to a session that has one and the sign-in prompt to one
     * that does not.
     *
     * The prompt is not a smaller picker: a fit answer is computed against the
     * caller's own collection, so an anonymous visitor has nothing to pick a
     * candidate *for*. Anything already on screen from a prior session is
     * cleared with it — a profile is a statement about somebody's shelves and
     * must not outlive their session on a shared machine.
     */
    refreshSession() {
        const signedIn = Boolean(window.authManager?.getToken?.());
        const picker = document.getElementById('fitPicker');
        const prompt = document.getElementById('fitSignedOut');
        if (picker) picker.hidden = !signedIn;
        if (prompt) prompt.hidden = signedIn;
        if (!signedIn) {
            this._selected = null;
            this._profile = null;
            this._setCandidates([]);
            const body = document.getElementById('fitBody');
            if (body) body.replaceChildren();
            const input = document.getElementById('fitSearchInput');
            if (input) input.value = '';
            this.setMode(FitPane.TEXT_MODE);
            this._setRunEnabled(false);
        }
    }

    // ------------------------------------------------------------------ //
    // Release picker
    // ------------------------------------------------------------------ //

    /**
     * Find candidate releases for what the collector typed.
     *
     * In title mode the search is restricted to `types=release` because the fit
     * route takes a release id: a master is not a pressing, and scoring the
     * wrong pressing is exactly the error the profile's identity confidence
     * exists to report. In a lookup mode the identifier names the pressing
     * outright, which is the stronger answer to the same question.
     *
     * @param {string} query - What the collector typed or scanned
     */
    async findCandidates(query) {
        const q = (query || '').trim();
        const results = document.getElementById('fitCandidates');
        if (!results) return;

        if (this._mode !== FitPane.TEXT_MODE) return this._lookupCandidates(q, results);

        if (q.length < FitPane.MIN_QUERY) {
            this._setCandidates([]);
            this._renderNotice(results, `Type at least ${FitPane.MIN_QUERY} characters to find a release.`);
            return;
        }

        const requestId = ++this._searchRequestId;
        let data;
        try {
            data = await window.apiClient.search(q, ['release'], [], null, null, FitPane.CANDIDATE_LIMIT, 0, []);
        } catch {
            // A network-level rejection (offline, DNS, CORS) is not an HTTP
            // status and would otherwise escape as an unhandled rejection.
            data = null;
        }
        if (requestId !== this._searchRequestId) return;

        if (!data || !data.results) {
            this._setCandidates([]);
            this._renderNotice(results, 'Could not search for releases. Please try again.');
            return;
        }
        if (!data.results.length) {
            this._setCandidates([]);
            this._renderNotice(results, `No releases found for "${q}".`);
            return;
        }
        this._setCandidates(data.results);
    }

    /**
     * Resolve one identifier and offer what it resolved to as the shortlist.
     *
     * No minimum length: the three-character floor exists because the search
     * route rejects a shorter query, and a catalogue number can legitimately be
     * four characters long.
     *
     * @param {string} value - The identifier as typed or scanned
     * @param {HTMLElement} results - The shortlist container
     */
    async _lookupCandidates(value, results) {
        const label = FitPane.modeLabel(this._mode).toLowerCase();
        if (!value) {
            this._setCandidates([]);
            this._renderNotice(results, `Scan or type a ${label} to find the release.`);
            return;
        }

        const requestId = ++this._searchRequestId;
        let data;
        try {
            data = await window.apiClient.lookup(this._mode, value);
        } catch {
            data = null;
        }
        if (requestId !== this._searchRequestId) return;

        if (!data) {
            this._setCandidates([]);
            this._renderNotice(results, 'Could not look that up. Please try again.');
            return;
        }
        // A miss is a fact about the record, not a failure, so it is reported
        // in the producer's own words.
        if (data.notFound || !(data.releases || []).length) {
            this._setCandidates([]);
            this._renderNotice(results, data.error || `No release carries that ${label}.`);
            return;
        }
        this._setCandidates(FitPane.lookupCandidates(data));
    }

    /**
     * Convert a lookup response into the hit shape the shortlist renders.
     *
     * @param {object} data - The lookup response
     * @returns {Array<object>} Candidates in the search-hit shape
     */
    static lookupCandidates(data) {
        return (data.releases || []).map(release => ({
            id: release.id,
            gm_id: data.gm_id,
            name: release.title || '',
            source: release.source,
            resolved_by: data.provider,
            metadata: {
                artist: release.artist ?? null,
                year: release.year ?? null,
                media_families: release.media_families || [],
            },
        }));
    }

    _setCandidates(results) {
        const container = document.getElementById('fitCandidates');
        if (!container) return;
        container.replaceChildren();
        this._selected = null;
        this._setRunEnabled(false);
        if (!results.length) return;

        results.forEach(hit => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'fit-candidate';
            option.dataset.releaseId = String(hit.id ?? '');
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');

            const name = document.createElement('span');
            name.className = 'fit-candidate-name';
            name.textContent = hit.name || '(Unknown title)';

            const meta = document.createElement('span');
            meta.className = 'fit-candidate-meta';
            const parts = [];
            if (hit.metadata?.artist) parts.push(hit.metadata.artist);
            if (hit.metadata?.year) parts.push(String(hit.metadata.year));
            meta.textContent = parts.join(' · ');

            option.append(name, meta);

            const families = hit.metadata?.media_families || [];
            const scoreable = FitPane.isScoreable(hit);
            if (families.length || hit.resolved_by) {
                const badges = document.createElement('span');
                badges.className = 'fit-candidate-badges';
                families.slice(0, 3).forEach(family => {
                    const badge = document.createElement('span');
                    badge.className = 'fit-media-badge';
                    badge.textContent = family;
                    badges.appendChild(badge);
                });
                // Which catalog the row came from, on a resolved candidate only.
                // One identifier can resolve to a row in each catalog, and which
                // one a candidate is decides whether it can be scored at all.
                if (hit.resolved_by && hit.source) {
                    const badge = document.createElement('span');
                    badge.className = 'fit-media-badge fit-source-badge';
                    badge.dataset.source = hit.source;
                    badge.textContent = hit.source;
                    badges.appendChild(badge);
                }
                option.appendChild(badges);
            }

            if (!scoreable) {
                option.disabled = true;
                option.classList.add('fit-candidate-unscoreable');
                option.setAttribute('aria-disabled', 'true');
                option.title = `Scoring reads ${FitPane.SCOREABLE_SOURCE} releases; this row came from ${hit.source}.`;
            } else {
                option.addEventListener('click', () => this._select(hit, option));
            }
            container.appendChild(option);
        });
    }

    /**
     * Whether the fit route can score this candidate.
     *
     * A hit with no `source` is a search hit, which is a Discogs release by
     * construction. A resolved hit names its catalog, and only the Discogs row
     * carries an id `/api/fit/release/{id}` can read.
     *
     * @param {object} hit - A candidate in the search-hit shape
     * @returns {boolean}
     */
    static isScoreable(hit) {
        if (!hit || !hit.id) return false;
        return !hit.source || hit.source === FitPane.SCOREABLE_SOURCE;
    }

    _select(hit, option) {
        const container = document.getElementById('fitCandidates');
        container?.querySelectorAll('.fit-candidate').forEach(el => {
            el.setAttribute('aria-selected', 'false');
            el.classList.remove('active');
        });
        option.setAttribute('aria-selected', 'true');
        option.classList.add('active');
        this._selected = hit;
        this._setRunEnabled(FitPane.isScoreable(hit));
    }

    _setRunEnabled(enabled) {
        const runBtn = document.getElementById('fitRunBtn');
        if (runBtn) runBtn.disabled = !enabled;
    }

    _renderNotice(container, message) {
        const notice = document.createElement('p');
        notice.className = 'fit-notice text-text-mid';
        notice.textContent = message;
        container.appendChild(notice);
    }

    // ------------------------------------------------------------------ //
    // The profile
    // ------------------------------------------------------------------ //

    /**
     * Fetch and render the fit profile for the selected candidate, and draw its
     * landing point.
     */
    async loadProfile() {
        const token = window.authManager?.getToken?.();
        const body = document.getElementById('fitBody');
        if (!token || !this._selected?.id || !body) return;

        const loading = document.getElementById('fitLoading');
        const requestId = ++this._profileRequestId;
        loading?.classList.add('active');
        let profile;
        try {
            profile = await window.apiClient.getFitProfile(token, String(this._selected.id));
        } catch {
            profile = null;
        } finally {
            if (requestId === this._profileRequestId) loading?.classList.remove('active');
        }
        if (requestId !== this._profileRequestId) return;

        this._profile = profile;
        if (!profile) {
            body.replaceChildren();
            const errored = document.createElement('div');
            errored.className = 'user-pane-empty';
            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined icon-3x mb-3';
            icon.textContent = 'error_outline';
            const msg = document.createElement('p');
            msg.textContent = 'No fit profile for that release. Please try again.';
            errored.append(icon, msg);
            body.appendChild(errored);
            return;
        }

        this.renderProfile(body, profile);
        this.drawLandingPoint(profile);
    }

    /**
     * Render one profile card.
     *
     * @param {HTMLElement} container - The pane body
     * @param {object} profile - The FitProfile as the API returned it
     */
    renderProfile(container, profile) {
        if (!container) return;
        container.replaceChildren();

        const card = document.createElement('div');
        card.className = 'fit-card';
        if (profile.impression_id) card.dataset.impressionId = profile.impression_id;
        const release = profile.release || {};
        if (release.gm_id) card.dataset.gmId = release.gm_id;

        card.appendChild(this._buildHeader(profile, release));
        card.appendChild(this._buildOverall(profile));

        const components = document.createElement('div');
        components.className = 'fit-components';
        FitPane.COMPONENTS.forEach(([key, label, blurb]) => {
            components.appendChild(this._buildComponentRow(key, label, blurb, profile.components?.[key]));
        });
        card.appendChild(components);

        const footer = document.createElement('div');
        footer.className = 'fit-card-footer';

        // The landing point is drawn as soon as the profile renders; this is the
        // way to it, because the one graph canvas lives in the explore pane.
        const landing = document.createElement('button');
        landing.type = 'button';
        landing.className = 'btn-outline-secondary btn-sm fit-landing-btn';
        landing.id = 'fitLandingBtn';
        landing.textContent = 'See the landing point';
        landing.addEventListener('click', () => {
            this.drawLandingPoint(profile);
            window.exploreApp?._switchPane?.('explore');
        });

        const version = document.createElement('p');
        version.className = 'fit-version';
        version.textContent = `Scored by ${profile.fit_version || 'an unnamed version'}`;

        footer.append(landing, version);
        card.appendChild(footer);

        const controls = this._buildOutcomeControls(profile, card);
        if (controls) card.appendChild(controls);

        container.appendChild(card);
    }

    _buildHeader(profile, release) {
        const header = document.createElement('div');
        header.className = 'fit-card-header';

        const title = document.createElement('div');
        title.className = 'fit-card-title';
        title.textContent = release.title || String(release.id || '(Unknown release)');

        const meta = document.createElement('div');
        meta.className = 'fit-card-meta';
        meta.textContent = [release.artist, release.year].filter(Boolean).join(' · ');

        const badges = document.createElement('div');
        badges.className = 'fit-card-badges';

        // The identity marker sits beside the fit and is never folded into it:
        // how sure the service is *which record this is* is a different question
        // from how well it fits, and multiplying the two would make a confident
        // bad fit indistinguishable from an unsure good one.
        const confidence = document.createElement('span');
        confidence.className = `fit-confidence fit-confidence-${profile.confidence || 'unknown'}`;
        confidence.dataset.confidence = profile.confidence || '';
        confidence.textContent = profile.confidence === 'exact' ? 'exact release' : 'master only';
        confidence.title = profile.confidence === 'exact'
            ? 'Scored against this exact pressing'
            : 'Scored against the master — this may not be the pressing in your hand';
        badges.appendChild(confidence);

        (release.media_families || []).forEach(family => {
            const badge = document.createElement('span');
            badge.className = 'fit-media-badge';
            badge.textContent = family;
            badges.appendChild(badge);
        });

        // Rarity is a fact about the record, never an input to any component —
        // shown beside the fit so a common record the collector obviously wants
        // does not read as a worse buy than a rare one they do not.
        if (release.rarity?.tier) {
            const rarity = document.createElement('span');
            rarity.className = 'fit-rarity-badge';
            rarity.textContent = release.rarity.tier;
            badges.appendChild(rarity);
        }

        header.append(title, meta, badges);
        return header;
    }

    _buildOverall(profile) {
        const overall = document.createElement('div');
        overall.className = 'fit-overall';

        const label = document.createElement('div');
        label.className = 'fit-overall-label';
        label.textContent = 'Overall fit';

        const value = document.createElement('div');
        value.className = 'fit-overall-value';
        value.textContent = FitPane.percent(profile.fit);

        overall.append(label, this._buildBar(profile.fit, 'fit-overall-bar', 'Overall fit'), value);
        return overall;
    }

    _buildComponentRow(key, label, blurb, component) {
        const row = document.createElement('div');
        row.className = 'fit-component';
        row.dataset.component = key;

        const name = document.createElement('div');
        name.className = 'fit-component-name';
        name.textContent = label;
        name.title = blurb;

        const score = document.createElement('div');
        score.className = 'fit-component-score';
        score.textContent = FitPane.percent(component?.score);

        row.append(name, this._buildBar(component?.score, 'fit-component-bar', label), score);

        // A component with no evidence renders no evidence list at all rather
        // than an empty one: a sparse collection legitimately produces silent
        // components, and an empty bullet reads as a missing fact.
        const evidence = (component?.evidence || []).filter(Boolean);
        if (evidence.length) {
            const list = document.createElement('ul');
            list.className = 'fit-evidence';
            evidence.forEach(line => {
                const item = document.createElement('li');
                item.textContent = line;
                list.appendChild(item);
            });
            row.appendChild(list);
        }
        return row;
    }

    _buildBar(score, className, label) {
        const pct = FitPane.pct(score);
        const bar = document.createElement('div');
        bar.className = `fit-bar ${className}`;
        bar.setAttribute('role', 'meter');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(pct));
        bar.setAttribute('aria-label', label);
        const fill = document.createElement('div');
        fill.className = 'fit-bar-fill';
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        return bar;
    }

    /** A score in [0, 1] as a whole percentage, clamped, with a missing score reading zero. */
    static pct(score) {
        const value = Number(score);
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(100, Math.round(value * 100)));
    }

    /** A score in [0, 1] rendered for a person. */
    static percent(score) {
        return Number.isFinite(Number(score)) ? `${FitPane.pct(score)}%` : '—';
    }

    // ------------------------------------------------------------------ //
    // The landing point
    // ------------------------------------------------------------------ //

    /**
     * Draw the candidate among the entities its evidence named.
     *
     * `restoreSnapshot` rather than `setExploreData`: the explore route centres
     * on an artist, label, genre or style and cannot centre on a release, and
     * the whole point of a landing point is that the release is in the middle.
     *
     * The single graph canvas lives in the explore pane, so the snapshot is
     * drawn there and the card carries a control that switches to it — there is
     * one GraphVisualization bound to one `#graphSvg`, and a second canvas would
     * be a new primitive rather than a reuse of the existing one.
     *
     * @param {object} profile - The FitProfile as the API returned it
     */
    drawLandingPoint(profile) {
        const graph = window.exploreApp?.graph;
        if (!graph || typeof graph.restoreSnapshot !== 'function') return;
        const release = profile?.release || {};
        const centre = { id: release.title || String(release.id || ''), type: 'release' };
        if (!centre.id) return;
        graph.restoreSnapshot(FitPane.evidenceEntities(profile), centre);
    }

    /**
     * The entities the evidence names, as snapshot nodes.
     *
     * The evidence is prose written for a person, and these are the sentence
     * shapes `api.fit` builds it from. Reading the entities back out of the
     * prose is deliberate: the API states its facts once, in the form a
     * collector reads, and a parallel machine-readable copy would be a second
     * thing to keep in step. A sentence that does not match any shape simply
     * contributes no node — the card still shows the line, the graph just has
     * one fewer satellite.
     *
     * @param {object} profile - The FitProfile as the API returned it
     * @returns {Array<{id: string, type: string}>} Deduplicated snapshot nodes
     */
    static evidenceEntities(profile) {
        const nodes = [];
        const seen = new Set();
        const add = (name, type) => {
            const id = (name || '').trim();
            if (!id) return;
            const key = `${type}:${id}`;
            if (seen.has(key)) return;
            seen.add(key);
            nodes.push({ id, type });
        };

        const components = profile?.components || {};
        for (const [key] of FitPane.COMPONENTS) {
            for (const line of components[key]?.evidence || []) {
                if (typeof line !== 'string') continue;
                let m;
                if ((m = /^shares (artist|label|genre|style) (.+) with \d+ release/.exec(line))) {
                    add(m[2], m[1]);
                } else if ((m = /^(.+) is an? (artist|label|genre|style) your collection has never held$/.exec(line))) {
                    add(m[1], m[2]);
                } else if ((m = /^deepens (artist|label|genre|style) (.+) \(\d+ held\)$/.exec(line))) {
                    add(m[2], m[1]);
                } else if ((m = /^bridges (.+), which share no artist or label in your collection$/.exec(line))) {
                    // "Rock, Jazz and Soul" — the regions the candidate joins.
                    m[1].split(/,\s*|\s+and\s+/).forEach(region => add(region, 'genre'));
                } else if ((m = /^you hold (.+?) by (.+), which no master links to this pressing$/.exec(line))) {
                    add(m[1], 'release');
                    add(m[2], 'artist');
                } else if ((m = /^you hold (.+?), the same record on /.exec(line))) {
                    add(m[1], 'release');
                }
            }
        }
        return nodes;
    }

    // ------------------------------------------------------------------ //
    // Outcomes
    // ------------------------------------------------------------------ //

    /**
     * Post one outcome against the showing the profile carries, fire and forget.
     *
     * The terms are the fit vocabulary: `catalog-api` records a fit impression
     * against the fit surface, not the recommendation surface, so the outcome
     * an impression collects has to name the same surface it was shown under.
     *
     * @param {string} eventType - Outcome vocabulary term
     * @param {object} profile - The FitProfile the outcome is reported against
     */
    emitOutcome(eventType, profile) {
        const token = window.authManager?.getToken?.();
        if (!token) return;
        if (!profile?.impression_id) return;
        if (typeof window.apiClient?.postActivityEvent !== 'function') return;
        try {
            const posted = window.apiClient.postActivityEvent(
                token, eventType, profile.impression_id, profile.release?.gm_id ?? null,
            );
            if (posted && typeof posted.catch === 'function') posted.catch(() => {});
        } catch {
            // Telemetry is best effort by design — a throwing client must never
            // reach the collector who pressed the button.
        }
    }

    /**
     * Build the Save / Dismiss / Hide row for one profile.
     *
     * Returns null when the profile carries no impression_id — the release has
     * no native id, or the impression could not be written — because a control
     * that cannot record anything promises an effect that never happens.
     *
     * @param {object} profile - The FitProfile as the API returned it
     * @param {HTMLElement} card - The rendered card the controls act on
     * @returns {HTMLElement|null}
     */
    _buildOutcomeControls(profile, card) {
        const token = window.authManager?.getToken?.();
        if (!token) return null;
        if (!profile?.impression_id) return null;

        const release = profile.release || {};
        const label = [release.title, release.artist].filter(Boolean).join(' by ') || 'this release';
        const actions = document.createElement('div');
        actions.className = 'rec-outcome-actions fit-outcome-actions';

        const save = this._buildOutcomeButton('save', 'bookmark_add', `Save ${label}`);
        save.addEventListener('click', () => {
            // The vocabulary has no un-save term, so the saved state is terminal
            // and a repeat click records nothing.
            if (save.getAttribute('aria-pressed') === 'true') return;
            this.emitOutcome('fit.saved', profile);
            save.setAttribute('aria-pressed', 'true');
            save.setAttribute('aria-label', `Saved ${label}`);
            save.title = `Saved ${label}`;
            const glyph = save.querySelector('.rec-outcome-icon');
            if (glyph) glyph.textContent = 'bookmark_added';
            card.classList.add('fit-card--saved');
        });

        const dismiss = this._buildOutcomeButton('dismiss', 'close', `Dismiss ${label}`);
        dismiss.addEventListener('click', () => {
            this.emitOutcome('fit.dismissed', profile);
            this._collapse(card);
        });

        const hide = this._buildOutcomeButton('hide', 'visibility_off', `Hide ${label}`);
        hide.addEventListener('click', () => {
            this.emitOutcome('fit.hidden', profile);
            this._collapse(card);
        });

        actions.append(save, dismiss, hide);
        return actions;
    }

    _buildOutcomeButton(action, icon, label) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `rec-outcome-btn rec-outcome-${action}`;
        btn.dataset.outcome = action;
        btn.setAttribute('aria-label', label);
        btn.title = label;
        if (action === 'save') btn.setAttribute('aria-pressed', 'false');
        const glyph = document.createElement('span');
        glyph.className = 'material-symbols-outlined rec-outcome-icon';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = icon;
        btn.appendChild(glyph);
        return btn;
    }

    /**
     * Collapse a dismissed or hidden card and drop it.
     *
     * Removal is on a timer rather than on `transitionend` so the card still
     * disappears where transitions never fire — reduced motion, a hidden pane,
     * jsdom.
     *
     * @param {HTMLElement} card - The rendered card to collapse
     */
    _collapse(card) {
        if (!card || card.dataset.collapsing === 'true') return;
        card.dataset.collapsing = 'true';
        card.classList.add('rec-outcome-collapsing');
        card.setAttribute('aria-hidden', 'true');
        card.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
        this._selected = null;
        this._profile = null;
        this._setRunEnabled(false);
        setTimeout(() => card.remove(), FitPane.COLLAPSE_MS);
    }
}

window.FitPane = FitPane;
window.fitPane = new FitPane();
