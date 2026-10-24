/**
 * The Genre Atlas: concept B of ADR 0016, genres, styles, and landmark masters on the Strata
 * planes, colored by lifecycle stage over valid time. It opens in the Genres pane (beside the flat
 * genre tree), in the Insights pane, and under a "Will it fit?" profile. One view serves all three:
 * it moves to whichever is on screen, so there is one renderer and one WebGL context.
 *
 * This module is the integration. It fetches `GET /api/insights/style-atlas`, adapts and lays it
 * out without moving a node (strata-atlas-layout.js), hands the layout to the atlas renderer
 * (strata-atlas-renderer.js), and owns everything around it:
 *   - the valid-time scrubber over the payload's timeline, which repaints stages and moves
 *     nothing. The provisional latest years are hatched on the scrubber and dashed in the scene,
 *     so the cue is never color alone;
 *   - the stage rule and every threshold on screen, from the payload's `rule`, with its version;
 *   - the panel: a style's stage in the scrubbed year, its latest (provisional) stage with the
 *     settled stage next to it, its parents with their shares and emergence edges, and its ghosts;
 *   - keyboard navigation bound to the renderer's camera, select, and solo;
 *   - the table, the same genres and styles as sortable rows (strata-atlas-table.js), chosen from
 *     the view toggle. It shares the scrubber, the selection, and the panel with the 3D view, and
 *     needs no WebGL. For a signed-in collector it gains a "Yours" column, the table's version of
 *     the Taste Strata marks;
 *   - the empty month before the first monthly run, and route failures, in words;
 *   - Taste Strata (concept C′, strata-taste.js), for a signed-in collector only: their items
 *     marked on the genres and styles they carry, their masters in collector slots on the master
 *     plane, the counts that are not drawn, and a "recorded as of" control over transaction time.
 *     An anonymous visitor gets the atlas without it and a hint to sign in. The projection is held
 *     here, in memory, and nowhere else: not in the URL, storage, or any shareable snapshot;
 *   - the Fit landing point (concept C′, strata-fit.js), while the view is in the "Will it fit?"
 *     pane: the candidate's drawable evidence marked on the nodes and hulls the atlas already
 *     draws, over the Taste Strata layer, and everything else listed in the panel, never placed.
 *     Like the projection, it is held in memory only.
 *
 * The DOM is built with createElement and textContent only, and styled through classes in
 * strata-atlas.css, so a `style-src 'self'` policy holds.
 */

import { AtlasRenderer } from './strata-atlas-renderer.js';
import { ATLAS_TABLE_HELP, AtlasTable, buildAtlasRows } from './strata-atlas-table.js';
import {
    ATLAS_PLANES,
    COTAGS_FAILED,
    EMPTY_MESSAGE,
    NO_COTAGS,
    NO_MASTERS,
    NO_MASTER_SLOTS,
    adaptAtlasPayload,
    clampYear,
    genreId,
    isProvisional,
    layoutAtlas,
    paintAtlas,
    primaryOf,
    ruleText,
    splitCotags,
    stageAt,
    stageCounts,
} from './strata-atlas-layout.js';
import { atlasMasterSlot } from './strata-master-slots.js';
import {
    TASTE_AS_OF_NOTE,
    TASTE_EMPTY,
    TASTE_FAILED,
    TASTE_SIGN_IN,
    adaptTasteProjection,
    heldCounts,
    paintTaste,
    recordedYears,
    withCollectorMasters,
} from './strata-taste.js';
import { COLLECTOR_STATES, stateLabel } from './strata-collector.js';
import { FIT_COMPONENTS, FIT_LABELS, FIT_MARK_WORDS, LANDING_FALLBACK, paintLanding, placeLanding, planLanding } from './strata-fit.js';

/** The panes the atlas opens in, and the element in each that holds it. */
export const ATLAS_MOUNTS = Object.freeze({ genres: 'genreAtlasMount', insights: 'insightsAtlasMount', fit: 'fitAtlasMount' });
/** The pane the Fit landing point is drawn in. Elsewhere the atlas is the atlas alone. */
export const LANDING_PANE = 'fit';
export const LANDING_KEY = 'A diamond in a component\'s color marks a node the candidate lands on, and its label says why. The Bridge is a ribbon between the hulls of the genres it joins.';
/** Milliseconds per year while the timeline plays. */
export const PLAY_STEP_MS = 400;
export const ATLAS_KEY_HELP = 'Arrow keys orbit and tilt, plus and minus zoom, 0 resets the camera. 1, 2, and 3 show one plane, and the same key again shows all. [ and ] move along a plane, PageUp moves to the genre a style is drawn under and PageDown to a genre\'s first style, and Escape clears the selection. The year slider scrubs valid time.';

export const NO_WEBGL = 'This browser cannot draw the 3D atlas: WebGL is not available. The table lists the same genres and styles.';

/** What the view says when the route fails. */
export function atlasErrorMessage(status) {
    if (status === 503) return 'The Genre Atlas is not available right now. Try again in a moment.';
    if (status === 429) return 'Too many requests in a minute. Wait a moment and try again.';
    return 'The Genre Atlas could not be loaded. Try again.';
}

/** A stage's on-screen word. */
export function stageWord(stage) {
    return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'No stage';
}

function angleOf(node) {
    const a = Math.atan2(node.ay, node.ax);
    return a < 0 ? a + Math.PI * 2 : a;
}

function planeOrder(nodes, level) {
    return nodes.filter((node) => node.level === level).sort((a, b) => angleOf(a) - angleOf(b) || Math.hypot(a.ax, a.ay) - Math.hypot(b.ax, b.ay));
}

/**
 * The command a key means on the atlas stage, or null when the key is not the view's.
 *
 * @param {{key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
 * @param {{nodes: object[], selected: string|null, solo: number|null}} view
 */
