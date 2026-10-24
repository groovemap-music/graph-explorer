/**
 * The strata table (strata-table.js): its rows against the layout module's conservation, over the
 * recorded route bodies and over generated route payloads, then the DOM table's sorting, filter,
 * roving focus, and keys.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adaptStrataPayload, layoutStrata } from '../static/js/strata-layout.js';
import { applyClocks, nodeActions } from '../static/js/strata-explore.js';
import { BLOCKED_REASON } from '../static/js/strata-scene.js';
import {
    KIND_LABELS,
    StrataTable,
    TABLE_COLUMNS,
    buildTableRows,
    entryCursor,
    filterRows,
    rowBlocked,
    rowState,
    rowStatus,
    sortRows,
} from '../static/js/strata-table.js';
import { buildPayload, cursorsOf, deepFreeze, generateDiscography, rng } from './strata-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'strata-route.json'), 'utf8'));
const recorded = (focus, page = 0, signedIn = true) => adaptStrataPayload(structuredClone(RECORDED.responses.find((item) => item.query.focus === focus && item.query.page === page && item.query.signed_in === signedIn).body));

const openAction = (node) => nodeActions(node).find((action) => action.id === 'open') ?? null;
const rowsOf = (graph, options = {}) => {
    const view = applyClocks(graph, options.clocks);
    const layout = layoutStrata(view);
    return { view, layout, rows: buildTableRows(view, layout, { signedIn: graph.signedIn, openAction }) };
};

const BUDGETS = [[3, 12, 16], [3, 12, 16], [6, 12, 25], [12, 24, 32], [3, 6, 4], [12, 500, 500]];
const SIZES = [20, 200, 2000];
const PROPERTY_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------------------------
// Conservation against the layout module.
// ---------------------------------------------------------------------------------------------

// Every entry of the view is a row, and the layout holds it in exactly one node.
function expectEveryEntryAsRow(view, layout, rows) {
    const held = new Map();
    for (const node of layout.nodes) for (const id of node.members) held.set(id, (held.get(id) || 0) + 1);
    expect(rows.map((row) => row.id).sort()).toEqual(view.entries.map((entry) => entry.id).sort());
    for (const row of rows) expect(held.get(row.id), `${row.id} held`).toBe(1);
}

/**
 * The table lists every entry of the view once, whether the layout drew it or folded it into a
 * count node, and says which. Its blocked counts add up to the route's totals the way the layout's
 * releases do (the layout test's `expectRouteConserved`).
 */
function expectTableConserved(graph, view, layout, rows) {
    const holders = new Map();
    for (const node of layout.nodes) for (const id of node.members) holders.set(id, [...(holders.get(id) || []), node]);
    expect(rows.map((row) => row.id).sort(), 'one row per entry').toEqual(view.entries.map((entry) => entry.id).sort());
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.map((row) => row.order)).toEqual(rows.map((_, index) => index));

    const rowById = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
        const held = holders.get(row.id);
        expect(held, `${row.id} held by one node`).toHaveLength(1);
        expect(row.drawn, `${row.id} drawn`).toBe(held[0].id === row.id);
        expect(row.heldBy).toBe(held[0].id);
        // The outline order puts every parent before its children, and a path is its ancestors.
        if (row.parentId !== null) {
            expect(rowById.get(row.parentId).order, `${row.id} after its parent`).toBeLessThan(row.order);
            expect(row.path.endsWith(rowById.get(row.parentId).name)).toBe(true);
        } else {
            expect(row.path).toBe('');
        }
        expect(row.kindLabel).toBe(KIND_LABELS[row.kind]);
    }

    // The same releases, MusicBrainz-only pressings, and masters the route places, now as rows.
    const sum = (list, field) => list.reduce((total, row) => total + row[field], 0);
    const at = (level) => rows.filter((row) => row.level === level);
    const groups = rows.filter((row) => row.agg && ((row.level === 1 && row.node.aggKind === 'masters') || row.level === 0));
    const placed = [...at(2), ...groups];
    expect(sum(placed, 'releases'), 'every release placed once').toBe(graph.totals.releases);
    expect(sum(placed, 'blockedCount'), 'every MusicBrainz-only pressing placed once').toBe(graph.totals.musicbrainzReleases);
    // A blocked pressing carries the full reason; a holder says how many it holds.
    for (const row of rows) {
        const entry = view.entries.find((item) => item.id === row.id);
        if (entry.level === 2 && !entry.agg) {
            expect(row.blocked, row.id).toBe(entry.provider === 'musicbrainz' ? BLOCKED_REASON : null);
        } else {
            expect(row.blockedCount, row.id).toBe(entry.musicbrainzReleases);
            expect(row.blocked === null, row.id).toBe(entry.musicbrainzReleases === 0);
        }
    }
}

