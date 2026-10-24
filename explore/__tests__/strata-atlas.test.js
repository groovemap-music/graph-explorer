/**
 * The Genre Atlas view: the empty month, failures, the rule on screen, the scrubber and its
 * provisional treatment, the panel's latest and settled stages, keyboard commands, and the wiring
 * into the Genres and Insights panes. The renderer is a stand-in that records what it is told, so
 * these run without three.js; strata-atlas-renderer.test.js covers the scene.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLAS_KEY_HELP, GenreAtlas, atlasErrorMessage, atlasKeyCommand, initGenreAtlas, stageWord } from '../static/js/strata-atlas.js';
import { COTAGS_FAILED, EMPTY_MESSAGE, NO_COTAGS, NO_MASTERS, adaptAtlasPayload, layoutAtlas } from '../static/js/strata-atlas-layout.js';
import { emptyAtlasPayload } from './strata-atlas-fixtures.js';
import { TASTE_AS_OF_NOTE, TASTE_EMPTY, TASTE_FAILED, TASTE_SIGN_IN } from '../static/js/strata-taste.js';
import { LANDING_FALLBACK, LANDING_NO_ATLAS, LANDING_NO_SLOT, LANDING_NOT_ON_ATLAS } from '../static/js/strata-fit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'style-atlas.json'), 'utf8')).body;
const INDEX = readFileSync(resolve(HERE, '..', 'static', 'index.html'), 'utf8');
const FIT_PROFILE = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'fit-profile.json'), 'utf8')).body;

class StandInRenderer extends EventTarget {
    constructor() {
        super();
        this.calls = [];
        this.years = [];
        this.layout = null;
        this.selected = null;
        this.running = false;
    }
    setLayout(layout) { this.layout = layout; }
    setYear(year) { this.years.push(year); }
    select(id) {
        this.selected = id;
        this.dispatchEvent(new CustomEvent('select', { detail: { id } }));
    }
    solo(level) { this.dispatchEvent(new CustomEvent('solo', { detail: { level } })); }
    start() { this.running = true; }
    stop() { this.running = false; }
    resize() {}
    orbit(r) { this.calls.push(['orbit', r]); }
    tilt(r) { this.calls.push(['tilt', r]); }
    zoom(d) { this.calls.push(['zoom', d]); }
    resetCamera() { this.calls.push(['reset']); }
    refreshColors() { this.calls.push(['colors']); }
    dispose() {}
}

function answer(body, status = 200) {
    return { getStyleAtlas: vi.fn(async () => ({ ok: status >= 200 && status < 300, status, body })) };
}

function makeAtlas({ body = BODY, status = 200, api = answer(body, status) } = {}) {
    let renderer = null;
    const timers = [];
    const atlas = new GenreAtlas({
        doc: document,
        api,
        createRenderer: () => (renderer = new StandInRenderer()),
        setTimer: (fn) => timers.push(fn) - 1,
        clearTimer: (handle) => (timers[handle] = null),
        observeTheme: false,
    });
    document.body.append(atlas.root);
    return { atlas, api, renderer: () => renderer, tick: () => timers.forEach((fn) => fn && fn()) };
}

const text = (atlas) => atlas.root.textContent;

afterEach(() => {
    document.body.textContent = '';
    document.documentElement.className = '';
});

describe('loading', () => {
    it('says there is no monthly run yet, shows the rule anyway, and draws nothing', async () => {
        const { atlas, renderer } = makeAtlas({ body: emptyAtlasPayload() });
        await atlas.show();
        expect(atlas.ui.message.hidden).toBe(false);
        expect(atlas.ui.message.textContent).toBe(EMPTY_MESSAGE);
        expect(atlas.ui.summary.textContent).toBe('No monthly run yet.');
        expect(atlas.ui.rule.textContent).toContain('Stage rule (version 1)');
        expect(atlas.ui.range.disabled).toBe(true);
        expect(atlas.ui.play.disabled).toBe(true);
        expect(renderer()).toBeNull();
    });

    it.each([
        [503, 'not available right now'],
        [500, 'could not be loaded'],
        [429, 'Too many requests'],
    ])('words a %i', async (status, words) => {
        const { atlas } = makeAtlas({ body: { detail: 'x' }, status });
        await atlas.show();
        expect(atlas.ui.message.textContent).toContain(words);
        expect(atlasErrorMessage(status)).toContain(words);
    });

    it('says so when the body cannot be read, or the request throws', async () => {
        const { atlas } = makeAtlas({ body: { ...BODY, styles: [{ style: 'x' }] } });
        await atlas.show();
        expect(atlas.ui.message.textContent).toMatch(/cannot read/);
        const failing = makeAtlas({ api: { getStyleAtlas: vi.fn(async () => { throw new Error('offline'); }) } });
        await failing.atlas.show();
        expect(failing.atlas.ui.message.textContent).toMatch(/could not be loaded/);
    });

    it('loads once, and hands the renderer the served layout at the last year', async () => {
        const { atlas, api, renderer } = makeAtlas();
        await atlas.show();
        await atlas.show();
        expect(api.getStyleAtlas).toHaveBeenCalledTimes(1);
        expect(renderer().layout.nodes).toHaveLength(BODY.genres.length + BODY.styles.length + BODY.ghosts.length);
        expect(renderer().years).toEqual([BODY.timeline.last_year]);
        expect(renderer().running).toBe(true);
        expect(atlas.ui.message.hidden).toBe(true);
        expect(atlas.ui.summary.textContent).toContain(`${BODY.genres.length} genres, ${BODY.styles.length} styles, and ${BODY.ghosts.length} ghost copies`);
        atlas.hide();
        expect(renderer().running).toBe(false);
    });

    it('says so when WebGL is not available', async () => {
        const atlas = new GenreAtlas({ doc: document, api: answer(BODY), createRenderer: () => { throw new Error('no webgl'); }, observeTheme: false });
        await atlas.show();
        expect(atlas.ui.message.textContent).toMatch(/WebGL is not available/);
    });
});

describe('the stage rule on screen', () => {
    it('shows every stage condition, every threshold, and the version, from the payload', async () => {
        const { atlas } = makeAtlas();
        await atlas.show();
        const rule = atlas.ui.rule.textContent;
        expect(atlas.ui.rule.querySelector('.atlas-rule-title').textContent).toBe('Stage rule (version 1)');
        expect(rule).toContain('Stages are judged over release-year counts.');
        for (const stage of BODY.rule.stages) expect(rule).toContain(stageWord(stage));
        expect(rule).toContain('trailing mean at least 0.5 × its peak, under 10 years after emergence');
        expect(rule).toContain('but at least 1.5 × its trough and 0.25 × its peak');
        expect(rule).toContain('emerge_total 25 · active_share 0.5 · establish_years 10 · revive_ratio 1.5 · revive_floor 0.25 · window 3 · provisional_years 2');
        // The internal id is a small support line with a tooltip, never the heading.
        const detail = atlas.ui.rule.querySelector('.atlas-rule-version');
        expect(detail.textContent).toBe('Rule id gm-design-4804/1');
        expect(detail.title).toContain('gm-design-4804/1');
        expect(atlas.ui.rule.querySelector('h4').textContent).not.toContain('gm-design');
        expect(rule).toContain('The latest 2 years are provisional');
    });

    it('follows a changed rule', async () => {
        const { atlas } = makeAtlas({ body: { ...BODY, rule: { ...BODY.rule, active_share: 0.6, rule_version: 'gm-design-4804/2' } } });
        await atlas.show();
        expect(atlas.ui.rule.textContent).toContain('Rule id gm-design-4804/2');
        expect(atlas.ui.rule.textContent).toContain('0.6 × its peak');
    });
});

describe('valid time and the provisional treatment', () => {
    it('hatches exactly the provisional years on the scrubber strip', async () => {
        const { atlas } = makeAtlas();
        await atlas.show();
        const cells = [...atlas.ui.strip.children];
        expect(cells).toHaveLength(BODY.timeline.last_year - BODY.timeline.first_year + 1);
        const hatched = cells.filter((cell) => cell.classList.contains('atlas-year-cell--provisional')).map((cell) => Number(cell.dataset.year));
        expect(hatched).toEqual([BODY.timeline.provisional_from, BODY.timeline.last_year]);
        expect(atlas.ui.range.min).toBe(String(BODY.timeline.first_year));
        expect(atlas.ui.range.max).toBe(String(BODY.timeline.last_year));
    });

    it('marks a provisional year in words, not color alone, and clears it in a settled year', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        expect(atlas.ui.note.hidden).toBe(false);
        expect(atlas.ui.range.getAttribute('aria-valuetext')).toBe(`${BODY.timeline.last_year}, provisional`);
        expect(atlas.ui.output.classList.contains('atlas-year-value--provisional')).toBe(true);
        atlas.ui.range.value = '1980';
        atlas.ui.range.dispatchEvent(new Event('input'));
        expect(renderer().years.at(-1)).toBe(1980);
        expect(atlas.ui.note.hidden).toBe(true);
        expect(atlas.ui.output.textContent).toBe('1980');
        expect(atlas.ui.range.getAttribute('aria-valuetext')).toBe('1980');
    });

    it('scrubbing repaints the legend counts and moves no node', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        const before = renderer().layout.nodes.map((n) => [n.id, n.x, n.z]);
        const legend = atlas.ui.legend.textContent;
        atlas.setYear(1960);
        expect(atlas.ui.legend.textContent).not.toBe(legend);
        expect(renderer().layout.nodes.map((n) => [n.id, n.x, n.z])).toEqual(before);
        expect(atlas.ui.legend.textContent).toContain('Provisional year (dashed)');
        expect(atlas.ui.legend.textContent).toContain('Ghost copy');
    });

    it('plays a year at a time to the end of the timeline, then stops', async () => {
        const { atlas, tick } = makeAtlas();
        await atlas.show();
        atlas.ui.play.click();
        expect(atlas.year).toBe(BODY.timeline.first_year);
        expect(atlas.ui.play.getAttribute('aria-pressed')).toBe('true');
        tick();
        expect(atlas.year).toBe(BODY.timeline.first_year + 1);
        for (let i = 0; i < 200; i++) tick();
        expect(atlas.year).toBe(BODY.timeline.last_year);
        expect(atlas.playHandle).toBeNull();
        expect(atlas.ui.play.textContent).toBe('Play');
    });
});

describe('the panel', () => {
    it('shows the latest stage as provisional with the settled stage next to it', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        const style = BODY.styles.find((s) => s.stage !== s.settled_stage) || BODY.styles[0];
        renderer().select(`s:${style.style}`);
        const latest = atlas.ui.selection.querySelector('.atlas-stage-latest').textContent;
        expect(latest).toBe(`Latest (${BODY.timeline.last_year}): ${stageWord(style.stage)}provisional · settled (${BODY.timeline.provisional_from - 1}): ${stageWord(style.settled_stage)}`);
        expect(atlas.ui.selection.textContent).toContain(`drawn under ${style.genre}, its dominant parent`);
        expect(atlas.ui.selection.textContent).toContain(NO_COTAGS);
    });

    it('lists parents with shares and whether their emergence edge is drawn, and a ghost names its primary', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        const ghost = BODY.ghosts[0];
        const style = BODY.styles.find((s) => s.style === ghost.style);
        renderer().select(`h:${ghost.style}@${ghost.genre}`);
        const box = atlas.ui.selection.textContent;
        expect(box).toContain(`ghost copy under ${ghost.genre}. Its primary node is under ${style.genre}.`);
        const items = [...atlas.ui.selection.querySelectorAll('.atlas-parents li')].map((li) => li.textContent);
        expect(items).toHaveLength(style.parents.length);
        style.parents.forEach((parent, i) => {
            expect(items[i]).toContain(`${parent.genre} ${Math.round(parent.share * 100)}%`);
            expect(items[i]).toContain(parent.emergence_edge ? 'emergence edge drawn' : 'no emergence edge');
        });
        // A parent's name selects that genre.
        atlas.ui.selection.querySelector('.atlas-parents .atlas-link').click();
        expect(renderer().selected).toBe(`g:${style.parents[0].genre}`);
        expect(atlas.ui.selection.textContent).toContain('ghost cop');
    });

    it('shows the stage in the scrubbed year and flags a provisional one', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        const style = BODY.styles[3];
        renderer().select(`s:${style.style}`);
        atlas.setYear(1970);
        const line = atlas.ui.selection.querySelector('.atlas-stage-line').textContent;
        expect(line).toBe(`In 1970: ${stageWord(BODY.rule.stages[style.stages[1970 - BODY.timeline.first_year]])}`);
        atlas.setYear(BODY.timeline.last_year);
        expect(atlas.ui.selection.querySelector('.atlas-stage-line').textContent).toMatch(/provisional$/);
    });

    it('fetches the selected style co-tags once from the source, then redraws its star and lists them', async () => {
        let renderer = null;
        const source = vi.fn(async (style) => [{ other: BODY.styles[1].style, release_count: 42, rank: 1 }, { other: `${style} twin`, release_count: 7, rank: 2 }]);
        const atlas = new GenreAtlas({
            doc: document,
            api: answer(BODY),
            createRenderer: () => (renderer = Object.assign(new StandInRenderer(), { refreshLateral: vi.fn() })),
            observeTheme: false,
            cotagSource: source,
        });
        document.body.append(atlas.root);
        await atlas.show();
        const style = BODY.styles[0];
        renderer.select(`s:${style.style}`);
        expect(atlas.ui.selection.textContent).toContain('Loading co-tagged styles');
        await new Promise((r) => setTimeout(r, 0));
        expect(source).toHaveBeenCalledWith(style.style);
        expect(renderer.refreshLateral).toHaveBeenCalledTimes(1);
        expect(atlas.ui.selection.textContent).toContain(`${BODY.styles[1].style} · 42 shared releases`);
        renderer.select(null);
        renderer.select(`s:${style.style}`);
        await new Promise((r) => setTimeout(r, 0));
        expect(source).toHaveBeenCalledTimes(1);
    });

    function cotagAtlas(source) {
        let renderer = null;
        const atlas = new GenreAtlas({
            doc: document,
            api: answer(BODY),
            createRenderer: () => (renderer = Object.assign(new StandInRenderer(), { refreshLateral: vi.fn() })),
            observeTheme: false,
            cotagSource: source,
        });
        document.body.append(atlas.root);
        return { atlas, renderer: () => renderer };
    }
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it('uses the api client getStyleCotags as the co-tag source when the api has one', async () => {
        const entries = [{ other: BODY.styles[1].style, release_count: 11, rank: 1 }];
        const api = { ...answer(BODY), getStyleCotags: vi.fn(async () => entries) };
        const { atlas, renderer } = makeAtlas({ api });
        await atlas.show();
        renderer().select(`s:${BODY.styles[0].style}`);
        await settle();
        expect(api.getStyleCotags).toHaveBeenCalledWith(BODY.styles[0].style);
        expect(atlas.cotags.get(BODY.styles[0].style)).toEqual(entries);
        // An explicit null source still means none are served.
        const none = new GenreAtlas({ doc: document, api, createRenderer: () => new StandInRenderer(), observeTheme: false, cotagSource: null });
        expect(none.cotagSource).toBeNull();
    });

    it('lists the co-tags the atlas draws apart from those it does not', async () => {
        const [a, b] = BODY.styles;
        const source = vi.fn(async () => [
            { other: 'Not Drawn Anywhere', release_count: 90, rank: 1 },
            { other: b.style, release_count: 42, rank: 2 },
        ]);
        const { atlas, renderer } = cotagAtlas(source);
        await atlas.show();
        renderer().select(`s:${a.style}`);
        await settle();
        const drawn = [...atlas.ui.selection.querySelectorAll('.atlas-cotags--drawn li')].map((li) => li.textContent);
        const listed = [...atlas.ui.selection.querySelectorAll('.atlas-cotags--listed li')].map((li) => li.textContent);
        expect(drawn).toEqual([`${b.style} · 42 shared releases`]);
        expect(listed).toEqual(['Not Drawn Anywhere · 90 shared releases']);
        expect(atlas.ui.selection.textContent).toContain('Co-tagged styles (drawn as edges)');
        expect(atlas.ui.selection.textContent).toContain('Also co-tagged, not drawn in this atlas');
    });

    it('shows no listed section when every co-tagged style is drawn, and says so for a style with none', async () => {
        const [a, b, c] = BODY.styles;
        const { atlas, renderer } = cotagAtlas(async (style) => (style === a.style ? [{ other: b.style, release_count: 5, rank: 1 }] : []));
        await atlas.show();
        renderer().select(`s:${a.style}`);
        await settle();
        expect(atlas.ui.selection.querySelectorAll('.atlas-cotags--drawn li')).toHaveLength(1);
        expect(atlas.ui.selection.querySelector('.atlas-cotags--listed')).toBeNull();
        renderer().select(`s:${c.style}`);
        await settle();
        expect(atlas.ui.selection.textContent).toContain('No co-tagged styles.');
        expect(atlas.ui.selection.querySelector('.atlas-cotags')).toBeNull();
    });

    it('clears the co-tag list with the selection and shows it again from the cache', async () => {
        const [a, b] = BODY.styles;
        const source = vi.fn(async () => [{ other: b.style, release_count: 5, rank: 1 }]);
        const { atlas, renderer } = cotagAtlas(source);
        await atlas.show();
        renderer().select(`s:${a.style}`);
        await settle();
        expect(atlas.ui.selection.querySelector('.atlas-cotags')).not.toBeNull();
        renderer().select(null);
        expect(atlas.ui.selection.querySelector('.atlas-cotags')).toBeNull();
        expect(atlas.ui.selection.textContent).toContain('Select a genre or a style');
        renderer().select(`s:${a.style}`);
        expect(atlas.ui.selection.querySelectorAll('.atlas-cotags--drawn li')).toHaveLength(1);
        expect(source).toHaveBeenCalledTimes(1);
    });

    it('does not fetch a style twice while its read is in flight, and ignores an answer for a style no longer selected', async () => {
        const [a, b] = BODY.styles;
        const releases = [];
        const source = vi.fn(() => new Promise((resolve) => releases.push(() => resolve([{ other: b.style, rank: 1 }]))));
        const { atlas, renderer } = cotagAtlas(source);
        await atlas.show();
        renderer().select(`s:${a.style}`);
        renderer().select(null);
        renderer().select(`s:${a.style}`);
        expect(source).toHaveBeenCalledTimes(1);
        renderer().select(`s:${b.style}`);
        expect(source).toHaveBeenCalledTimes(2);
        releases[0]();
        await settle();
        expect(atlas.cotags.get(a.style)).toHaveLength(1);
        expect(renderer().refreshLateral).not.toHaveBeenCalled();
        expect(atlas.ui.selection.querySelector('.strata-selection-title').textContent).toBe(b.style);
    });

    it('says a failed co-tag read failed, leaves the atlas usable, and retries on the next selection', async () => {
        const [a, b] = BODY.styles;
        const source = vi.fn().mockRejectedValueOnce(new Error('Co-tag fetch failed: 503')).mockResolvedValue([{ other: b.style, release_count: 5, rank: 1 }]);
        const { atlas, renderer } = cotagAtlas(source);
        await atlas.show();
        renderer().select(`s:${a.style}`);
        await settle();
        expect(atlas.ui.selection.textContent).toContain(COTAGS_FAILED);
        expect(atlas.ui.selection.textContent).not.toContain('No co-tagged styles');
        // The rest of the panel and the view are intact.
        expect(atlas.ui.selection.querySelector('.strata-selection-title').textContent).toBe(a.style);
        expect(atlas.ui.selection.querySelector('.atlas-parents')).not.toBeNull();
        expect(atlas.ui.message.hidden).toBe(true);
        expect(atlas.cotags.has(a.style)).toBe(false);
        atlas.setYear(BODY.timeline.first_year);
        expect(atlas.year).toBe(BODY.timeline.first_year);
        renderer().select(`s:${b.style}`);
        await settle();
        expect(atlas.ui.selection.textContent).not.toContain(COTAGS_FAILED);
        renderer().select(`s:${a.style}`);
        await settle();
        expect(source).toHaveBeenCalledTimes(3);
        expect(atlas.ui.selection.textContent).not.toContain(COTAGS_FAILED);
        expect(atlas.ui.selection.querySelectorAll('.atlas-cotags--drawn li')).toHaveLength(1);
    });

    it('treats an answer that is not a list as a failed read', async () => {
        const { atlas, renderer } = cotagAtlas(async () => ({ items: [] }));
        await atlas.show();
        renderer().select(`s:${BODY.styles[0].style}`);
        await settle();
        expect(atlas.ui.selection.textContent).toContain(COTAGS_FAILED);
    });

    it('draws served landmark masters with the slot rule, and says nothing when their plane is soloed', async () => {
        const { masters } = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'style-atlas-masters.json'), 'utf8'));
        const { atlas, renderer } = makeAtlas({ body: { ...BODY, masters } });
        await atlas.show();
        expect(renderer().layout.nodes.filter((node) => node.entity === 'master')).toHaveLength(masters.length);
        expect(atlas.layout.planes[2].note).toBe(null);
        atlas.ui.planeButtons[3].click();
        expect(atlas.ui.message.hidden).toBe(true);
        renderer().select(`m:${masters[0].master_id}@${masters[0].style}`);
        expect(atlas.ui.selection.textContent).toContain(`rank ${masters[0].rank} in ${masters[0].style}`);
    });

    it('says why the master plane is empty when it is soloed', async () => {
        const { atlas } = makeAtlas();
        await atlas.show();
        atlas.ui.planeButtons[3].click();
        expect(atlas.ui.message.textContent).toBe(NO_MASTERS);
        expect(atlas.ui.planeButtons[3].getAttribute('aria-pressed')).toBe('true');
        atlas.ui.planeButtons[0].click();
        expect(atlas.ui.message.hidden).toBe(true);
    });
});

describe('keyboard', () => {
    const layout = layoutAtlas(adaptAtlasPayload(BODY));
    const nodes = layout.nodes;

    it('maps camera keys, solo, and Escape', () => {
        expect(atlasKeyCommand({ key: 'ArrowLeft' })).toEqual({ type: 'orbit', radians: 0.12 });
        expect(atlasKeyCommand({ key: '+' })).toEqual({ type: 'zoom', direction: 'in' });
        expect(atlasKeyCommand({ key: '0' })).toEqual({ type: 'reset' });
        expect(atlasKeyCommand({ key: '2' }, { solo: null })).toEqual({ type: 'solo', level: 1 });
        expect(atlasKeyCommand({ key: '2' }, { solo: 1 })).toEqual({ type: 'solo', level: null });
        expect(atlasKeyCommand({ key: 'Escape' }, { nodes, selected: nodes[0].id })).toEqual({ type: 'select', id: null });
        expect(atlasKeyCommand({ key: 'Escape' }, { solo: 2 })).toEqual({ type: 'solo', level: null });
        expect(atlasKeyCommand({ key: 'x' })).toBeNull();
        expect(atlasKeyCommand({ key: 'ArrowLeft', ctrlKey: true })).toBeNull();
    });

    it('moves around the ring, up to a host genre, and down to its first style', () => {
        const first = atlasKeyCommand({ key: ']' }, { nodes });
        expect(nodes.find((n) => n.id === first.id).level).toBe(0);
        const next = atlasKeyCommand({ key: ']' }, { nodes, selected: first.id });
        expect(next.id).not.toBe(first.id);
        const down = atlasKeyCommand({ key: 'PageDown' }, { nodes, selected: first.id });
        const child = nodes.find((n) => n.id === down.id);
        expect(child.level).toBe(1);
        expect(child.group).toBe(first.id);
        expect(atlasKeyCommand({ key: 'PageUp' }, { nodes, selected: child.id })).toEqual({ type: 'select', id: first.id });
        const ring = [];
        let at = null;
        for (let i = 0; i < 16; i++) {
            at = atlasKeyCommand({ key: ']' }, { nodes, selected: at }).id;
            ring.push(at);
        }
        expect(new Set(ring).size).toBe(BODY.genres.length);
    });

    it('drives the renderer from the focused stage', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        const press = (key) => atlas.ui.stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        press('ArrowRight');
        press('-');
        press('0');
        expect(renderer().calls).toEqual([['orbit', -0.12], ['zoom', 'out'], ['reset']]);
        press(']');
        expect(atlas.selected).toMatch(/^g:/);
        press('Escape');
        expect(atlas.selected).toBeNull();
        expect(atlas.ui.stage.getAttribute('aria-describedby')).toBe('atlasKeyHelp');
        expect(atlas.root.querySelector('#atlasKeyHelp').textContent).toBe(ATLAS_KEY_HELP);
    });
});

describe('the Genres and Insights panes', () => {
    beforeEach(() => {
        document.body.innerHTML = INDEX.slice(INDEX.indexOf('<body'), INDEX.lastIndexOf('</body>')).replace(/^<body[^>]*>/, '').replace(/<script[\s\S]*?<\/script>/g, '');
    });

    const flush = () => new Promise((r) => setTimeout(r, 0));
    const activate = (pane) => {
        for (const el of document.querySelectorAll('.pane')) el.classList.toggle('active', el.id === `${pane}Pane`);
    };

    it('index.html holds both mounts, the Genres toggle, the stylesheet, and the module', () => {
        expect(document.getElementById('genreAtlasMount')).not.toBeNull();
        expect(document.getElementById('insightsAtlasMount')).not.toBeNull();
        expect(document.querySelectorAll('[data-genres-view]')).toHaveLength(2);
        expect(document.getElementById('genreTreeContainer').hidden).toBe(true);
        expect(INDEX).toContain('<link rel="stylesheet" href="css/strata-atlas.css">');
        expect(INDEX).toContain('<script type="module" src="js/strata-atlas.js"></script>');
    });

    it('moves one view into whichever pane is open, and stops it when neither is', async () => {
        const atlas = new GenreAtlas({ doc: document, api: answer(BODY), createRenderer: () => new StandInRenderer(), observeTheme: false });
        const show = vi.spyOn(atlas, 'show');
        const hide = vi.spyOn(atlas, 'hide');
        initGenreAtlas({ doc: document, atlas });
        expect(hide).toHaveBeenCalled();
        activate('genres');
        await flush();
        expect(document.getElementById('genreAtlasMount').contains(atlas.root)).toBe(true);
        expect(show).toHaveBeenCalledTimes(1);
        activate('insights');
        await flush();
        expect(document.getElementById('insightsAtlasMount').contains(atlas.root)).toBe(true);
        expect(document.getElementById('genreAtlasMount').contains(atlas.root)).toBe(false);
        activate('explore');
        await flush();
        expect(atlas.active).toBe(false);
    });

    it('the Genres toggle switches between the atlas and the tree', async () => {
        const atlas = new GenreAtlas({ doc: document, api: answer(BODY), createRenderer: () => new StandInRenderer(), observeTheme: false });
        initGenreAtlas({ doc: document, atlas });
        activate('genres');
        await flush();
        const [atlasButton, treeButton] = document.querySelectorAll('[data-genres-view]');
        treeButton.click();
        expect(document.getElementById('genreTreeContainer').hidden).toBe(false);
        expect(document.getElementById('genreAtlasMount').hidden).toBe(true);
        expect(treeButton.getAttribute('aria-pressed')).toBe('true');
        expect(atlas.active).toBe(false);
        atlasButton.click();
        expect(document.getElementById('genreAtlasMount').hidden).toBe(false);
        expect(atlas.active).toBe(true);
    });

    it('opens in the Fit pane only once its mount is shown, and draws the landing point there alone', async () => {
        const atlas = new GenreAtlas({ doc: document, api: answer(BODY), createRenderer: () => new StandInRenderer(), observeTheme: false });
        const show = vi.spyOn(atlas, 'show');
        initGenreAtlas({ doc: document, atlas });
        const mount = document.getElementById('fitAtlasMount');
        expect(mount.hidden).toBe(true);
        activate('fit');
        await flush();
        expect(show).not.toHaveBeenCalled();
        atlas.setLanding(FIT_PROFILE);
        mount.hidden = false;
        await flush();
        expect(mount.contains(atlas.root)).toBe(true);
        await atlas.loading;
        expect(atlas.landingShown).toBe(true);
        expect(atlas.ui.landing.hidden).toBe(false);
        expect(atlas.layout.nodes.some((node) => node.landing)).toBe(true);
        activate('genres');
        await flush();
        expect(document.getElementById('genreAtlasMount').contains(atlas.root)).toBe(true);
        expect(atlas.landingShown).toBe(false);
        expect(atlas.ui.landing.hidden).toBe(true);
        expect(atlas.layout.nodes.some((node) => node.landing)).toBe(false);
        activate('fit');
        await flush();
        expect(atlas.layout.nodes.some((node) => node.landing)).toBe(true);
    });

    it('does nothing on a page without the panes', () => {
        document.body.textContent = '';
        expect(initGenreAtlas({ doc: document })).toBeNull();
    });

    it('re-reads the colors on a theme change', async () => {
        const { atlas, renderer } = (() => {
            let r = null;
            const a = new GenreAtlas({ doc: document, api: answer(BODY), createRenderer: () => (r = new StandInRenderer()) });
            return { atlas: a, renderer: () => r };
        })();
        document.body.append(atlas.root);
        await atlas.show();
        document.documentElement.classList.add('dark');
        await flush();
        expect(renderer().calls).toContainEqual(['colors']);
        atlas.dispose();
    });
});

describe('CSP', () => {
    it('builds, loads, scrubs, and selects without writing a style attribute or parsing HTML', async () => {
        const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
        const innerHTML = vi.spyOn(Element.prototype, 'innerHTML', 'set');
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        atlas.setYear(1990);
        renderer().select(`h:${BODY.ghosts[0].style}@${BODY.ghosts[0].genre}`);
        atlas.ui.planeButtons[1].click();
        expect(setAttribute.mock.calls.filter(([name]) => String(name).toLowerCase() === 'style')).toEqual([]);
        expect(innerHTML).not.toHaveBeenCalled();
        expect(text(atlas)).toContain('Genre Atlas');
        vi.restoreAllMocks();
    });
});

// ---------------------------------------------------------------------------------------------
// Taste Strata: the signed-in collector's layer (strata-taste.js).
// ---------------------------------------------------------------------------------------------

const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', name), 'utf8'));
const WITH_MASTERS = { ...BODY, masters: fixture('style-atlas-masters.json').masters };
const TASTE = fixture('taste-projection.json').body;

/** A stand-in for window.authManager: a token, and listeners told about sign-in and sign-out. */
function standInAuth(token = 'tok') {
    const listeners = [];
    return {
        token,
        isLoggedIn() { return !!this.token; },
        getToken() { return this.token; },
        onChange(fn) {
            listeners.push(fn);
            return () => listeners.splice(listeners.indexOf(fn), 1);
        },
        set(next) {
            this.token = next;
            for (const fn of [...listeners]) fn(!!next);
        },
    };
}