export function atlasKeyCommand(event, { nodes = [], selected = null, solo = null } = {}) {
    if (event.altKey || event.ctrlKey || event.metaKey) return null;
    const current = selected === null ? null : nodes.find((node) => node.id === selected) || null;
    switch (event.key) {
        case 'ArrowLeft': return { type: 'orbit', radians: 0.12 };
        case 'ArrowRight': return { type: 'orbit', radians: -0.12 };
        case 'ArrowUp': return { type: 'tilt', radians: 0.08 };
        case 'ArrowDown': return { type: 'tilt', radians: -0.08 };
        case '+':
        case '=': return { type: 'zoom', direction: 'in' };
        case '-':
        case '_': return { type: 'zoom', direction: 'out' };
        case '0':
        case 'Home': return { type: 'reset' };
        case '1':
        case '2':
        case '3': {
            const level = Number(event.key) - 1;
            return { type: 'solo', level: solo === level ? null : level };
        }
        case 'PageUp': {
            const target = current && current.parent ? current.parent : planeOrder(nodes, 0)[0]?.id;
            return target ? { type: 'select', id: target } : null;
        }
        case 'PageDown': {
            const target = current ? (current.entity === 'genre' ? planeOrder(nodes.filter((node) => current.children.includes(node.id)), 1)[0]?.id : null) : planeOrder(nodes, 0)[0]?.id;
            return target ? { type: 'select', id: target } : null;
        }
        case '[':
        case ']': {
            const list = planeOrder(nodes, current ? current.level : solo ?? 0);
            if (!list.length) return null;
            const at = current ? list.findIndex((node) => node.id === current.id) : -1;
            const step = event.key === ']' ? 1 : list.length - 1;
            return { type: 'select', id: list[at < 0 ? (event.key === ']' ? 0 : list.length - 1) : (at + step) % list.length].id };
        }
        case 'Escape': return current ? { type: 'select', id: null } : solo !== null ? { type: 'solo', level: null } : null;
        default: return null;
    }
}

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function chip(doc, stage, text = stageWord(stage)) {
    return el(doc, 'span', `atlas-chip atlas-stage--${stage || 'none'}`, text);
}

function percent(share) {
    return `${Math.round(share * 100)}%`;
}

function plural(count, one, many = `${one}s`) {
    return `${count} ${count === 1 ? one : many}`;
}

function yearOf(at) {
    return at === null ? null : new Date(at).getUTCFullYear();
}

/** The years a taste entry's states were first and last recorded, as words, or null when none were. */
export function recordedWords(item) {
    const times = ['owned', 'wanted'].flatMap((state) => {
        const recorded = item.recordedAt[state];
        return recorded ? [recorded.first, recorded.last].filter((at) => at !== null) : [];
    });
    if (!times.length) return null;
    const first = yearOf(Math.min(...times));
    const last = yearOf(Math.max(...times));
    return first === last ? `recorded in ${first}` : `first recorded in ${first}, last in ${last}`;
}

/**
 * The Genre Atlas view. It builds its own DOM; `mount(host)` puts it in a pane. Every dependency
 * is injectable for tests.
 */
export class GenreAtlas {
    constructor({
        doc = globalThis.document,
        api = globalThis.apiClient,
        createRenderer = null,
        setTimer = (fn, ms) => globalThis.setInterval(fn, ms),
        clearTimer = (handle) => globalThis.clearInterval(handle),
        observeTheme = true,
        masterSlot = atlasMasterSlot,
        cotagSource,
        auth = globalThis.authManager,
    } = {}) {
        this.doc = doc;
        // The signed-in collector's projection (strata-taste.js), or null. `tasteStatus` is
        // `anonymous`, `loading`, `failed`, `empty`, or `ready`; `tasteYear` is the "recorded as of"
        // year, null for now; `tastePlaced` is what withCollectorMasters drew and did not.
        this.auth = auth || null;
        this.taste = null;
        this.tasteStatus = 'anonymous';
        this.tasteYear = null;
        this.tastePlaced = null;
        this.tasteMarked = null;
        this.tasteRequest = 0;
        // The Fit landing point (strata-fit.js planLanding), or null; `landingShown` is whether the
        // view is in the pane that draws it; `landingPlaced` is what placeLanding drew and did not.
        this.landing = null;
        this.landingShown = false;
        this.landingPlaced = null;
        // Co-tagged styles for the selected style: `async (style) => [{other, release_count, rank}]`,
        // `GET /api/insights/style-atlas/cotags?style=<name>` by default. It rejects when the read
        // fails. With no source (an api that has none, or null), the panel says none are served.
        this.cotagSource = cotagSource === undefined ? (typeof api?.getStyleCotags === 'function' ? (style) => this.api.getStyleCotags(style) : null) : cotagSource;
        this.cotags = new Map();
        // Styles whose last co-tag read failed (not cached, so selecting the style again retries),
        // and the reads in flight (so a quick reselect does not fetch twice).
        this.cotagFailures = new Set();
        this.cotagReads = new Set();
        // The landmark master slot rule (strata-atlas-layout.js layoutAtlas): each master in a
        // deterministic slot of its style's cell (strata-master-slots.js).
        this.masterSlot = masterSlot;
        this.api = api;
        this.createRenderer = createRenderer || ((stage) => new AtlasRenderer(stage, { cotags: (style) => this.cotags.get(style) || [] }));
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.atlas = null;
        this.layout = null;
        this.byId = new Map();
        this.year = null;
        this.selected = null;
        this.solo = null;
        this.renderer = null;
        this.active = false;
        this.loading = null;
        this.playHandle = null;
        this.mode = 'strata';
        this.build();
        this.table = new AtlasTable({
            doc,
            host: this.ui.table,
            helpId: 'atlasTableHelp',
            onSelect: (id) => this.selectNode(id),
            onStatus: (text) => {
                this.ui.tableStatus.textContent = text;
            },
        });
        if (observeTheme && typeof MutationObserver === 'function') {
            this.themeObserver = new MutationObserver(() => this.renderer?.refreshColors());
            this.themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
        }
        this.authUnsubscribe = typeof this.auth?.onChange === 'function' ? this.auth.onChange((signedIn) => this.onAuthChange(signedIn)) : null;
        this.renderTaste();
    }

    // -----------------------------------------------------------------------------------------
    // DOM.
    // -----------------------------------------------------------------------------------------