describe('buildTableRows over the recorded route bodies', () => {
    for (const { query } of RECORDED.responses) {
        it(`holds every entry once: focus ${query.focus ?? 'none'}, page ${query.page}, ${query.signed_in ? 'signed in' : 'anonymous'}`, () => {
            const graph = recorded(query.focus, query.page, query.signed_in);
            const { view, layout, rows } = rowsOf(graph);
            expectTableConserved(graph, view, layout, rows);
        });
    }

    it('lists the root credit first, then its masters, lanes, and pressings as an outline', () => {
        const graph = recorded(null);
        const { rows } = rowsOf(graph);
        expect(rows[0]).toMatchObject({ id: graph.rootCredit, kind: 'credit', path: '', level: 0 });
        const pressing = rows.find((row) => row.kind === 'pressing' && row.path.includes(' › '));
        expect(pressing.path).toMatch(/^The Placeholder Band › /);
        const kinds = new Set(rows.map((row) => row.kind));
        for (const kind of ['credit', 'creditGroup', 'master', 'masterGroup', 'lane', 'pressing', 'pressingGroup']) expect(kinds, kind).toContain(kind);
    });

    it('says which entries sit inside a count node, and which node', () => {
        const { rows, layout } = rowsOf(recorded(null));
        const folded = rows.filter((row) => !row.drawn);
        expect(folded.length).toBeGreaterThan(0);
        for (const row of folded) {
            const holder = layout.nodes.find((node) => node.id === row.heldBy);
            expect(holder.origin).toBe('fold');
            expect(row.drawnText).toContain('in “');
            expect(row.node.origin).toBe('fold');
            // A folded pressing is reached through the cursor that pages its parent.
            if (row.level === 2 && !row.agg) expect(row.open).toMatchObject({ id: 'open', cursor: row.parentId });
        }
        for (const row of rows.filter((item) => item.drawn)) {
            expect(row.drawnText).toBe('drawn');
            expect(row.node.origin).toBe('payload');
        }
    });

    it('offers the 3D view\'s open action on groups and masters, with the same cursor', () => {
        const { rows, layout } = rowsOf(recorded(null));
        const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
        for (const row of rows.filter((item) => item.drawn)) {
            expect(row.open?.cursor ?? null, row.id).toBe(nodes.get(row.id).cursor ?? null);
            expect(row.node.cursor).toBe(entryCursor(row.node));
        }
        expect(rows.filter((row) => row.agg).every((row) => row.open && row.open.cursor === row.id)).toBe(true);
        expect(rows.find((row) => row.kind === 'master').open.label).toBe('Show its pressings');
    });

    it('is the 3D view\'s page: a focused response lists the page\'s members and the rest in one group', () => {
        const graph = recorded('ra:m:70030', 0);
        const { rows } = rowsOf(graph);
        const remainder = rows.find((row) => row.id === 'ra:m:70030');
        expect(remainder).toMatchObject({ kind: 'pressingGroup', agg: true });
        const members = rows.filter((row) => row.parentId === 'm:70030' && row.kind === 'pressing');
        expect(members).toHaveLength(graph.focus.pageSize);
        expect(members.length + remainder.releases).toBe(graph.focus.members);
    });

    it('names a pressing\'s state, a group\'s counts, and what is unknown', () => {
        const signed = rowsOf(recorded(null)).rows;
        expect(signed.find((row) => row.kind === 'credit').state).toBe('owned');
        expect(signed.find((row) => row.kind === 'masterGroup').state).toMatch(/^\d+ \w+( · \d+ [\w +]+)*$/);
        expect(signed.find((row) => row.kind === 'pressing' && row.stateKey === 'wanted-owned').state).toBe('wanted + owned');
        const anonymous = rowsOf(recorded(null, 0, false)).rows;
        expect(anonymous.filter((row) => row.kind !== 'pressing' || row.blocked === null).every((row) => row.state === 'not signed in')).toBe(true);
        const past = rowsOf(recorded(null), { clocks: { recordedAsOf: Date.parse('2012-01-01T00:00:00Z') } }).rows;
        expect(past.find((row) => row.kind === 'pressingGroup').state).toBe('not known');
    });
});

