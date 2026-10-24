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
import { EMPTY_MESSAGE, NO_COTAGS, NO_MASTERS, adaptAtlasPayload, layoutAtlas } from '../static/js/strata-atlas-layout.js';
import { emptyAtlasPayload } from './strata-atlas-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'style-atlas.json'), 'utf8')).body;
const INDEX = readFileSync(resolve(HERE, '..', 'static', 'index.html'), 'utf8');

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
        expect(atlas.ui.rule.textContent).toContain('Stage rule gm-design-4804/1');
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
        expect(rule).toContain('Stage rule gm-design-4804/1, over release-year counts');
        for (const stage of BODY.rule.stages) expect(rule).toContain(stageWord(stage));
        expect(rule).toContain('trailing mean at least 0.5 × its peak, under 10 years after emergence');
        expect(rule).toContain('but at least 1.5 × its trough and 0.25 × its peak');
        expect(rule).toContain('emerge_total 25 · active_share 0.5 · establish_years 10 · revive_ratio 1.5 · revive_floor 0.25 · window 3 · provisional_years 2');
        expect(rule).toContain('Rule version gm-design-4804/1');
        expect(rule).toContain('The latest 2 years are provisional');
    });

    it('follows a changed rule', async () => {
        const { atlas } = makeAtlas({ body: { ...BODY, rule: { ...BODY.rule, active_share: 0.6, rule_version: 'gm-design-4804/2' } } });
        await atlas.show();
        expect(atlas.ui.rule.textContent).toContain('Rule version gm-design-4804/2');
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