    build() {
        const { doc } = this;
        const root = el(doc, 'section', 'atlas');
        root.setAttribute('aria-labelledby', 'atlasTitle');
        const head = el(doc, 'header', 'atlas-head');
        const title = el(doc, 'h3', 'atlas-title', 'Genre Atlas');
        title.id = 'atlasTitle';
        const summary = el(doc, 'p', 'atlas-summary');
        summary.id = 'atlasSummary';
        head.append(title, summary);

        const toolbar = el(doc, 'div', 'atlas-toolbar');
        const time = el(doc, 'div', 'atlas-time');
        const label = el(doc, 'label', 'atlas-time-label', 'Music as of');
        label.htmlFor = 'atlasYear';
        const range = el(doc, 'input', 'atlas-year');
        range.type = 'range';
        range.id = 'atlasYear';
        range.disabled = true;
        range.setAttribute('aria-describedby', 'atlasYearNote');
        const output = el(doc, 'output', 'atlas-year-value');
        output.htmlFor = 'atlasYear';
        const note = el(doc, 'span', 'atlas-provisional-badge', 'provisional');
        note.id = 'atlasYearNote';
        note.hidden = true;
        const strip = el(doc, 'ol', 'atlas-years');
        strip.setAttribute('aria-hidden', 'true');
        const track = el(doc, 'div', 'atlas-track');
        track.append(range, strip);
        const play = el(doc, 'button', 'strata-tool-btn atlas-play', 'Play');
        play.type = 'button';
        play.disabled = true;
        play.setAttribute('aria-pressed', 'false');
        time.append(label, track, output, note, play);

        // Transaction time for the collector's layer: hidden until a signed-in projection with
        // recorded times arrives. The top of the range is now.
        const recorded = el(doc, 'div', 'atlas-time atlas-recorded');
        recorded.hidden = true;
        const recordedLabel = el(doc, 'label', 'atlas-time-label', 'Your items recorded as of');
        recordedLabel.htmlFor = 'atlasRecorded';
        const recordedRange = el(doc, 'input', 'atlas-recorded-year');
        recordedRange.type = 'range';
        recordedRange.id = 'atlasRecorded';
        recordedRange.step = '1';
        recordedRange.setAttribute('aria-describedby', 'atlasRecordedNote');
        const recordedOutput = el(doc, 'output', 'atlas-recorded-value');
        recordedOutput.htmlFor = 'atlasRecorded';
        recorded.append(recordedLabel, recordedRange, recordedOutput);

        const planes = el(doc, 'div', 'strata-planes');
        planes.setAttribute('role', 'group');
        planes.setAttribute('aria-label', 'Planes');
        const planeButtons = [null, 0, 1, 2].map((level) => {
            const button = el(doc, 'button', 'strata-tool-btn', level === null ? 'All planes' : ATLAS_PLANES[level]);
            button.type = 'button';
            button.dataset.atlasSolo = level === null ? '' : String(level);
            button.setAttribute('aria-pressed', String(level === null));
            planes.append(button);
            return button;
        });
        const reset = el(doc, 'button', 'strata-tool-btn', 'Reset view');
        reset.type = 'button';
        // The 3D view or the table: the same atlas, the same scrubber, selection, and panel.
        const views = el(doc, 'div', 'strata-planes atlas-views');
        views.setAttribute('role', 'group');
        views.setAttribute('aria-label', 'Atlas view');
        const viewButtons = [['strata', '3D view'], ['table', 'Table']].map(([view, text]) => {
            const button = el(doc, 'button', 'strata-tool-btn', text);
            button.type = 'button';
            button.dataset.atlasView = view;
            button.setAttribute('aria-pressed', String(view === 'strata'));
            views.append(button);
            return button;
        });
        toolbar.append(time, recorded, views, planes, reset);

        const body = el(doc, 'div', 'atlas-body');
        const stageWrap = el(doc, 'div', 'atlas-stage-wrap');
        const stage = el(doc, 'div', 'atlas-stage');
        stage.tabIndex = 0;
        stage.setAttribute('role', 'application');
        stage.setAttribute('aria-label', 'Genre Atlas: genres, styles, and landmark masters on three planes, colored by lifecycle stage');
        stage.setAttribute('aria-describedby', 'atlasKeyHelp');
        const help = el(doc, 'p', 'strata-sr-only', ATLAS_KEY_HELP);
        help.id = 'atlasKeyHelp';
        const message = el(doc, 'p', 'atlas-message');
        message.setAttribute('role', 'alert');
        message.hidden = true;
        const tableWrap = el(doc, 'div', 'strata-table-wrap atlas-table-wrap');
        tableWrap.hidden = true;
        const tableBar = el(doc, 'div', 'strata-table-toolbar');
        const tableStatus = el(doc, 'p', 'strata-table-status');
        tableStatus.setAttribute('role', 'status');
        const tableNote = el(doc, 'p', 'strata-table-status atlas-table-note');
        tableBar.append(tableStatus, tableNote);
        const table = el(doc, 'div', 'strata-table-scroll');
        const tableHelp = el(doc, 'p', 'strata-sr-only', ATLAS_TABLE_HELP);
        tableHelp.id = 'atlasTableHelp';
        tableWrap.append(tableBar, table, tableHelp);
        stageWrap.append(stage, help, message, tableWrap);

        const panel = el(doc, 'aside', 'atlas-panel');
        panel.setAttribute('aria-label', 'Genre Atlas details');
        const rule = el(doc, 'section', 'atlas-rule');
        rule.setAttribute('aria-label', 'Stage rule');
        const legend = el(doc, 'ul', 'strata-legend atlas-legend');
        legend.setAttribute('aria-label', 'Legend');
        const selection = el(doc, 'div', 'atlas-selection');
        selection.setAttribute('aria-live', 'polite');
        const taste = el(doc, 'section', 'atlas-taste');
        taste.setAttribute('aria-label', 'Your collection');
        const landing = el(doc, 'section', 'atlas-landing');
        landing.setAttribute('aria-label', 'Fit landing point');
        landing.hidden = true;
        panel.append(landing, selection, taste, legend, rule);
        body.append(stageWrap, panel);
        root.append(head, toolbar, body);

        this.root = root;
        this.ui = { summary, range, output, note, strip, play, planeButtons, reset, stage, help, message, rule, legend, selection, taste, landing, recorded, recordedRange, recordedOutput, viewButtons, tableWrap, table, tableStatus, tableNote, stageOnly: [planes, reset] };
        recordedRange.addEventListener('input', () => this.setTasteYear(Number(recordedRange.value)));
        range.addEventListener('input', () => this.setYear(Number(range.value)));
        play.addEventListener('click', () => (this.playHandle === null ? this.play() : this.pause()));
        for (const button of planeButtons) button.addEventListener('click', () => this.setSolo(button.dataset.atlasSolo === '' ? null : Number(button.dataset.atlasSolo)));
        reset.addEventListener('click', () => this.renderer?.resetCamera());
        for (const button of viewButtons) button.addEventListener('click', () => this.setMode(button.dataset.atlasView));
        stage.addEventListener('keydown', (event) => this.handleKey(event));
    }

    /** Put the view in a pane's mount point. It keeps its state, layout, and renderer. */
    mount(host) {
        if (host && this.root.parentNode !== host) host.append(this.root);
    }

    // -----------------------------------------------------------------------------------------
    // Lifecycle.
    // -----------------------------------------------------------------------------------------

    /** Show the view: load the atlas once, and start the renderer's frame loop. */
    show() {
        this.active = true;
        if (this.layout) this.startRenderer();
        if (!this.atlas && !this.loading) this.loading = this.load().finally(() => (this.loading = null));
        return this.loading || Promise.resolve();
    }

    /** Stop the frame loop and the timeline while neither pane is on screen. */
    hide() {
        this.active = false;
        this.pause();
        this.renderer?.stop();
    }

    async load() {
        this.showMessage(null);
        this.ui.summary.textContent = 'Loading the Genre Atlas...';
        let answer;
        try {
            answer = await this.api.getStyleAtlas();
        } catch {
            answer = { ok: false, status: 0, body: null };
        }
        if (!answer.ok) {
            this.ui.summary.textContent = '';
            this.showMessage(atlasErrorMessage(answer.status));
            return;
        }
        let atlas;
        try {
            atlas = adaptAtlasPayload(answer.body);
        } catch {
            this.ui.summary.textContent = '';
            this.showMessage('The Genre Atlas answered with data this view cannot read.');
            return;
        }
        this.setAtlas(atlas);
        if (!atlas.empty && this.signedIn()) await this.loadTaste();
    }