function tasteAtlas({ auth = standInAuth(), taste = async () => ({ ok: true, status: 200, body: TASTE }) } = {}) {
    let renderer = null;
    const api = { getStyleAtlas: vi.fn(async () => ({ ok: true, status: 200, body: WITH_MASTERS })), getTasteProjection: vi.fn(taste) };
    const atlas = new GenreAtlas({ doc: document, api, auth, createRenderer: () => (renderer = Object.assign(new StandInRenderer(), { refreshTaste: vi.fn(), refreshLanding: vi.fn() })), observeTheme: false });
    document.body.append(atlas.root);
    return { atlas, api, auth, renderer: () => renderer };
}

const collectorNodes = (layout) => layout.nodes.filter((node) => node.entity === 'master' && node.master.collector);
const tasteText = (atlas) => atlas.ui.taste.textContent;

describe('Taste Strata', () => {
    it('shows an anonymous visitor the atlas without the layer, and a hint to sign in', async () => {
        const { atlas, api, renderer } = tasteAtlas({ auth: standInAuth(null) });
        await atlas.show();
        expect(api.getTasteProjection).not.toHaveBeenCalled();
        expect(tasteText(atlas)).toBe(TASTE_SIGN_IN);
        expect(atlas.ui.recorded.hidden).toBe(true);
        expect(renderer().layout.nodes.some((node) => node.held)).toBe(false);
        expect(collectorNodes(renderer().layout)).toEqual([]);
    });

    it('lays a signed-in collector\'s items on the atlas: marks, collector masters, and what is only counted', async () => {
        const { atlas, api, renderer } = tasteAtlas();
        await atlas.show();
        expect(api.getTasteProjection).toHaveBeenCalledWith('tok');
        const { layout } = renderer();
        expect(collectorNodes(layout).map((node) => node.master.masterId).sort()).toEqual(['7100001', '7100002', '7100003']);
        expect(layout.nodes.find((node) => node.id === 's:Copper Drift').held).toMatchObject({ state: 'wanted-owned', items: 1 });
        const words = tasteText(atlas);
        expect(words).toContain('Your collection');
        expect(words).toContain('7 items: 5 owned, 3 wanted, 1 in both.');
        expect(words).toContain('2 items have no master, so they are counted here and not drawn.');
        expect(words).toContain('1 item carries a genre and no style, so it marks a genre only.');
        expect(words).toContain('1 of your styles is not drawn on this atlas.');
        expect(words).toContain('1 of your masters has no style drawn here, so it is not placed.');
        expect(words).toContain(TASTE_AS_OF_NOTE);
        const chips = [...atlas.ui.taste.querySelectorAll('.strata-chip')].map((chip) => chip.className);
        expect(chips).toEqual(['strata-chip strata-chip--wanted', 'strata-chip strata-chip--owned', 'strata-chip strata-chip--wanted-owned']);
    });

    it('says in the panel what of a selected node is the collector\'s, and names a collector master as theirs', async () => {
        const { atlas, renderer } = tasteAtlas();
        await atlas.show();
        renderer().select('s:Copper Drift');
        expect(atlas.ui.selection.querySelector('.atlas-held').textContent).toBe('Yours 1 item · 1 owned · 1 wanted · first recorded in 2014, last in 2015');
        renderer().select('m:7100001@Copper Drift');
        expect(atlas.ui.selection.textContent).toContain('Your master, in its dominant style Copper Drift');
        expect(atlas.ui.selection.textContent).toContain('1988');
        renderer().select('m:910001@Amber Bop');
        expect(atlas.ui.selection.textContent).toContain('Landmark master of Amber Bop');
        expect(atlas.ui.selection.querySelector('.atlas-held').textContent).toContain('Yours 1 item');
    });

    it('scrubs the recorded-as-of year: marks follow the recorded times, and nothing moves', async () => {
        const { atlas, renderer } = tasteAtlas();
        await atlas.show();
        const { recorded, recordedRange, recordedOutput } = atlas.ui;
        expect(recorded.hidden).toBe(false);
        expect([recordedRange.min, recordedRange.max, recordedRange.value]).toEqual(['2014', '2025', '2025']);
        expect(recordedOutput.textContent).toBe('now');
        expect(recordedRange.getAttribute('aria-valuetext')).toBe('now, everything you hold');
        const before = renderer().layout.nodes.map((node) => [node.id, node.x, node.z]);
        recordedRange.value = '2016';
        recordedRange.dispatchEvent(new Event('input'));
        expect(recordedOutput.textContent).toBe('2016');
        expect(renderer().refreshTaste).toHaveBeenCalled();
        const byId = new Map(renderer().layout.nodes.map((node) => [node.id, node]));
        expect(byId.get('s:Amber Bop').held).toBeNull();
        expect(byId.get('s:Copper Drift').held.state).toBe('wanted-owned');
        expect(tasteText(atlas)).toContain('Recorded by the end of 2016: 2 genres, 1 style, and 1 master (0 of them landmarks).');
        renderer().select('s:Amber Bop');
        expect(atlas.ui.selection.querySelector('.atlas-held').textContent).toBe('Yours, but first recorded after 2016.');
        expect(renderer().layout.nodes.map((node) => [node.id, node.x, node.z])).toEqual(before);
        atlas.setTasteYear(9999);
        expect(atlas.tasteYear).toBeNull();
        expect(byId.get('s:Amber Bop').held).not.toBeNull();
    });

    it.each([
        [401, TASTE_SIGN_IN],
        [503, TASTE_FAILED],
    ])('words a %i from the projection, and keeps the atlas', async (status, words) => {
        const { atlas, renderer } = tasteAtlas({ taste: async () => ({ ok: false, status, body: null }) });
        await atlas.show();
        expect(tasteText(atlas)).toBe(words);
        expect(renderer().layout.nodes.length).toBeGreaterThan(0);
        expect(collectorNodes(renderer().layout)).toEqual([]);
    });

    it('says so for an unreadable projection, a failed request, and an empty collection', async () => {
        for (const [taste, words] of [
            [async () => ({ ok: true, status: 200, body: { totals: {} } }), TASTE_FAILED],
            [async () => { throw new Error('offline'); }, TASTE_FAILED],
            [async () => ({ ok: true, status: 200, body: { ...TASTE, totals: { ...TASTE.totals, items: 0 }, genres: [], styles: [], masters: [] } }), TASTE_EMPTY],
        ]) {
            const { atlas } = tasteAtlas({ taste });
            await atlas.show();
            expect(tasteText(atlas)).toBe(words);
            expect(atlas.ui.recorded.hidden).toBe(true);
        }
    });

    it('drops the layer and the projection on sign-out, and loads it again on sign-in', async () => {
        const { atlas, api, auth, renderer } = tasteAtlas();
        await atlas.show();
        renderer().select('m:7100002@Amber Bop');
        auth.set(null);
        expect(atlas.taste).toBeNull();
        expect(tasteText(atlas)).toBe(TASTE_SIGN_IN);
        expect(renderer().layout.nodes.some((node) => node.held || node.heldLater)).toBe(false);
        expect(collectorNodes(renderer().layout)).toEqual([]);
        expect(atlas.selected).toBeNull();
        expect(atlas.ui.recorded.hidden).toBe(true);
        auth.set('tok2');
        await new Promise((r) => setTimeout(r, 0));
        expect(api.getTasteProjection).toHaveBeenLastCalledWith('tok2');
        expect(collectorNodes(renderer().layout)).toHaveLength(3);
    });

    it('drops an answer that arrives after the collector signed out', async () => {
        let release;
        const { atlas, auth, renderer } = tasteAtlas({ taste: () => new Promise((done) => (release = () => done({ ok: true, status: 200, body: TASTE }))) });
        const shown = atlas.show();
        await new Promise((r) => setTimeout(r, 0));
        auth.set(null);
        release();
        await shown;
        expect(atlas.taste).toBeNull();
        expect(collectorNodes(renderer().layout)).toEqual([]);
        expect(tasteText(atlas)).toBe(TASTE_SIGN_IN);
    });

    it('keeps the projection out of the URL and the browser\'s storage', async () => {
        const url = window.location.href;
        const { atlas } = tasteAtlas();
        await atlas.show();
        expect(window.location.href).toBe(url);
        expect(Object.keys(localStorage)).toEqual([]);
        expect(Object.keys(sessionStorage)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------
// The Fit landing point (strata-fit.js).
// ---------------------------------------------------------------------------------------------

describe('the Fit landing point', () => {
    const capped = () => {
        const body = structuredClone(FIT_PROFILE);
        for (const component of Object.values(body.components)) delete component.evidence_entries;
        return body;
    };
    const items = (atlas, list) => [...atlas.ui.landing.querySelectorAll(`.atlas-landing-list--${list} li`)].map((li) => li.textContent);

    async function landed({ profile = FIT_PROFILE, ...options } = {}) {
        const made = tasteAtlas(options);
        await made.atlas.show();
        made.atlas.setLandingShown(true);
        made.atlas.setLanding(profile);
        return made;
    }

    it('draws the candidate over the collector\'s layer and lists what has no place on the map', async () => {
        const { atlas, renderer } = await landed();
        const byId = new Map(renderer().layout.nodes.map((node) => [node.id, node]));
        expect(renderer().refreshLanding).toHaveBeenCalled();
        expect(byId.get('s:Amber Bop')).toMatchObject({ landing: 'affinity', held: { state: 'wanted-owned' } });
        expect(byId.get('s:Glass Drift').landing).toBe('novelty');
        expect(byId.get('m:910001@Amber Bop').landing).toBe('redundancy');
        expect(renderer().layout.landingEdges.map((edge) => edge.genres)).toEqual([['Electronic', 'Rock']]);
        const box = atlas.ui.landing;
        expect(box.hidden).toBe(false);
        expect(box.textContent).toContain('Never Gonna Give You Up · Rick Astley');
        expect(items(atlas, 'drawn')).toEqual([
            'Affinity shares genre Electronic with 3 releases you hold',
            'Affinity shares style Amber Bop with 2 releases you hold',
            'Novelty Glass Drift is a style your collection has never held',
            'Bridge bridges Electronic and Rock, which share no artist or label in your collection',
            'Redundancy you hold Never Gonna Give You Up, the same record on cd',
        ]);
        expect(items(atlas, 'listed')).toEqual([
            'Affinity shares artist Rick Astley with 2 releases you hold',
            'Affinity shares label RCA with 1 release you hold',
            'Novelty Stock Aitken Waterman is a label your collection has never held',
            'Novelty Pete Waterman is an artist your collection has never held',
            'Novelty PWL is a label your collection has never held',
            `Novelty Hi NRG is a style your collection has never held (${LANDING_NOT_ON_ATLAS})`,
            'Bridge region boundaries are the v0 genre heuristic, not a computed community',
            'Depth deepens artist Rick Astley (2 held)',
            'Depth deepens label RCA (1 held)',
        ]);
        const chips = [...box.querySelectorAll('.atlas-landing-list--drawn .atlas-chip')].map((chip) => chip.className);
        expect(chips).toContain('atlas-chip atlas-fit--novelty');
    });

    it('says in the panel what the landing means for a selected node', async () => {
        const { atlas, renderer } = await landed();
        renderer().select('s:Glass Drift');
        expect(atlas.ui.selection.querySelector('.atlas-landing-mark').textContent).toBe('Novelty Never Gonna Give You Up: new to you');
        renderer().select('s:Copper Swing');
        expect(atlas.ui.selection.querySelector('.atlas-landing-mark')).toBeNull();
    });

    it('works for a visitor without the personal layer: drawn on the landmarks, and the rest listed', async () => {
        const { atlas, api, renderer } = await landed({ auth: standInAuth(null) });
        expect(api.getTasteProjection).not.toHaveBeenCalled();
        expect(atlas.ui.taste.textContent).toBe(TASTE_SIGN_IN);
        const { layout } = renderer();
        expect(layout.nodes.some((node) => node.held)).toBe(false);
        expect(layout.nodes.filter((node) => node.landing === 'redundancy').map((node) => node.id)).toEqual(['m:910001@Amber Bop', 'm:910001@Amber Chant']);
        expect(layout.nodes.find((node) => node.id === 'g:Electronic').landing).toBe('affinity');
    });

    it('lists a duplicate whose master has no slot without the collector\'s layer, and draws it with it', async () => {
        const profile = structuredClone(FIT_PROFILE);
        profile.components.redundancy.evidence_entries[0].master_id = '7100001';
        const anonymous = await landed({ profile, auth: standInAuth(null) });
        expect(items(anonymous.atlas, 'listed')).toContain(`Redundancy you hold Never Gonna Give You Up, the same record on cd (${LANDING_NO_SLOT})`);
        const signedIn = await landed({ profile });
        expect(signedIn.renderer().layout.nodes.filter((node) => node.landing === 'redundancy').map((node) => node.id)).toEqual(['m:7100001@Copper Drift']);
    });

    it('falls back to the listing for a body without evidence_entries, and draws nothing', async () => {
        const { atlas, renderer } = await landed({ profile: capped() });
        expect(atlas.ui.landing.querySelector('.atlas-landing-fallback').textContent).toBe(LANDING_FALLBACK);
        expect(renderer().layout.nodes.some((node) => node.landing)).toBe(false);
        expect(renderer().layout.landingEdges).toEqual([]);
        expect(atlas.ui.landing.querySelector('.atlas-landing-list--drawn')).toBeNull();
        expect(items(atlas, 'listed')).toEqual(Object.entries(capped().components).flatMap(([name, c]) => c.evidence.map((line) => `${name[0].toUpperCase()}${name.slice(1)} ${line}`)));
    });

    it('lists the drawable components until the atlas has a layout, then draws them', async () => {
        const { atlas } = tasteAtlas();
        atlas.setLandingShown(true);
        atlas.setLanding(FIT_PROFILE);
        expect(items(atlas, 'listed')).toContain(`Novelty Glass Drift is a style your collection has never held (${LANDING_NO_ATLAS})`);
        await atlas.show();
        expect(items(atlas, 'drawn')).toContain('Novelty Glass Drift is a style your collection has never held');
    });

    it('keeps the landing off the atlas outside the Fit pane, and clears it with null', async () => {
        const { atlas, renderer } = await landed();
        atlas.setLandingShown(false);
        expect(atlas.ui.landing.hidden).toBe(true);
        expect(renderer().layout.nodes.some((node) => node.landing)).toBe(false);
        atlas.setLandingShown(true);
        expect(renderer().layout.nodes.some((node) => node.landing)).toBe(true);
        atlas.setLanding(null);
        expect(atlas.ui.landing.hidden).toBe(true);
        expect(renderer().layout.nodes.some((node) => node.landing)).toBe(false);
        expect(renderer().layout.landingEdges).toEqual([]);
    });

    it('drops the landing point with the collector\'s layer on sign-out', async () => {
        const { atlas, auth, renderer } = await landed();
        auth.set(null);
        expect(atlas.landing).toBeNull();
        expect(atlas.ui.landing.hidden).toBe(true);
        expect(renderer().layout.nodes.some((node) => node.landing)).toBe(false);
    });

    it('keeps the landing point out of the URL and the browser\'s storage', async () => {
        const url = window.location.href;
        await landed();
        expect(window.location.href).toBe(url);
        expect(Object.keys(localStorage)).toEqual([]);
        expect(Object.keys(sessionStorage)).toEqual([]);
    });
});