describe('buildTableRows over generated route payloads', () => {
    it('holds every entry once and every blocked reason, whatever the shape (200 discographies)', () => {
        const seen = { folded: 0, blocked: 0, lanes: 0, signedIn: 0, undated: 0 };
        for (let seed = 1; seed <= 200; seed++) {
            const r = rng(seed);
            try {
                const catalog = generateDiscography(r, { maxReleases: r.pick(SIZES) });
                const budget = r.pick(BUDGETS);
                const signedIn = r.chance(0.5);
                const payload = deepFreeze(buildPayload(catalog, budget, { signedIn, r }));
                const graph = adaptStrataPayload(payload);
                const { view, layout, rows } = rowsOf(graph);
                expectTableConserved(graph, view, layout, rows);
                seen.folded += rows.some((row) => !row.drawn) ? 1 : 0;
                seen.blocked += rows.some((row) => row.blocked) ? 1 : 0;
                seen.lanes += rows.some((row) => row.kind === 'lane') ? 1 : 0;
                seen.signedIn += signedIn ? 1 : 0;
                seen.undated += rows.some((row) => row.yearText === 'no year') ? 1 : 0;
                // Every blocked pressing the route sent is listed with its reason, drawn or folded.
                const sent = payload.planes[2].nodes.filter((node) => node.provider === 'musicbrainz').map((node) => node.id);
                expect(rows.filter((row) => row.blocked === BLOCKED_REASON).map((row) => row.id).sort()).toEqual(sent.sort());
            } catch (error) {
                error.message = `seed ${seed}: ${error.message}`;
                throw error;
            }
        }
        for (const [shape, count] of Object.entries(seen)) expect(count, shape).toBeGreaterThan(0);
    }, PROPERTY_TIMEOUT_MS);

    it('holds every entry of every server page of a cursor (100 discographies)', () => {
        let pages = 0;
        for (let seed = 5001; seed <= 5100; seed++) {
            const r = rng(seed);
            try {
                const catalog = generateDiscography(r, { maxReleases: r.pick(SIZES) });
                const budget = r.pick(BUDGETS);
                const signedIn = r.chance(0.5);
                const overview = buildPayload(catalog, budget, { signedIn, r });
                const cursor = r.pick(cursorsOf(overview));
                if (!cursor) continue;
                const first = adaptStrataPayload(buildPayload(catalog, budget, { focus: cursor, signedIn, r }));
                for (let page = 0; page < first.focus.pages; page++) {
                    const graph = adaptStrataPayload(deepFreeze(buildPayload(catalog, budget, { focus: cursor, page, signedIn, r })));
                    const { view, layout, rows } = rowsOf(graph);
                    expectTableConserved(graph, view, layout, rows);
                    pages++;
                }
            } catch (error) {
                error.message = `seed ${seed}: ${error.message}`;
                throw error;
            }
        }
        expect(pages).toBeGreaterThan(100);
    }, PROPERTY_TIMEOUT_MS);

    it('follows the clocks the 3D view follows: a hidden entry is no row, a collected filter keeps ancestors', () => {
        const graph = recorded(null);
        const all = rowsOf(graph).rows;
        const early = rowsOf(graph, { clocks: { beforeYear: 1995 } });
        expect(early.rows.length).toBeLessThan(all.length);
        expect(early.view.hidden).toBeGreaterThan(0);
        expectEveryEntryAsRow(early.view, early.layout, early.rows);
        const collected = rowsOf(graph, { clocks: { onlyCollected: true } });
        expectEveryEntryAsRow(collected.view, collected.layout, collected.rows);
        const ids = new Set(collected.rows.map((row) => row.id));
        expect(ids.size).toBeLessThan(all.length);
        for (const row of collected.rows) if (row.parentId) expect(ids.has(row.parentId), `${row.id} keeps its parent`).toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------
// Rows, sorting, filter.
// ---------------------------------------------------------------------------------------------

describe('rowState and rowBlocked', () => {
    const pressing = (extra) => ({ id: 'r:1', level: 2, agg: false, provider: 'discogs', state: 'none', states: null, musicbrainzReleases: 0, ...extra });

    it('words a pressing\'s state, a MusicBrainz-only pressing, and a signed-out caller', () => {
        expect(rowState(pressing({ state: 'owned' }), { signedIn: true })).toEqual({ text: 'owned', key: 'owned' });
        expect(rowState(pressing({ state: 'wanted-owned' }), { signedIn: true }).text).toBe('wanted + owned');
        expect(rowState(pressing({ provider: 'musicbrainz', state: null }), { signedIn: true })).toEqual({ text: 'no state', key: null });
        expect(rowState(pressing({ provider: 'musicbrainz', state: null }), { signedIn: false }).text).toBe('no state');
        expect(rowState(pressing({ state: null }), { signedIn: false })).toEqual({ text: 'not signed in', key: null });
        expect(rowState(pressing({ state: null }), { signedIn: true }).text).toBe('not known');
        expect(rowState({ ...pressing(), agg: true, state: null, states: { owned: 2, none: 5, wanted: 0 } }, { signedIn: true }).text).toBe('5 none · 2 owned');
    });

    it('gives a blocked pressing the full reason and a holder the count', () => {
        expect(rowBlocked(pressing({ provider: 'musicbrainz', id: 'mb:x' }))).toEqual({ text: BLOCKED_REASON, count: 1 });
        expect(rowBlocked(pressing())).toBeNull();
        expect(rowBlocked({ id: 'ra:m:1', level: 2, agg: true, musicbrainzReleases: 1 }).text).toBe('1 pressing here exist only in MusicBrainz and cannot change state (ADR 0009). Open this row to list them.');
        expect(rowBlocked({ id: 'c:1', level: 0, agg: false, musicbrainzReleases: 3 })).toMatchObject({ count: 3, text: expect.stringContaining('3 pressings here') });
        expect(rowBlocked({ id: 'c:1', level: 0, agg: false, musicbrainzReleases: 0 })).toBeNull();
    });
});

// A page whose pressings include a MusicBrainz-only one, drawn.
const BLOCKED_PAGE = ['ra:m:70025', 0];

describe('sortRows and filterRows', () => {
    const { rows } = rowsOf(recorded(...BLOCKED_PAGE));
    const column = (list, id) => list.map((row) => row[id]);

    it('keeps the outline order with no sort, and never changes its input', () => {
        const copy = rows.slice();
        expect(sortRows(rows, null).map((row) => row.id)).toEqual(rows.map((row) => row.id));
        expect(sortRows(rows, { column: 'nonsense', direction: 'ascending' }).map((row) => row.id)).toEqual(rows.map((row) => row.id));
        sortRows(rows, { column: 'name', direction: 'descending' });
        expect(rows).toEqual(copy);
    });

    for (const { id, sort } of TABLE_COLUMNS) {
        if (!sort) continue;
        it(`sorts by ${id} both ways without losing or duplicating a row`, () => {
            const up = sortRows(rows, { column: id, direction: 'ascending' });
            const down = sortRows(rows, { column: id, direction: 'descending' });
            for (const sorted of [up, down]) expect(sorted.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
        });
    }

    it('orders names, years, and counts, with empty years and reasons last either way', () => {
        const rows = rowsOf(recorded(null)).rows;
        const names = column(sortRows(rows, { column: 'name', direction: 'ascending' }), 'name');
        expect(names).toEqual([...names].sort((a, b) => new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare(a, b)));
        for (const direction of ['ascending', 'descending']) {
            const byYear = sortRows(rows, { column: 'year', direction });
            const dated = byYear.filter((row) => row.year !== null).map((row) => row.year);
            expect(dated).toEqual([...dated].sort((a, b) => (direction === 'ascending' ? a - b : b - a)));
            const firstEmpty = byYear.findIndex((row) => row.year === null);
            expect(firstEmpty).toBeGreaterThan(-1);
            expect(byYear.slice(firstEmpty).every((row) => row.year === null)).toBe(true);
            const byReason = sortRows(rows, { column: 'blocked', direction });
            const firstNone = byReason.findIndex((row) => row.blocked === null);
            expect(byReason.slice(firstNone).every((row) => row.blocked === null)).toBe(true);
            expect(byReason.slice(0, firstNone).every((row) => row.blocked !== null)).toBe(true);
        }
        const counts = column(sortRows(rows, { column: 'releases', direction: 'descending' }), 'releases');
        expect(counts).toEqual([...counts].sort((a, b) => b - a));
        const drawn = sortRows(rows, { column: 'drawn', direction: 'ascending' });
        expect(drawn.findIndex((row) => !row.drawn)).toBeGreaterThan(drawn.findLastIndex((row) => row.drawn));
    });

    it('is stable: equal keys keep the outline order', () => {
        const byKind = sortRows(rows, { column: 'kind', direction: 'ascending' });
        for (let i = 1; i < byKind.length; i++) {
            if (byKind[i - 1].kind === byKind[i].kind) expect(byKind[i - 1].order).toBeLessThan(byKind[i].order);
        }
    });

    it('filters to what cannot change state without dropping any such row', () => {
        const blocked = filterRows(rows, { blockedOnly: true });
        expect(blocked.length).toBeGreaterThan(0);
        expect(blocked.map((row) => row.id).sort()).toEqual(rows.filter((row) => row.blocked !== null).map((row) => row.id).sort());
        expect(filterRows(rows)).toBe(rows);
        // Task 2: each of the route's MusicBrainz-only pressings is listed, with its reason.
        const pressings = blocked.filter((row) => row.blocked === BLOCKED_REASON);
        expect(pressings.length).toBeGreaterThan(0);
    });
});

describe('rowStatus', () => {
    it('says the count and the order in a sentence', () => {
        expect(rowStatus({ shown: 1, total: 1 })).toBe('1 row, in outline order.');
        expect(rowStatus({ shown: 5, total: 31, sort: { column: 'year', direction: 'descending' } })).toBe('5 rows, sorted by year, descending.');
        expect(rowStatus({ shown: 3, total: 31, blockedOnly: true })).toBe('3 of 31 rows that cannot change state, in outline order.');
    });
});

// ---------------------------------------------------------------------------------------------
// The DOM.
// ---------------------------------------------------------------------------------------------

describe('StrataTable', () => {
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
        calls = { select: [], open: [], status: [] };
        rows = rowsOf(recorded(...BLOCKED_PAGE)).rows;
        table = new StrataTable({
            host,
            onSelect: (id) => calls.select.push(id),
            onOpen: (cursor) => calls.open.push(cursor),
            onStatus: (text) => calls.status.push(text),
        });
        table.setRows(rows);
    });

    afterEach(() => {
        document.body.textContent = '';
    });

    it('is a native table: a caption, column headers with scope, and a row header per row', () => {
        const element = host.querySelector('table');
        expect(element.querySelector('caption').textContent).toBe(`Credits, masters, and pressings: ${rows.length} rows, in outline order.`);
        const headers = [...element.querySelectorAll('thead th')];
        expect(headers.map((th) => th.scope)).toEqual(headers.map(() => 'col'));
        expect(headers.map((th) => th.textContent)).toEqual(TABLE_COLUMNS.map((column) => column.label));
        expect(element.getAttribute('aria-describedby')).toBe('strataTableHelp');
        expect(ids()).toEqual(rows.map((row) => row.id));
        for (const th of element.querySelectorAll('tbody th')) expect(th.scope).toBe('row');
        const cells = [...rowEl(rows[0].id).children].map((cell) => cell.textContent);
        expect(cells.slice(0, 2)).toEqual(['Credit', rows[0].name]);
        // Every column the spike's table has: plane, name, under, year, state, reason.
        const blockedRow = rows.find((row) => row.blocked === BLOCKED_REASON);
        expect(rowEl(blockedRow.id).querySelector('.strata-cell-blocked').textContent).toBe(BLOCKED_REASON);
        expect(rowEl(blockedRow.id).querySelector('.strata-chip--blocked').textContent).toBe('no state');
    });

    it('writes no style attribute and no markup the policy would refuse', () => {
        expect(host.querySelectorAll('[style]')).toHaveLength(0);
        const html = host.innerHTML;
        expect(html).not.toMatch(/\sstyle=/i);
        expect(html).not.toMatch(/<script/i);
    });

    it('puts text from the route in as text, never as markup', () => {
        const hostile = { ...rows[1], id: 'r:evil', name: '<img src=x onerror=alert(1)>', path: '<b>x</b>' };
        table.setRows([...rows, hostile]);
        expect(host.querySelector('img')).toBeNull();
        expect(rowEl('r:evil').querySelector('th').textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('has exactly one row in the tab order, and the Open buttons stay out of it', () => {
        expect([...host.querySelectorAll('tbody tr')].filter((tr) => tr.tabIndex === 0)).toHaveLength(1);
        expect(rowEl(rows[0].id).tabIndex).toBe(0);
        const buttons = [...host.querySelectorAll('.strata-table-open')];
        expect(buttons.length).toBeGreaterThan(0);
        expect(buttons.every((button) => button.tabIndex === -1)).toBe(true);
        expect(buttons[0].getAttribute('aria-label')).toMatch(/^.+: .+$/);
    });

    it('sorts from a header button: ascending, descending, then the outline order, announcing each', () => {
        const button = header('name').querySelector('button');
        button.click();
        expect(header('name').getAttribute('aria-sort')).toBe('ascending');
        expect(ids()).toEqual(sortRows(rows, { column: 'name', direction: 'ascending' }).map((row) => row.id));
        expect(calls.status.at(-1)).toBe(`${rows.length} rows, sorted by name, ascending.`);
        button.click();
        expect(header('name').getAttribute('aria-sort')).toBe('descending');
        header('year').querySelector('button').click();
        expect(header('name').getAttribute('aria-sort')).toBe('none');
        expect(header('year').getAttribute('aria-sort')).toBe('ascending');
        header('year').querySelector('button').click();
        header('year').querySelector('button').click();
        expect(header('year').getAttribute('aria-sort')).toBe('none');
        expect(ids()).toEqual(rows.map((row) => row.id));
        expect(calls.status.at(-1)).toBe(`${rows.length} rows, in outline order.`);
        expect(header('open').hasAttribute('aria-sort')).toBe(false);
        expect(host.querySelector('thead button:focus')).toBeNull();
    });

    it('filters to what cannot change state and says how many rows that is', () => {
        table.setFilter({ blockedOnly: true });
        const expected = rows.filter((row) => row.blocked !== null).map((row) => row.id);
        expect(ids()).toEqual(expected);
        expect(calls.status.at(-1)).toBe(`${expected.length} of ${rows.length} rows that cannot change state, in outline order.`);
        expect(host.querySelector('caption').textContent).toContain('that cannot change state');
        table.setFilter({ blockedOnly: false });
        expect(ids()).toHaveLength(rows.length);
    });

    it('moves focus with the arrows, Home, and End, and keeps one tab stop', () => {
        const first = rowEl(rows[0].id);
        first.focus();
        expect(key(first, 'ArrowDown').defaultPrevented).toBe(true);
        expect(document.activeElement.dataset.id).toBe(rows[1].id);
        expect(rowEl(rows[1].id).tabIndex).toBe(0);
        expect(first.tabIndex).toBe(-1);
        key(document.activeElement, 'ArrowUp');
        expect(document.activeElement.dataset.id).toBe(rows[0].id);
        key(document.activeElement, 'ArrowUp');
        expect(document.activeElement.dataset.id).toBe(rows[0].id);
        key(document.activeElement, 'End');
        expect(document.activeElement.dataset.id).toBe(rows.at(-1).id);
        key(document.activeElement, 'ArrowDown');
        expect(document.activeElement.dataset.id).toBe(rows.at(-1).id);
        key(document.activeElement, 'Home');
        expect(document.activeElement.dataset.id).toBe(rows[0].id);
        expect([...host.querySelectorAll('tbody tr')].filter((tr) => tr.tabIndex === 0)).toHaveLength(1);
        expect(calls.select).toEqual([]);
    });

    it('walks to the parent with PageUp and the first child with PageDown, as the 3D view does', () => {
        const child = rows.find((row) => row.kind === 'pressing' && row.parentId && rows.some((item) => item.id === row.parentId && item.kind === 'master'));
        const parent = rows.find((row) => row.id === child.parentId);
        rowEl(child.id).focus();
        key(rowEl(child.id), 'PageUp');
        expect(document.activeElement.dataset.id).toBe(parent.id);
        key(document.activeElement, 'PageDown');
        expect(rows.find((row) => row.id === document.activeElement.dataset.id).parentId).toBe(parent.id);
        // A row with no child stays put, and the root has no parent.
        const leaf = rows.find((row) => row.kind === 'pressing' && !rows.some((item) => item.parentId === row.id));
        rowEl(leaf.id).focus();
        key(rowEl(leaf.id), 'PageDown');
        expect(document.activeElement.dataset.id).toBe(leaf.id);
        rowEl(rows[0].id).focus();
        key(rowEl(rows[0].id), 'PageUp');
        expect(document.activeElement.dataset.id).toBe(rows[0].id);
    });

    it('selects with Space or a click, opens with Enter, and clears with Escape', () => {
        const master = rows.find((row) => row.kind === 'master');
        const leaf = rows.find((row) => row.kind === 'pressing' && !row.open);
        rowEl(leaf.id).focus();
        expect(key(rowEl(leaf.id), ' ').defaultPrevented).toBe(true);
        expect(calls.select).toEqual([leaf.id]);
        key(rowEl(leaf.id), 'Enter');
        expect(calls.select).toEqual([leaf.id, leaf.id]);
        expect(calls.open).toEqual([]);

        rowEl(master.id).focus();
        key(rowEl(master.id), 'Enter');
        expect(calls.open).toEqual([master.id]);

        table.select(leaf.id);
        expect(rowEl(leaf.id).getAttribute('aria-current')).toBe('true');
        expect(host.querySelectorAll('[aria-current]')).toHaveLength(1);
        key(rowEl(leaf.id), 'Escape');
        expect(calls.select.at(-1)).toBeNull();
        table.select(null);
        expect(host.querySelectorAll('[aria-current]')).toHaveLength(0);
        const before = calls.select.length;
        key(rowEl(leaf.id), 'Escape');
        expect(calls.select).toHaveLength(before);

        rowEl(leaf.id).click();
        expect(calls.select.at(-1)).toBe(leaf.id);
        host.querySelector(`tr[data-id="${CSS.escape(master.id)}"] .strata-table-open`).click();
        expect(calls.open.at(-1)).toBe(master.id);
    });

    it('opens a folded pressing through its parent\'s cursor', () => {
        const overview = rowsOf(recorded(null)).rows;
        table.setRows(overview);
        const folded = overview.find((row) => !row.drawn && row.kind === 'pressing');
        rowEl(folded.id).focus();
        key(rowEl(folded.id), 'Enter');
        expect(calls.open).toEqual([folded.parentId]);
    });

    it('leaves keys with a modifier, other keys, and keys on its buttons to the browser', () => {
        const row = rowEl(rows[0].id);
        row.focus();
        for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) expect(key(row, 'ArrowDown', init).defaultPrevented).toBe(false);
        expect(key(row, 'a').defaultPrevented).toBe(false);
        expect(document.activeElement.dataset.id).toBe(rows[0].id);
        const button = host.querySelector('.strata-table-open');
        expect(key(button, 'ArrowDown').defaultPrevented).toBe(false);
        expect(key(host.querySelector('tbody'), 'ArrowDown').defaultPrevented).toBe(false);
    });

    it('keeps focus on its row through a redraw, and on the tab stop when the row is gone', () => {
        const row = rows[3];
        rowEl(row.id).focus();
        table.setRows(rows.map((item) => ({ ...item })));
        expect(document.activeElement.dataset.id).toBe(row.id);
        table.setRows(rows.filter((item) => item.id !== row.id));
        expect(document.activeElement.tagName).toBe('TR');
        expect(document.activeElement.tabIndex).toBe(0);
        // Focus elsewhere is left alone.
        header('name').querySelector('button').focus();
        table.setRows(rows);
        expect(document.activeElement).toBe(header('name').querySelector('button'));
    });

    it('draws an empty table and a selection that is not in it', () => {
        table.setRows([], { selected: 'x' });
        expect(ids()).toEqual([]);
        expect(host.querySelector('caption').textContent).toContain('0 rows');
        table.select('x');
        table.setRows(rows, { selected: rows[2].id });
        expect(rowEl(rows[2].id).getAttribute('aria-current')).toBe('true');
        expect(rowEl(rows[2].id).tabIndex).toBe(0);
    });

    it('survives a missing status callback and a row without an action', () => {
        const quiet = new StrataTable({ host: document.createElement('div') });
        quiet.setRows(rows.map((row) => ({ ...row, open: null })));
        quiet.sortBy('year');
        quiet.setFilter({ blockedOnly: true });
        expect(quiet.body.children.length).toBeGreaterThan(0);
        expect(quiet.body.querySelector('.strata-table-open')).toBeNull();
    });
});