    /** Draw an adapted atlas, or say there is none yet. The rule is shown either way. */
    setAtlas(atlas) {
        this.atlas = atlas;
        this.renderRule(atlas.rule);
        if (atlas.empty) {
            this.layout = null;
            this.byId = new Map();
            this.ui.summary.textContent = 'No monthly run yet.';
            this.showMessage(EMPTY_MESSAGE);
            this.setTimelineEnabled(false);
            this.renderLegend();
            this.renderSelection();
            this.renderTable();
            this.renderLanding();
            return;
        }
        this.year = atlas.timeline.lastYear;
        this.relayout();
        this.renderSummary();
        this.renderTimeline();
        this.setTimelineEnabled(true);
        this.showMessage(null);
        if (this.active) this.startRenderer();
        this.renderLegend();
        this.renderSelection();
        this.renderTable();
        this.renderLanding();
    }

    /**
     * Lay the atlas out again, with the collector's masters when there is a projection, and paint
     * both the valid-time stages and the collector's marks. Served positions never change; only the
     * master plane gains or loses the collector's masters.
     */
    relayout() {
        const { atlas } = this;
        this.tastePlaced = this.taste ? withCollectorMasters(atlas, this.taste) : null;
        this.layout = layoutAtlas(this.tastePlaced ? this.tastePlaced.atlas : atlas, { masterSlot: this.masterSlot });
        this.byId = new Map(this.layout.nodes.map((node) => [node.id, node]));
        paintAtlas(this.layout, this.year);
        this.tasteMarked = paintTaste(this.layout, this.taste, this.tasteYear);
        this.landingPlaced = this.landing && this.landingShown ? placeLanding(this.layout, this.landing) : null;
        paintLanding(this.layout, this.landingPlaced);
        if (this.selected && !this.byId.has(this.selected)) this.selected = null;
    }

    startRenderer() {
        // The table builds no renderer, so it opens where WebGL does not.
        if (this.mode === 'table') return;
        if (!this.renderer) {
            try {
                this.renderer = this.createRenderer(this.ui.stage);
            } catch {
                this.showMessage(NO_WEBGL);
                return;
            }
            this.renderer.addEventListener('select', (event) => this.onSelect(event.detail.id));
            this.renderer.addEventListener('solo', (event) => this.onSolo(event.detail.level));
            this.renderer.setYear(this.year);
            this.renderer.setLayout(this.layout);
            // A selection made in the table before the 3D view was first shown.
            if (this.selected) this.renderer.select(this.selected);
        }
        this.renderer.start();
        this.renderer.resize?.();
    }

    dispose() {
        this.pause();
        this.themeObserver?.disconnect();
        this.authUnsubscribe?.();
        this.renderer?.dispose();
        this.renderer = null;
        this.root.remove();
    }

    // -----------------------------------------------------------------------------------------
    // Taste Strata: the signed-in collector's layer.
    // -----------------------------------------------------------------------------------------

    signedIn() {
        return !!this.auth?.isLoggedIn?.() && typeof this.api?.getTasteProjection === 'function';
    }

    /** Sign-in loads the layer; sign-out drops it, and the projection with it. */
    onAuthChange(signedIn) {
        if (signedIn && this.signedIn()) {
            if (this.atlas && !this.atlas.empty && !this.taste && this.tasteStatus !== 'loading') this.loadTaste();
        } else {
            this.setTaste(null, 'anonymous');
            // A landing point is a statement about the collector's shelves, so it goes with them.
            this.setLanding(null);
        }
    }

    /** Fetch the caller's projection and lay it on the atlas. A later sign-out drops a late answer. */
    async loadTaste() {
        const request = ++this.tasteRequest;
        this.tasteStatus = 'loading';
        this.renderTaste();
        let answer;
        try {
            answer = await this.api.getTasteProjection(this.auth.getToken());
        } catch {
            answer = { ok: false, status: 0, body: null };
        }
        if (request !== this.tasteRequest) return;
        if (!answer.ok) {
            // A 401 is a stale session (the client signs it out): the visitor is anonymous.
            this.setTaste(null, answer.status === 401 || !this.signedIn() ? 'anonymous' : 'failed');
            return;
        }
        let taste;
        try {
            taste = adaptTasteProjection(answer.body);
        } catch {
            this.setTaste(null, 'failed');
            return;
        }
        if (taste.totals.items) this.setTaste(taste, 'ready');
        else this.setTaste(null, 'empty');
    }

    /** Put a projection on the atlas, or take it off, and redraw everything that shows it. */
    setTaste(taste, status) {
        if (!taste) this.tasteRequest++;
        this.taste = taste;
        this.tasteStatus = status;
        this.tasteYear = null;
        if (this.layout) {
            this.relayout();
            this.renderer?.setLayout(this.layout);
            this.renderLegend();
            this.renderSelection();
            this.renderTable();
        }
        this.renderRecorded();
        this.renderTaste();
        this.renderLanding();
    }

    /** Scrub transaction time: the marks follow when each item was first recorded. Nothing moves. */
    setTasteYear(year) {
        const years = this.taste ? recordedYears(this.taste) : null;
        if (!years || !this.layout) return;
        const at = Math.min(years.last + 1, Math.max(years.first, Math.round(year)));
        this.tasteYear = at > years.last ? null : at;
        this.tasteMarked = paintTaste(this.layout, this.taste, this.tasteYear);
        this.renderer?.refreshTaste?.();
        this.renderRecorded();
        this.renderSelection();
        this.renderTable();
        this.renderTaste();
    }

    renderRecorded() {
        const { recorded, recordedRange, recordedOutput } = this.ui;
        const years = this.taste && this.layout ? recordedYears(this.taste) : null;
        recorded.hidden = !years;
        if (!years) return;
        const now = this.tasteYear === null;
        recordedRange.min = String(years.first);
        recordedRange.max = String(years.last + 1);
        recordedRange.value = String(now ? years.last + 1 : this.tasteYear);
        recordedOutput.textContent = now ? 'now' : String(this.tasteYear);
        recordedRange.setAttribute('aria-valuetext', now ? 'now, everything you hold' : `the end of ${this.tasteYear}`);
    }

