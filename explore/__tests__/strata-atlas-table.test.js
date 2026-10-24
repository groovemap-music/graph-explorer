/**
 * The Genre Atlas table: its rows against the layout the 3D view draws from (the recorded body and
 * generated atlases), its sorting, its DOM (roving focus, keys, markup, no style attribute), and
 * how the atlas view shares the scrubber, the selection, and the panel with it. The renderer is a
 * stand-in, so these run without three.js.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenreAtlas, NO_WEBGL } from '../static/js/strata-atlas.js';
import { ATLAS_TABLE_COLUMNS, ATLAS_TABLE_HELP, AtlasTable, atlasRowStatus, buildAtlasRows, columnLabel, edgesText, sortAtlasRows } from '../static/js/strata-atlas-table.js';
import { NO_COTAGS, NO_MASTERS, adaptAtlasPayload, layoutAtlas, paintAtlas } from '../static/js/strata-atlas-layout.js';
import { generateAtlasPayload, rng } from './strata-atlas-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'style-atlas.json'), 'utf8')).body;

function painted(body, year) {
    const layout = layoutAtlas(adaptAtlasPayload(body));
    paintAtlas(layout, year ?? layout.atlas.timeline.lastYear);
    return layout;
}

describe('buildAtlasRows', () => {
    const layout = painted(BODY);
    const rows = buildAtlasRows(layout);

    it('has one row per genre and per style, and none for a ghost copy', () => {
        expect(rows.filter((row) => row.kind === 'genre')).toHaveLength(BODY.genres.length);
        expect(rows.filter((row) => row.kind === 'style')).toHaveLength(BODY.styles.length);
        expect(rows).toHaveLength(BODY.genres.length + BODY.styles.length);
        expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
        expect(rows.some((row) => row.id.startsWith('h:'))).toBe(false);
    });

    it('lists a genre, then the styles drawn under it', () => {
        let host = null;
        for (const row of rows) {
            if (row.kind === 'genre') host = row;
            else expect(row.parentId).toBe(host.id);
        }
        expect(rows[0].kind).toBe('genre');
    });

    it('carries the stage, the provisional flag, the settled stage, and the emergence year of a style', () => {
        const style = BODY.styles.find((s) => s.stage !== s.settled_stage);
        const row = rows.find((r) => r.id === `s:${style.style}`);
        expect(row.stageText).toBe(row.latestText);
        expect(row.latestText.toLowerCase()).toBe(style.stage);
        expect(row.settledText.toLowerCase()).toBe(style.settled_stage);
        expect(row.provisional).toBe(true);
        expect(row.provisionalText).toBe('provisional');
        expect(row.emergedText).toBe(String(style.emergence_year));
    });

    it('gives a style that has not emerged "not yet", and a genre no stage of its own', () => {
        const absent = BODY.styles.find((s) => s.emergence_year === null);
        expect(rows.find((r) => r.id === `s:${absent.style}`).emergedText).toBe('not yet');
        const genre = rows.find((r) => r.kind === 'genre');
        expect(genre.stageText).toBe('No stage');
        expect(genre.provisionalText).toBe('n/a');
    });

    it('names every parent with its share, the dominant parent, and whether each emergence edge is drawn', () => {
        const style = BODY.styles.find((s) => s.parents.length === 2 && s.parents.every((p) => p.emergence_edge));
        const row = rows.find((r) => r.id === `s:${style.style}`);
        expect(row.dominant).toBe(style.parents.find((p) => p.dominant).genre);
        expect(row.parentsText).toBe(style.parents.map((p) => `${p.genre} ${Math.round(p.share * 100)}%`).join(' · '));
        expect(row.edgesText).toBe(style.parents.map((p) => `${p.genre}: drawn`).join(' · '));
        expect(row.edgesDrawn).toBe(2);
        expect(edgesText([{ genre: 'Jazz', emergenceEdge: false }])).toBe('Jazz: not drawn');
    });

    it('follows the scrubbed year: the same layout, a different stage and provisional flag', () => {
        const early = buildAtlasRows(painted(BODY, 1960));
        const style = BODY.styles.find((s) => s.stages[1960 - BODY.timeline.first_year] !== s.stages.at(-1));
        const a = early.find((r) => r.id === `s:${style.style}`);
        const b = rows.find((r) => r.id === `s:${style.style}`);
        expect(a.stageText).not.toBe(b.stageText);
        expect(a.provisional).toBe(false);
        expect(a.provisionalText).toBe('settled');
        expect(b.provisional).toBe(true);
        // The latest and settled stages do not depend on the year.
        expect(a.latestText).toBe(b.latestText);
        expect(a.settledText).toBe(b.settledText);
    });

    it('holds over generated atlases: every genre and style once, with its dominant parent as its host', () => {
        for (let seed = 1; seed <= 25; seed++) {
            const payload = generateAtlasPayload(rng(seed));
            const generated = painted(payload);
            const built = buildAtlasRows(generated);
            expect(built).toHaveLength(payload.genres.length + payload.styles.length);
            const ids = new Set(built.map((row) => row.id));
            for (const row of built) if (row.parentId !== null) expect(ids.has(row.parentId)).toBe(true);
            expect(built.map((row) => row.order)).toEqual(built.map((_, i) => i));
        }
    });
});

describe('sortAtlasRows and atlasRowStatus', () => {
    const rows = buildAtlasRows(painted(BODY));
    const by = (column, direction = 'ascending') => sortAtlasRows(rows, { column, direction });

    it('keeps the outline order with no sort, and does not mutate the rows', () => {
        const copy = rows.slice();
        expect(sortAtlasRows(rows, null).map((r) => r.id)).toEqual(rows.map((r) => r.id));
        expect(sortAtlasRows(rows, { column: 'nope', direction: 'ascending' })).toHaveLength(rows.length);
        expect(rows).toEqual(copy);
    });

    it('sorts by name, in both directions', () => {
        const names = by('name').map((r) => r.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })));
        expect(by('name', 'descending').map((r) => r.name)).toEqual(names.slice().reverse());
    });

    it('sorts by stage in the rule\'s order, with rows that have none last either way', () => {
        const order = BODY.rule.stages;
        const ranks = (list) => list.filter((r) => r.stageRank !== null).map((r) => r.stageRank);
        for (const direction of ['ascending', 'descending']) {
            const sorted = by('stage', direction);
            const staged = ranks(sorted);
            expect(staged).toEqual([...staged].sort((a, b) => (direction === 'ascending' ? a - b : b - a)));
            const firstEmpty = sorted.findIndex((r) => r.stageRank === null);
            if (firstEmpty >= 0) expect(sorted.slice(firstEmpty).every((r) => r.stageRank === null)).toBe(true);
        }
        expect(order).toContain('declining');
    });

    it('sorts by emergence year with the styles that have not emerged last', () => {
        const years = by('emerged').map((r) => r.emergenceYear);
        const dated = years.filter((y) => y !== null);
        expect(dated).toEqual([...dated].sort((a, b) => a - b));
        expect(years.slice(dated.length).every((y) => y === null)).toBe(true);
        const down = by('emerged', 'descending').map((r) => r.emergenceYear);
        expect(down.slice(0, dated.length)).toEqual(dated.slice().reverse());
        expect(down.slice(dated.length).every((y) => y === null)).toBe(true);
    });

    it('sorts by provisional, by edges drawn, and by parent count', () => {
        const edges = by('edges', 'descending').map((r) => r.edgesDrawn);
        expect(edges).toEqual([...edges].sort((a, b) => b - a));
        const parents = by('parents').map((r) => r.parents.length);
        expect(parents).toEqual([...parents].sort((a, b) => a - b));
        const flags = by('provisional', 'descending').map((r) => r.provisional);
        expect(flags[0]).toBe(true);
    });

    it('ties keep the outline order', () => {
        const sorted = by('provisional');
        const styles = sorted.filter((r) => r.kind === 'style');
        expect(styles.map((r) => r.order)).toEqual([...styles.map((r) => r.order)].sort((a, b) => a - b));
    });

    it('words the status with the year and the sort', () => {
        expect(atlasRowStatus({ shown: 1, year: 2025 })).toBe('1 row as of 2025, in outline order.');
        expect(atlasRowStatus({ shown: 156, year: 1980, sort: { column: 'stage', direction: 'descending' } })).toBe('156 rows as of 1980, sorted by stage in 1980, descending.');
        expect(columnLabel(ATLAS_TABLE_COLUMNS.find((c) => c.id === 'stage'), null)).toBe('Stage');
    });
});

describe('AtlasTable', () => {
    let host;
    let table;
    let calls;
    let rows;

    const key = (target, name, init = {}) => {
        const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        return event;
    };
    const ids = () => [...host.querySelectorAll('tbody tr')].map((tr) => tr.dataset.id);
    const rowEl = (id) => host.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    const header = (id) => host.querySelector(`th[data-column="${id}"]`);

    beforeEach(() => {
        host = document.createElement('div');
        document.body.append(host);
        calls = { select: [], status: [] };
        rows = buildAtlasRows(painted(BODY));
        table = new AtlasTable({
            host,
            helpId: 'atlasTableHelp',
            onSelect: (id) => calls.select.push(id),
            onStatus: (text) => calls.status.push(text),
        });
        table.setRows(rows, { year: BODY.timeline.last_year });
    });

    afterEach(() => {
        document.body.textContent = '';
    });

    it('is a native table with a caption, column headers that sort, and row headers', () => {
        expect(host.querySelector('table').getAttribute('aria-describedby')).toBe('atlasTableHelp');
        expect(host.querySelector('caption').textContent).toBe(`Genres and styles: ${rows.length} rows as of ${BODY.timeline.last_year}, in outline order.`);
        const heads = [...host.querySelectorAll('thead th')];
        expect(heads).toHaveLength(ATLAS_TABLE_COLUMNS.length);
        for (const th of heads) {
            expect(th.scope).toBe('col');
            expect(th.getAttribute('aria-sort')).toBe('none');
            expect(th.querySelector('button').type).toBe('button');
        }
        expect(header('stage').textContent).toBe(`Stage in ${BODY.timeline.last_year}`);
        expect(host.querySelectorAll('tbody tr')).toHaveLength(rows.length);
        for (const th of host.querySelectorAll('tbody th')) expect(th.scope).toBe('row');
    });

    it('shows a stage as a word beside its swatch, and the provisional flag as a word', () => {
        const style = rows.find((r) => r.kind === 'style' && r.provisional);
        const tr = rowEl(style.id);
        const chip = tr.querySelector('.atlas-cell-stage .atlas-chip');
        expect(chip.textContent).toBe(style.stageText);
        expect(chip.className).toContain(`atlas-stage--${style.stage}`);
        expect(tr.querySelector('.atlas-cell-provisional').textContent).toBe('provisional');
        expect(tr.querySelector('.atlas-cell-edges').textContent).toBe(style.edgesText);
        expect(tr.querySelector('.atlas-cell-parents').textContent).toBe(style.parentsText);
    });

    it('sorts from a header: ascending, descending, outline order again, and announces it', () => {
        const outline = ids();
        header('name').querySelector('button').click();
        expect(header('name').getAttribute('aria-sort')).toBe('ascending');
        expect(ids()).not.toEqual(outline);
        expect(calls.status.at(-1)).toMatch(/sorted by name, ascending\.$/);
        header('name').querySelector('button').click();
        expect(header('name').getAttribute('aria-sort')).toBe('descending');
        header('name').querySelector('button').click();
        expect(header('name').getAttribute('aria-sort')).toBe('none');
        expect(ids()).toEqual(outline);
        header('emerged').querySelector('button').click();
        header('stage').querySelector('button').click();
        expect(header('emerged').getAttribute('aria-sort')).toBe('none');
        expect(header('stage').getAttribute('aria-sort')).toBe('ascending');
    });

    it('keeps the sort and the place when the rows are replaced for another year', () => {
        header('name').querySelector('button').click();
        const target = ids()[5];
        table.moveTo(target);
        table.setRows(buildAtlasRows(painted(BODY, 1990)), { year: 1990 });
        expect(header('name').getAttribute('aria-sort')).toBe('ascending');
        expect(header('stage').textContent).toBe('Stage in 1990');
        expect(document.activeElement).toBe(rowEl(target));
        expect(rowEl(target).tabIndex).toBe(0);
    });

    it('has one tab stop, and arrow keys, Home, and End move it', () => {
        const stops = () => [...host.querySelectorAll('tbody tr')].filter((tr) => tr.tabIndex === 0).map((tr) => tr.dataset.id);
        expect(stops()).toEqual([ids()[0]]);
        const first = rowEl(ids()[0]);
        first.focus();
        expect(key(first, 'ArrowDown').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(rowEl(ids()[1]));
        expect(stops()).toEqual([ids()[1]]);
        key(document.activeElement, 'End');
        expect(document.activeElement).toBe(rowEl(ids().at(-1)));
        key(document.activeElement, 'ArrowDown');
        expect(document.activeElement).toBe(rowEl(ids().at(-1)));
        key(document.activeElement, 'Home');
        expect(document.activeElement).toBe(rowEl(ids()[0]));
        key(document.activeElement, 'ArrowUp');
        expect(document.activeElement).toBe(rowEl(ids()[0]));
    });

    it('PageDown goes to a genre\'s first style and PageUp back to the dominant parent genre', () => {
        const genre = rows.find((r) => r.kind === 'genre');
        const child = rows.find((r) => r.parentId === genre.id);
        rowEl(genre.id).focus();
        key(document.activeElement, 'PageDown');
        expect(document.activeElement).toBe(rowEl(child.id));
        key(document.activeElement, 'PageUp');
        expect(document.activeElement).toBe(rowEl(genre.id));
        // A genre has no parent and stays put.
        key(document.activeElement, 'PageUp');
        expect(document.activeElement).toBe(rowEl(genre.id));
    });

    it('Space and Enter select the row, Escape clears a selection, and a click selects', () => {
        const id = ids()[3];
        rowEl(id).focus();
        key(rowEl(id), ' ');
        key(rowEl(id), 'Enter');
        expect(calls.select).toEqual([id, id]);
        // Escape with nothing selected does nothing.
        expect(key(rowEl(id), 'Escape').defaultPrevented).toBe(false);
        table.select(id);
        expect(rowEl(id).getAttribute('aria-current')).toBe('true');
        key(rowEl(id), 'Escape');
        expect(calls.select.at(-1)).toBeNull();
        rowEl(ids()[4]).click();
        expect(calls.select.at(-1)).toBe(ids()[4]);
        table.select(null);
        expect(host.querySelector('[aria-current]')).toBeNull();
    });

    it('ignores keys with a modifier and keys it has no use for', () => {
        const tr = rowEl(ids()[0]);
        tr.focus();
        expect(key(tr, 'ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(key(tr, 'x').defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(tr);
    });

    it('writes no style attribute and parses no HTML', () => {
        const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
        const innerHTML = vi.spyOn(Element.prototype, 'innerHTML', 'set');
        table.setRows(rows);
        header('stage').querySelector('button').click();
        table.select(ids()[2]);
        expect(setAttribute.mock.calls.filter(([name]) => String(name).toLowerCase() === 'style')).toEqual([]);
        expect(innerHTML).not.toHaveBeenCalled();
        expect(host.querySelector('[style]')).toBeNull();
        vi.restoreAllMocks();
    });
});

describe('the table in the Genre Atlas', () => {
    function makeAtlas({ body = BODY, createRenderer = null } = {}) {
        let renderer = null;
        const made = [];
        const stand = () => {
            const target = new EventTarget();
            Object.assign(target, {
                calls: [],
                selected: null,
                running: false,
                setLayout() {},
                setYear() {},
                select(id) {
                    target.selected = id;
                    target.dispatchEvent(new CustomEvent('select', { detail: { id } }));
                },
                solo(level) {
                    target.dispatchEvent(new CustomEvent('solo', { detail: { level } }));
                },
                start() { target.running = true; },
                stop() { target.running = false; },
                resize() {},
                refreshColors() {},
                dispose() {},
            });
            made.push(target);
            return (renderer = target);
        };
        const atlas = new GenreAtlas({
            doc: document,
            api: { getStyleAtlas: vi.fn(async () => ({ ok: true, status: 200, body })) },
            createRenderer: createRenderer || stand,
            observeTheme: false,
        });
        document.body.append(atlas.root);
        return { atlas, renderer: () => renderer, made };
    }
    const viewButton = (atlas, view) => atlas.root.querySelector(`[data-atlas-view="${view}"]`);
    const rowIds = (atlas) => [...atlas.ui.table.querySelectorAll('tbody tr')].map((tr) => tr.dataset.id);

    afterEach(() => {
        document.body.textContent = '';
    });

    it('opens on the 3D view and offers the table from a toggle', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        expect(atlas.mode).toBe('strata');
        expect(viewButton(atlas, 'strata').getAttribute('aria-pressed')).toBe('true');
        expect(viewButton(atlas, 'table').getAttribute('aria-pressed')).toBe('false');
        expect(atlas.root.querySelector('[aria-label="Atlas view"]').getAttribute('role')).toBe('group');
        expect(atlas.ui.tableWrap.hidden).toBe(true);
        expect(atlas.ui.stage.hidden).toBe(false);
        expect(renderer().running).toBe(true);
    });

    it('switches to the table: rows for every genre and style, the 3D controls and loop stopped', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        viewButton(atlas, 'table').click();
        expect(atlas.mode).toBe('table');
        expect(viewButton(atlas, 'table').getAttribute('aria-pressed')).toBe('true');
        expect(viewButton(atlas, 'strata').getAttribute('aria-pressed')).toBe('false');
        expect(atlas.ui.tableWrap.hidden).toBe(false);
        expect(atlas.ui.stage.hidden).toBe(true);
        expect(atlas.ui.help.hidden).toBe(true);
        expect(atlas.ui.reset.hidden).toBe(true);
        expect(atlas.ui.stageOnly.every((item) => item.hidden)).toBe(true);
        expect(renderer().running).toBe(false);
        expect(rowIds(atlas)).toHaveLength(BODY.genres.length + BODY.styles.length);
        expect(atlas.ui.table.querySelector('table').getAttribute('aria-describedby')).toBe('atlasTableHelp');
        expect(atlas.root.querySelector('#atlasTableHelp').textContent).toBe(ATLAS_TABLE_HELP);
        // And back: the loop restarts and the 3D controls return.
        viewButton(atlas, 'strata').click();
        expect(atlas.ui.tableWrap.hidden).toBe(true);
        expect(atlas.ui.stage.hidden).toBe(false);
        expect(atlas.ui.reset.hidden).toBe(false);
        expect(renderer().running).toBe(true);
    });

    it('shares the valid-time scrubber: scrubbing repaints the table and marks a provisional year', async () => {
        const { atlas } = makeAtlas();
        await atlas.show();
        viewButton(atlas, 'table').click();
        const style = BODY.styles.find((s) => s.stages[1960 - BODY.timeline.first_year] !== s.stages.at(-1));
        const cell = (field) => atlas.ui.table.querySelector(`tr[data-id="s:${CSS.escape(style.style)}"] .atlas-cell-${field}`);
        const latest = cell('provisional').textContent;
        expect(latest).toBe('provisional');
        const before = cell('stage').textContent;
        atlas.ui.range.value = '1960';
        atlas.ui.range.dispatchEvent(new Event('input'));
        expect(atlas.ui.table.querySelector('th[data-column="stage"]').textContent).toBe('Stage in 1960');
        expect(cell('provisional').textContent).toBe('settled');
        expect(cell('stage').textContent).not.toBe(before);
        expect(atlas.ui.table.querySelector('caption').textContent).toContain('as of 1960');
        atlas.setYear(BODY.timeline.last_year);
        expect(cell('provisional').textContent).toBe('provisional');
        expect(atlas.ui.note.hidden).toBe(false);
    });

    it('shares the selection and the panel: a row describes the style, and a 3D selection marks its row', async () => {
        const { atlas, renderer } = makeAtlas();
        await atlas.show();
        viewButton(atlas, 'table').click();
        const style = BODY.styles.find((s) => s.parents.length === 2);
        const tr = atlas.ui.table.querySelector(`tr[data-id="s:${CSS.escape(style.style)}"]`);
        tr.click();
        expect(atlas.selected).toBe(`s:${style.style}`);
        expect(renderer().selected).toBe(`s:${style.style}`);
        expect(atlas.ui.selection.querySelector('.strata-selection-title').textContent).toBe(style.style);
        expect(atlas.ui.selection.textContent).toContain(NO_COTAGS);
        expect(atlas.ui.table.querySelector('[aria-current="true"]').dataset.id).toBe(`s:${style.style}`);
        // The panel's parent button selects that genre's row.
        atlas.ui.selection.querySelector('.atlas-parents .atlas-link').click();
        expect(atlas.ui.table.querySelector('[aria-current="true"]').dataset.id).toBe(`g:${style.parents[0].genre}`);
        // A ghost selected in the 3D view marks its style's row.
        const ghost = BODY.ghosts[0];
        atlas.onSelect(`h:${ghost.style}@${ghost.genre}`);
        expect(atlas.ui.table.querySelector('[aria-current="true"]').dataset.id).toBe(`s:${ghost.style}`);
        // Escape on a row clears it.
        const row = atlas.ui.table.querySelector('[aria-current="true"]');
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(atlas.selected).toBeNull();
        expect(atlas.ui.table.querySelector('[aria-current]')).toBeNull();
    });

    it('opens the table before the 3D view without building a renderer, and hands the selection over later', async () => {
        const createRenderer = vi.fn();
        const { atlas, made } = makeAtlas({ createRenderer });
        atlas.setMode('table');
        await atlas.show();
        expect(createRenderer).not.toHaveBeenCalled();
        expect(rowIds(atlas)).toHaveLength(BODY.genres.length + BODY.styles.length);
        atlas.ui.table.querySelector('tbody tr').click();
        const picked = atlas.selected;
        expect(picked).toMatch(/^g:/);
        const stand = new EventTarget();
        Object.assign(stand, { setLayout() {}, setYear() {}, start() {}, stop() {}, resize() {}, select: vi.fn(), solo() {}, dispose() {} });
        createRenderer.mockReturnValue(stand);
        atlas.setMode('strata');
        expect(createRenderer).toHaveBeenCalledTimes(1);
        expect(stand.select).toHaveBeenCalledWith(picked);
        expect(made).toHaveLength(0);
    });

    it('says in the table that masters are not served yet, and drops the 3D plane note and the WebGL note', async () => {
        const { atlas } = makeAtlas();
        await atlas.show();
        atlas.setSolo(2);
        expect(atlas.ui.message.textContent).toBe(NO_MASTERS);
        viewButton(atlas, 'table').click();
        expect(atlas.ui.message.hidden).toBe(true);
        expect(atlas.ui.tableNote.textContent).toBe(`Masters: none served. ${NO_MASTERS}`);
        viewButton(atlas, 'strata').click();
        expect(atlas.ui.message.textContent).toBe(NO_MASTERS);

        const broken = makeAtlas({ createRenderer: () => { throw new Error('no gl'); } });
        await broken.atlas.show();
        expect(broken.atlas.ui.message.textContent).toBe(NO_WEBGL);
        viewButton(broken.atlas, 'table').click();
        expect(broken.atlas.ui.message.hidden).toBe(true);
        expect(rowIds(broken.atlas)).toHaveLength(BODY.genres.length + BODY.styles.length);
    });

    it('shows an empty table before the first monthly run', async () => {
        const body = { rule: BODY.rule, month: null, computed_at: null, timeline: null, genres: [], styles: [], ghosts: [] };
        const { atlas } = makeAtlas({ body });
        await atlas.show();
        viewButton(atlas, 'table').click();
        expect(rowIds(atlas)).toEqual([]);
        expect(atlas.ui.table.querySelector('caption').textContent).toBe('Genres and styles: 0 rows, in outline order.');
        expect(atlas.ui.tableNote.textContent).toBe('');
    });

    it('builds and switches without writing a style attribute or parsing HTML', async () => {
        const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
        const innerHTML = vi.spyOn(Element.prototype, 'innerHTML', 'set');
        const { atlas } = makeAtlas();
        await atlas.show();
        viewButton(atlas, 'table').click();
        atlas.setYear(1990);
        atlas.ui.table.querySelector('tbody tr').click();
        viewButton(atlas, 'strata').click();
        expect(setAttribute.mock.calls.filter(([name]) => String(name).toLowerCase() === 'style')).toEqual([]);
        expect(innerHTML).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});
