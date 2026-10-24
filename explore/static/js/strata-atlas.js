/**
 * The Genre Atlas: concept B of ADR 0016, genres, styles, and landmark masters on the Strata
 * planes, colored by lifecycle stage over valid time. It opens in the Genres pane (beside the flat
 * genre tree) and in the Insights pane. One view serves both: it moves to whichever of the two is
 * on screen, so there is one renderer and one WebGL context.
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
 *   - the empty month before the first monthly run, and route failures, in words.
 *
 * The DOM is built with createElement and textContent only, and styled through classes in
 * strata-atlas.css, so a `style-src 'self'` policy holds.
 */

import { AtlasRenderer } from './strata-atlas-renderer.js';
import {
    ATLAS_PLANES,
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
    stageAt,
    stageCounts,
} from './strata-atlas-layout.js';

/** The panes the atlas opens in, and the element in each that holds it. */
export const ATLAS_MOUNTS = Object.freeze({ genres: 'genreAtlasMount', insights: 'insightsAtlasMount' });
/** Milliseconds per year while the timeline plays. */
export const PLAY_STEP_MS = 400;
export const ATLAS_KEY_HELP = 'Arrow keys orbit and tilt, plus and minus zoom, 0 resets the camera. 1, 2, and 3 show one plane, and the same key again shows all. [ and ] move along a plane, PageUp moves to the genre a style is drawn under and PageDown to a genre\'s first style, and Escape clears the selection. The year slider scrubs valid time.';

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
        masterSlot = null,
        cotagSource = null,
    } = {}) {
        this.doc = doc;
        // Co-tagged styles for the selected style: `async (style) => [{other, release_count, rank}]`,
        // the planned `GET /api/insights/style-atlas/cotags?style=<name>`. None is served yet, so
        // there is no source, and the panel says so.
        this.cotagSource = cotagSource;
        this.cotags = new Map();
        // The landmark master slot rule (strata-atlas-layout.js layoutAtlas). None exists yet.
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
        this.build();
        if (observeTheme && typeof MutationObserver === 'function') {
            this.themeObserver = new MutationObserver(() => this.renderer?.refreshColors());
            this.themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
        }
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
        toolbar.append(time, planes, reset);

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
        stageWrap.append(stage, help, message);

        const panel = el(doc, 'aside', 'atlas-panel');
        panel.setAttribute('aria-label', 'Genre Atlas details');
        const rule = el(doc, 'section', 'atlas-rule');
        rule.setAttribute('aria-label', 'Stage rule');
        const legend = el(doc, 'ul', 'strata-legend atlas-legend');
        legend.setAttribute('aria-label', 'Legend');
        const selection = el(doc, 'div', 'atlas-selection');
        selection.setAttribute('aria-live', 'polite');
        panel.append(selection, legend, rule);
        body.append(stageWrap, panel);
        root.append(head, toolbar, body);

        this.root = root;
        this.ui = { summary, range, output, note, strip, play, planeButtons, reset, stage, message, rule, legend, selection };
        range.addEventListener('input', () => this.setYear(Number(range.value)));
        play.addEventListener('click', () => (this.playHandle === null ? this.play() : this.pause()));
        for (const button of planeButtons) button.addEventListener('click', () => this.setSolo(button.dataset.atlasSolo === '' ? null : Number(button.dataset.atlasSolo)));
        reset.addEventListener('click', () => this.renderer?.resetCamera());
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
            return;
        }
        this.layout = layoutAtlas(atlas, { masterSlot: this.masterSlot });
        this.byId = new Map(this.layout.nodes.map((node) => [node.id, node]));
        this.year = atlas.timeline.lastYear;
        paintAtlas(this.layout, this.year);
        this.renderSummary();
        this.renderTimeline();
        this.setTimelineEnabled(true);
        this.showMessage(null);
        if (this.active) this.startRenderer();
        this.renderLegend();
        this.renderSelection();
    }

    startRenderer() {
        if (!this.renderer) {
            try {
                this.renderer = this.createRenderer(this.ui.stage);
            } catch {
                this.showMessage('This browser cannot draw the 3D atlas: WebGL is not available.');
                return;
            }
            this.renderer.addEventListener('select', (event) => this.onSelect(event.detail.id));
            this.renderer.addEventListener('solo', (event) => this.onSolo(event.detail.level));
            this.renderer.setYear(this.year);
            this.renderer.setLayout(this.layout);
        }
        this.renderer.start();
        this.renderer.resize?.();
    }

    dispose() {
        this.pause();
        this.themeObserver?.disconnect();
        this.renderer?.dispose();
        this.renderer = null;
        this.root.remove();
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
        this.renderSelection();
        const primary = id ? primaryOf(this.byId, id) : null;
        if (primary) this.loadCotags(primary.style);
    }

    /** Fetch a style's co-tags once, then redraw its star and the panel if it is still selected. */
    async loadCotags(style) {
        if (!this.cotagSource || this.cotags.has(style)) return;
        let entries = [];
        try {
            entries = (await this.cotagSource(style)) || [];
        } catch {
            entries = [];
        }
        this.cotags.set(style, entries);
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
        box.append(el(doc, 'p', 'atlas-rule-version', `Rule version ${words.version}`));
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
    }

    renderMaster(box, node) {
        const { doc } = this;
        const { master } = node;
        box.append(el(doc, 'h4', 'strata-selection-title', node.label));
        box.append(el(doc, 'p', 'strata-selection-plane', `Landmark master of ${master.style}`));
        const facts = [master.year === null ? 'No year' : String(master.year), master.releaseCount === null ? null : `${master.releaseCount} releases`].filter(Boolean);
        box.append(el(doc, 'p', 'strata-selection-facts', facts.join(' · ')));
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
        const cotags = this.cotags.get(style.style);
        if (!this.cotagSource) box.append(el(doc, 'p', 'strata-hint', NO_COTAGS));
        else if (!cotags) box.append(el(doc, 'p', 'strata-hint', 'Loading co-tagged styles...'));
        else if (!cotags.length) box.append(el(doc, 'p', 'strata-hint', 'No co-tagged styles.'));
        else {
            box.append(el(doc, 'p', 'atlas-parents-title', 'Co-tagged styles (drawn as edges)'));
            const list = el(doc, 'ol', 'atlas-parents');
            for (const entry of [...cotags].sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity))) {
                list.append(el(doc, 'li', null, Number.isFinite(entry.release_count) ? `${entry.other} · ${entry.release_count} shared releases` : entry.other));
            }
            box.append(list);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Wiring: one view, moved to the Genres or Insights pane when either is on screen.
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
    return () => (views.atlas ? !views.atlas.hidden : false);
}