    /** The panel's collector section: the sign-in hint, or what is drawn and what is only counted. */
    renderTaste() {
        const { doc } = this;
        const box = this.ui.taste;
        box.textContent = '';
        box.dataset.tasteStatus = this.tasteStatus;
        const hint = (text) => box.append(el(doc, 'p', 'strata-hint atlas-taste-hint', text));
        if (this.tasteStatus === 'anonymous') return hint(TASTE_SIGN_IN);
        if (this.tasteStatus === 'loading') return hint('Loading your collection...');
        if (this.tasteStatus === 'failed') return hint(TASTE_FAILED);
        if (this.tasteStatus === 'empty') return hint(TASTE_EMPTY);
        const { totals } = this.taste;
        box.append(el(doc, 'h4', 'atlas-taste-title', 'Your collection'));
        box.append(el(doc, 'p', 'strata-selection-facts', `${plural(totals.items, 'item')}: ${totals.owned} owned, ${totals.wanted} wanted, ${totals.wantedOwned} in both.`));
        if (!this.layout) return;
        const marked = this.tasteMarked;
        const placed = this.tastePlaced;
        const drawnStyles = new Set(this.atlas.styles.map((style) => style.style));
        const offAtlas = [...this.taste.styles.keys()].filter((style) => !drawnStyles.has(style)).length;
        const lines = [
            `${this.tasteYear === null ? 'Marked' : `Recorded by the end of ${this.tasteYear}`}: ${plural(marked.genres, 'genre')}, ${plural(marked.styles, 'style')}, and ${plural(marked.masters + marked.collectors, 'master')} (${marked.masters} of them landmarks).`,
            `${plural(totals.masterlessItems, 'item has', 'items have')} no master, so ${totals.masterlessItems === 1 ? 'it is' : 'they are'} counted here and not drawn.`,
            totals.genreOnlyItems ? `${plural(totals.genreOnlyItems, 'item carries', 'items carry')} a genre and no style, so ${totals.genreOnlyItems === 1 ? 'it marks' : 'they mark'} a genre only.` : null,
            totals.unplacedItems ? `${plural(totals.unplacedItems, 'item carries', 'items carry')} no genre, so ${totals.unplacedItems === 1 ? 'it is' : 'they are'} not on the atlas.` : null,
            offAtlas ? `${plural(offAtlas, 'of your styles is', 'of your styles are')} not drawn on this atlas.` : null,
            placed && placed.notDrawn ? `${plural(placed.notDrawn, 'of your masters has', 'of your masters have')} no style drawn here, so ${placed.notDrawn === 1 ? 'it is' : 'they are'} not placed.` : null,
        ].filter(Boolean);
        for (const line of lines) box.append(el(doc, 'p', 'strata-selection-facts', line));
        const legend = el(doc, 'ul', 'strata-legend atlas-taste-legend');
        legend.setAttribute('aria-label', 'Your styles by collector state');
        const counts = heldCounts(this.layout);
        for (const state of COLLECTOR_STATES.filter((name) => name !== 'none')) {
            const item = el(doc, 'li');
            item.append(el(doc, 'span', `strata-chip strata-chip--${state}`, `${stateLabel(state)} ${counts.get(state) || 0}`));
            legend.append(item);
        }
        box.append(legend);
        box.append(el(doc, 'p', 'atlas-rule-note', 'A ring in the state\'s color marks a genre, style, or landmark master you hold; your other masters are drawn in that color on the master plane, in their dominant style\'s cell.'));
        const note = el(doc, 'p', 'atlas-rule-note', recordedYears(this.taste) ? TASTE_AS_OF_NOTE : 'Discogs recorded no dates for your items, so they cannot be scrubbed by when they were recorded.');
        note.id = 'atlasRecordedNote';
        box.append(note);
    }

    /** The selected node's line about the collector, when it is theirs. */
    renderHeld(box, node) {
        const { doc } = this;
        if (node.held) {
            const { state, items, owned, wanted } = node.held;
            const line = el(doc, 'p', 'strata-selection-facts atlas-held');
            line.append(el(doc, 'span', `strata-chip strata-chip--${state}`, 'Yours'), doc.createTextNode(` ${plural(items, 'item')} · ${owned} owned · ${wanted} wanted`));
            const item = this.tasteItem(node);
            const when = item ? recordedWords(item) : null;
            if (when) line.append(doc.createTextNode(` · ${when}`));
            box.append(line);
        } else if (node.heldLater) {
            box.append(el(doc, 'p', 'strata-selection-facts atlas-held', `Yours, but first recorded after ${this.tasteYear}.`));
        }
    }

    tasteItem(node) {
        if (!this.taste) return null;
        if (node.entity === 'genre') return this.taste.genres.get(node.genre) ?? null;
        if (node.entity === 'master') return this.taste.byMaster.get(node.master.masterId) ?? null;
        return this.taste.styles.get(node.style) ?? null;
    }

    // -----------------------------------------------------------------------------------------
    // The Fit landing point.
    // -----------------------------------------------------------------------------------------

    /**
     * Put a "Will it fit?" profile's landing point on the atlas, or take it off with null. It is
     * drawn while the view is in the Fit pane (setLandingShown) and kept, not drawn, elsewhere.
     *
     * @param {object | null} profile - a `GET /api/fit/release/{id}` body
     */
    setLanding(profile) {
        this.landing = planLanding(profile);
        this.refreshLanding();
    }

    /** Draw the landing point (the view is in the Fit pane) or keep it off the atlas. */
    setLandingShown(shown) {
        if (this.landingShown === !!shown) return;
        this.landingShown = !!shown;
        this.refreshLanding();
    }

    /** Mark the landing on the layout and redraw what shows it. Nothing moves. */
    refreshLanding() {
        if (this.layout) {
            this.landingPlaced = this.landing && this.landingShown ? placeLanding(this.layout, this.landing) : null;
            paintLanding(this.layout, this.landingPlaced);
            this.renderer?.refreshLanding?.();
            this.renderSelection();
        } else this.landingPlaced = null;
        this.renderLanding();
    }

    /**
     * The panel's landing section: the candidate, what is drawn and how, and everything listed
     * beside the map instead (Depth, artists and labels, and whatever this atlas cannot place),
     * each with its component.
     */
    renderLanding() {
        const { doc } = this;
        const box = this.ui.landing;
        box.textContent = '';
        const plan = this.landingShown ? this.landing : null;
        box.hidden = !plan;
        if (!plan) return;
        const placed = this.landingPlaced || placeLanding(null, plan);
        box.append(el(doc, 'h4', 'atlas-taste-title', 'Landing point'));
        box.append(el(doc, 'p', 'strata-selection-facts atlas-landing-release', [plan.release.title || plan.release.id, plan.release.artist].filter(Boolean).join(' · ')));
        if (!plan.structured) box.append(el(doc, 'p', 'strata-hint atlas-landing-fallback', LANDING_FALLBACK));
        if (placed.drawn.length) {
            box.append(el(doc, 'p', 'atlas-parents-title', 'Drawn on the atlas'));
            const list = el(doc, 'ul', 'atlas-landing-list atlas-landing-list--drawn');
            for (const { component, text } of placed.drawn) {
                const item = el(doc, 'li');
                item.dataset.component = component;
                item.append(el(doc, 'span', `atlas-chip atlas-fit--${component}`, FIT_LABELS[component]), doc.createTextNode(` ${text}`));
                list.append(item);
            }
            box.append(list, el(doc, 'p', 'atlas-rule-note', LANDING_KEY));
        }
        const order = (entry) => FIT_COMPONENTS.indexOf(entry.component);
        const listed = [...plan.listed, ...placed.notDrawn].sort((a, b) => order(a) - order(b));
        if (listed.length) {
            box.append(el(doc, 'p', 'atlas-parents-title', 'Listed, not on the map'));
            const list = el(doc, 'ul', 'atlas-landing-list atlas-landing-list--listed');
            for (const { component, text, reason } of listed) {
                const item = el(doc, 'li');
                item.dataset.component = component;
                item.append(el(doc, 'span', 'atlas-landing-component', FIT_LABELS[component]), doc.createTextNode(` ${text}${reason ? ` (${reason})` : ''}`));
                list.append(item);
            }
            box.append(list);
        }
        if (!placed.drawn.length && !listed.length) box.append(el(doc, 'p', 'strata-hint', 'The profile names nothing to draw or list.'));
    }

    /** The selected node's line about the landing point, when the candidate lands on it. */
    renderLandingMark(box, node) {
        if (!node.landing || !this.landing) return;
        const title = this.landing.release.title || this.landing.release.id;
        const line = el(this.doc, 'p', 'strata-selection-facts atlas-landing-mark');
        line.append(el(this.doc, 'span', `atlas-chip atlas-fit--${node.landing}`, FIT_LABELS[node.landing]), this.doc.createTextNode(` ${title}: ${FIT_MARK_WORDS[node.landing]}`));
        box.append(line);
    }

    // -----------------------------------------------------------------------------------------
    // Valid time.
    // -----------------------------------------------------------------------------------------

    renderTimeline() {
        const { range, strip } = this.ui;
        const { timeline } = this.atlas;
        range.min = String(timeline.firstYear);
        range.max = String(timeline.lastYear);
        range.step = '1';
        range.value = String(this.year);
        strip.textContent = '';
        for (let year = timeline.firstYear; year <= timeline.lastYear; year++) {
            const cell = el(this.doc, 'li', isProvisional(timeline, year) ? 'atlas-year-cell atlas-year-cell--provisional' : 'atlas-year-cell');
            cell.dataset.year = String(year);
            strip.append(cell);
        }
        this.renderYear();
    }

    setTimelineEnabled(enabled) {
        this.ui.range.disabled = !enabled;
        this.ui.play.disabled = !enabled;
    }

    renderYear() {
        const { range, output, note } = this.ui;
        const provisional = isProvisional(this.atlas.timeline, this.year);
        range.value = String(this.year);
        output.textContent = String(this.year);
        output.classList.toggle('atlas-year-value--provisional', provisional);
        note.hidden = !provisional;
        range.setAttribute('aria-valuetext', provisional ? `${this.year}, provisional` : String(this.year));
    }

    /** Scrub valid time. Stages repaint; no node moves. */
    setYear(year) {
        if (!this.layout) return;
        this.year = clampYear(this.atlas.timeline, year);
        paintAtlas(this.layout, this.year);
        this.renderer?.setYear(this.year);
        this.renderYear();
        this.renderLegend();
        this.renderSelection();
        this.renderTable();
    }

    /** Run the timeline a year at a time from its start (or from the scrubbed year) to its end. */
    play() {
        if (!this.layout || this.playHandle !== null) return;
        if (this.year >= this.atlas.timeline.lastYear) this.setYear(this.atlas.timeline.firstYear);
        this.ui.play.textContent = 'Pause';
        this.ui.play.setAttribute('aria-pressed', 'true');
        this.playHandle = this.setTimer(() => {
            if (this.year >= this.atlas.timeline.lastYear) this.pause();
            else this.setYear(this.year + 1);
        }, PLAY_STEP_MS);
    }

    pause() {
        if (this.playHandle === null) return;
        this.clearTimer(this.playHandle);
        this.playHandle = null;
        this.ui.play.textContent = 'Play';
        this.ui.play.setAttribute('aria-pressed', 'false');
    }

    // -----------------------------------------------------------------------------------------
    // Selection, solo, and keys.
    // -----------------------------------------------------------------------------------------

    selectNode(id) {
        if (this.renderer) this.renderer.select(id);
        else this.onSelect(id);
    }

    onSelect(id) {
        this.selected = id;
        this.table.select(this.tableRowId(id));
        this.renderSelection();
        const primary = id ? primaryOf(this.byId, id) : null;
        if (primary) this.loadCotags(primary.style);
    }

    /** The table row that stands for a node: a ghost's is its style's; a master has none. */
    tableRowId(id) {
        const node = id ? this.byId.get(id) : null;
        if (!node || node.entity === 'master') return null;
        return node.entity === 'ghost' ? node.ghostOf : node.id;
    }

    /** Show the atlas as the 3D view or as the table. The table builds no renderer. */
    setMode(mode) {
        const next = mode === 'table' ? 'table' : 'strata';
        const table = next === 'table';
        const { ui } = this;
        this.mode = next;
        for (const button of ui.viewButtons) button.setAttribute('aria-pressed', String(button.dataset.atlasView === next));
        ui.stage.hidden = table;
        ui.help.hidden = table;
        ui.tableWrap.hidden = !table;
        for (const item of ui.stageOnly) item.hidden = table;
        if (table) {
            this.renderer?.stop();
            // Notes about the 3D view's planes and canvas do not belong over the table.
            if ([NO_MASTERS, NO_MASTER_SLOTS, NO_WEBGL].includes(ui.message.textContent)) this.showMessage(null);
            this.renderTable();
        } else if (this.active && this.layout) {
            this.startRenderer();
            this.onSolo(this.solo);
        }
        return next;
    }

    renderTable() {
        if (this.mode !== 'table') return;
        const { layout, ui } = this;
        this.table.setRows(layout ? buildAtlasRows(layout, { year: this.tasteYear }) : [], { year: layout ? this.year : null, selected: this.tableRowId(this.selected), yours: !!this.taste });
        // The master plane is empty until masters are served; the table has no plane to say so.
        const plane = layout ? layout.planes[2] : null;
        ui.tableNote.textContent = plane && plane.note ? `Masters: ${this.atlas.masters?.length ? 'not placed yet' : 'none served'}. ${plane.note}` : '';
    }

    /** Fetch a style's co-tags once, then redraw its star and the panel if it is still selected. */
    async loadCotags(style) {
        if (!this.cotagSource || this.cotags.has(style) || this.cotagReads.has(style)) return;
        this.cotagReads.add(style);
        this.cotagFailures.delete(style);
        try {
            const entries = await this.cotagSource(style);
            if (!Array.isArray(entries)) throw new Error('co-tags are not a list');
            this.cotags.set(style, entries);
        } catch {
            this.cotagFailures.add(style);
        } finally {
            this.cotagReads.delete(style);
        }
        const primary = this.selected ? primaryOf(this.byId, this.selected) : null;
        if (primary?.style !== style) return;
        this.renderer?.refreshLateral?.();
        this.renderSelection();
    }