/**
 * Wire the atlas into the Genres and Insights panes. It follows the panes' `active` class, so the
 * pane switcher in app.js needs no hook: the view mounts in the pane that opens and stops its
 * frame loop when neither is on screen.
 */
export function initGenreAtlas({ doc = globalThis.document, atlas = null } = {}) {
    const panes = Object.keys(ATLAS_MOUNTS).map((pane) => ({ pane, el: doc.getElementById(`${pane}Pane`), mount: doc.getElementById(ATLAS_MOUNTS[pane]) }));
    if (!panes.some(({ el: pane, mount }) => pane && mount)) return null;
    const view = atlas || new GenreAtlas({ doc });
    const atlasChosen = bindGenresToggle(doc, view);
    const sync = () => {
        const open = panes.find(({ pane, el: paneEl, mount }) => paneEl && mount && paneEl.classList.contains('active') && (pane !== 'genres' || atlasChosen()));
        if (open) {
            view.mount(open.mount);
            view.show();
        } else view.hide();
    };
    if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(sync);
        for (const { el: paneEl } of panes) if (paneEl) observer.observe(paneEl, { attributes: true, attributeFilter: ['class'] });
    }
    sync();
    return view;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // A module runs after the document is parsed, so the panes exist. Without them this is a no-op.
    window.genreAtlas = initGenreAtlas();
}