    setSolo(level) {
        if (this.renderer) this.renderer.solo(level);
        else this.onSolo(level);
    }

    onSolo(level) {
        this.solo = level;
        for (const button of this.ui.planeButtons) button.setAttribute('aria-pressed', String((button.dataset.atlasSolo === '' ? null : Number(button.dataset.atlasSolo)) === level));
        // Soloing an empty master plane says why it is empty.
        const note = this.layout?.planes[2].note ?? null;
        if (level === 2 && note) this.showMessage(note, { quiet: true });
        else if ([NO_MASTERS, NO_MASTER_SLOTS].includes(this.ui.message.textContent)) this.showMessage(null);
    }

    handleKey(event) {
        const command = atlasKeyCommand(event, { nodes: this.layout ? this.layout.nodes : [], selected: this.selected, solo: this.solo });
        if (!command) return;
        event.preventDefault();
        const { renderer } = this;
        if (command.type === 'select') this.selectNode(command.id);
        else if (command.type === 'solo') this.setSolo(command.level);
        else if (!renderer) return;
        else if (command.type === 'orbit') renderer.orbit(command.radians);
        else if (command.type === 'tilt') renderer.tilt(command.radians);
        else if (command.type === 'zoom') renderer.zoom(command.direction);
        else if (command.type === 'reset') renderer.resetCamera();
    }

    // -----------------------------------------------------------------------------------------
    // Panel.
    // -----------------------------------------------------------------------------------------

    showMessage(text, { quiet = false } = {}) {
        const { message } = this.ui;
        message.textContent = text || '';
        message.hidden = !text;
        message.classList.toggle('atlas-message--note', !!text && quiet);
    }

    renderSummary() {
        const { atlas, layout } = this;
        const styles = layout.nodes.filter((node) => node.entity === 'style').length;
        const ghosts = layout.nodes.filter((node) => node.entity === 'ghost').length;
        const month = typeof atlas.month === 'string' ? atlas.month.slice(0, 7) : String(atlas.month);
        this.ui.summary.textContent = `${atlas.genres.length} genres, ${styles} styles, and ${ghosts} ghost copies, laid out for ${month}. Positions are the month's pinned map; scrubbing time moves nothing.`;
    }

    renderRule(rule) {
        const { doc } = this;
        const words = ruleText(rule);
        const box = this.ui.rule;
        box.textContent = '';
        box.append(el(doc, 'h4', 'atlas-rule-title', words.title));
        const list = el(doc, 'dl', 'atlas-rule-stages');
        for (const { stage, condition } of words.stages) {
            const term = el(doc, 'dt');
            term.append(chip(doc, stage));
            list.append(term, el(doc, 'dd', null, condition));
        }
        box.append(list);
        for (const line of words.notes) box.append(el(doc, 'p', 'atlas-rule-note', line));
        const thresholds = el(doc, 'p', 'atlas-rule-thresholds');
        thresholds.append(el(doc, 'span', 'atlas-rule-label', 'Thresholds: '));
        thresholds.append(doc.createTextNode(words.thresholds.map(({ name, value }) => `${name} ${value}`).join(' · ')));
        box.append(thresholds);
        // The full served id is for support, so it is a small line with a tooltip, not a heading.
        const detail = el(doc, 'p', 'atlas-rule-version', `Rule id ${words.version}`);
        detail.title = `The full rule version the server reported: ${words.version}`;
        box.append(detail);
    }

    renderLegend() {
        const { doc } = this;
        const legend = this.ui.legend;
        legend.textContent = '';
        const counts = this.layout ? stageCounts(this.layout) : new Map();
        for (const stage of this.atlas.rule.stages) {
            const item = el(doc, 'li');
            item.append(chip(doc, stage, this.layout ? `${stageWord(stage)} ${counts.get(stage) || 0}` : stageWord(stage)));
            legend.append(item);
        }
        const provisional = el(doc, 'li');
        provisional.append(el(doc, 'span', 'atlas-chip atlas-chip--provisional', 'Provisional year (dashed)'));
        const ghost = el(doc, 'li');
        ghost.append(el(doc, 'span', 'atlas-chip atlas-chip--ghost', 'Ghost copy under another parent'));
        legend.append(provisional, ghost);
    }

    renderSelection() {
        const { doc } = this;
        const box = this.ui.selection;
        box.textContent = '';
        const node = this.selected ? this.byId.get(this.selected) : null;
        if (!this.layout) return;
        if (!node) {
            box.append(el(doc, 'p', 'strata-hint', 'Select a genre or a style to see its lifecycle and parents. A style with several parent genres is drawn once under its dominant parent and as a ghost under each other one.'));
            return;
        }
        if (node.entity === 'genre') this.renderGenre(box, node);
        else if (node.entity === 'master') this.renderMaster(box, node);
        else this.renderStyle(box, node);
    }

    renderGenre(box, node) {
        const { doc } = this;
        const hosted = node.children.map((id) => this.byId.get(id));
        const styles = hosted.filter((child) => child.entity === 'style').length;
        const ghosts = hosted.length - styles;
        box.append(el(doc, 'h4', 'strata-selection-title', node.label));
        box.append(el(doc, 'p', 'strata-selection-plane', 'Genre'));
        box.append(el(doc, 'p', 'strata-selection-facts', node.emergenceYear === null ? 'Has not reached 25 releases.' : `Emerged in ${node.emergenceYear} (25 cumulative releases).`));
        box.append(el(doc, 'p', 'strata-selection-facts', `Its hull holds ${styles} ${styles === 1 ? 'style' : 'styles'} drawn here and ${ghosts} ${ghosts === 1 ? 'ghost copy' : 'ghost copies'} of styles whose dominant parent is another genre.`));
        this.renderHeld(box, node);
        this.renderLandingMark(box, node);
    }

    renderMaster(box, node) {
        const { doc } = this;
        const { master } = node;
        box.append(el(doc, 'h4', 'strata-selection-title', node.label));
        box.append(el(doc, 'p', 'strata-selection-plane', master.collector ? `Your master, in its dominant style ${master.style}` : `Landmark master of ${master.style}`));
        const facts = [master.year === null ? 'No year' : String(master.year), master.releaseCount === null ? null : `${master.releaseCount} releases`, master.rank === null ? null : `rank ${master.rank} in ${master.style}`].filter(Boolean);
        box.append(el(doc, 'p', 'strata-selection-facts', facts.join(' · ')));
        this.renderHeld(box, node);
        this.renderLandingMark(box, node);
    }

    renderStyle(box, node) {
        const { doc, atlas } = this;
        const { timeline, rule } = atlas;
        const primary = primaryOf(this.byId, node.id);
        const style = primary.data;
        box.append(el(doc, 'h4', 'strata-selection-title', style.style));
        box.append(el(doc, 'p', 'strata-selection-plane', node.entity === 'ghost' ? `Style, ghost copy under ${node.genre}. Its primary node is under ${style.genre}.` : `Style, drawn under ${style.genre}, its dominant parent.`));

        const now = el(doc, 'p', 'atlas-stage-line');
        now.append(doc.createTextNode(`In ${this.year}: `), chip(doc, stageAt(style, timeline, rule, this.year)));
        if (isProvisional(timeline, this.year)) now.append(el(doc, 'span', 'atlas-provisional-badge', 'provisional'));
        box.append(now);

        // The latest stage is provisional, so the settled stage stands next to it.
        const latest = el(doc, 'p', 'atlas-stage-line atlas-stage-latest');
        latest.append(doc.createTextNode(`Latest (${timeline.lastYear}): `), chip(doc, style.stage), el(doc, 'span', 'atlas-provisional-badge', 'provisional'));
        latest.append(doc.createTextNode(` · settled (${timeline.provisionalFrom - 1}): `));
        if (style.settledStage) latest.append(chip(doc, style.settledStage));
        else latest.append(doc.createTextNode('before the timeline'));
        box.append(latest);

        box.append(el(doc, 'p', 'strata-selection-facts', style.emergenceYear === null ? 'Has not reached 25 releases, so it has not emerged.' : `Emerged in ${style.emergenceYear} (25 cumulative releases).`));
        this.renderHeld(box, node);
        this.renderLandingMark(box, node);

        box.append(el(doc, 'p', 'atlas-parents-title', 'Parent genres (share of its releases)'));
        const parents = el(doc, 'ul', 'atlas-parents');
        for (const parent of style.parents) {
            const item = el(doc, 'li');
            const drawn = parent.dominant ? 'drawn here' : 'ghost copy';
            const edge = parent.emergenceEdge ? `emerged after ${parent.genre}: emergence edge drawn` : 'no emergence edge';
            const link = el(doc, 'button', 'atlas-link', parent.genre);
            link.type = 'button';
            link.addEventListener('click', () => this.selectNode(genreId(parent.genre)));
            item.append(link, doc.createTextNode(` ${percent(parent.share)} · ${parent.dominant ? 'dominant, ' : ''}${drawn} · ${edge}`));
            parents.append(item);
        }
        box.append(parents);
        this.renderCotags(box, primary);
    }

    /**
     * The selected style's co-tagged styles: those the atlas draws as edges, then those it does not
     * (a pair is drawn only when both styles are nodes here), each best rank first.
     */
    renderCotags(box, primary) {
        const { doc } = this;
        const style = primary.style;
        const cotags = this.cotags.get(style);
        if (!this.cotagSource) box.append(el(doc, 'p', 'strata-hint atlas-cotag-state', NO_COTAGS));
        else if (this.cotagFailures.has(style)) box.append(el(doc, 'p', 'strata-hint atlas-cotag-state', COTAGS_FAILED));
        else if (!cotags) box.append(el(doc, 'p', 'strata-hint atlas-cotag-state', 'Loading co-tagged styles...'));
        else if (!cotags.length) box.append(el(doc, 'p', 'strata-hint atlas-cotag-state', 'No co-tagged styles.'));
        else {
            const { drawn, listed } = splitCotags(this.byId, primary.id, cotags);
            const section = (title, entries, modifier) => {
                if (!entries.length) return;
                box.append(el(doc, 'p', 'atlas-parents-title', title));
                const list = el(doc, 'ol', `atlas-cotags atlas-cotags--${modifier}`);
                for (const entry of entries) {
                    list.append(el(doc, 'li', null, Number.isFinite(entry.release_count) ? `${entry.other} · ${entry.release_count} shared releases` : entry.other));
                }
                box.append(list);
            };
            section('Co-tagged styles (drawn as edges)', drawn, 'drawn');
            section('Also co-tagged, not drawn in this atlas', listed, 'listed');
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Wiring: one view, moved to the Genres, Insights, or Fit pane when one is on screen.
// ---------------------------------------------------------------------------------------------

function bindGenresToggle(doc, atlas) {
    const buttons = [...doc.querySelectorAll('[data-genres-view]')];
    const views = { atlas: doc.getElementById(ATLAS_MOUNTS.genres), tree: doc.getElementById('genreTreeContainer') };
    const choose = (view) => {
        for (const button of buttons) {
            const on = button.dataset.genresView === view;
            button.classList.toggle('active', on);
            button.setAttribute('aria-pressed', String(on));
        }
        if (views.atlas) views.atlas.hidden = view !== 'atlas';
        if (views.tree) views.tree.hidden = view !== 'tree';
        if (view === 'atlas' && doc.getElementById('genresPane')?.classList.contains('active')) {
            atlas.mount(views.atlas);
            atlas.show();
        } else if (view === 'tree') atlas.hide();
    };
    for (const button of buttons) button.addEventListener('click', () => choose(button.dataset.genresView));
}

/**
 * Wire the atlas into the Genres, Insights, and Fit panes. It follows the panes' `active` class
 * and each mount's `hidden` attribute, so the pane switcher in app.js needs no hook: the view
 * mounts in the pane that opens, where its mount is shown (the Genres pane's toggle hides it for
 * the tree, and the Fit pane shows it once a profile has a landing point), and stops its frame
 * loop when none is on screen. The landing point is drawn in the Fit pane only.
 */
export function initGenreAtlas({ doc = globalThis.document, atlas = null } = {}) {
    const panes = Object.keys(ATLAS_MOUNTS).map((pane) => ({ pane, el: doc.getElementById(`${pane}Pane`), mount: doc.getElementById(ATLAS_MOUNTS[pane]) }));
    if (!panes.some(({ el: pane, mount }) => pane && mount)) return null;
    const view = atlas || new GenreAtlas({ doc });
    bindGenresToggle(doc, view);
    const sync = () => {
        const open = panes.find(({ el: paneEl, mount }) => paneEl && mount && paneEl.classList.contains('active') && !mount.hidden);
        if (open) {
            view.setLandingShown(open.pane === LANDING_PANE);
            view.mount(open.mount);
            view.show();
        } else view.hide();
    };
    if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(sync);
        for (const { el: paneEl, mount } of panes) {
            if (paneEl) observer.observe(paneEl, { attributes: true, attributeFilter: ['class'] });
            if (mount) observer.observe(mount, { attributes: true, attributeFilter: ['hidden'] });
        }
    }
    sync();
    return view;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // A module runs after the document is parsed, so the panes exist. Without them this is a no-op.
    window.genreAtlas = initGenreAtlas();
}
