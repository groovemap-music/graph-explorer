/**
 * The Genre Atlas table: the atlas as rows. Like the Discography Strata table it is a peer of the
 * 3D view, not a fallback (ADR 0016 section 1), and it needs no WebGL.
 *
 * It lists every genre and every style the atlas drew, with the stage the scrubbed year gives it,
 * whether that year is provisional, the latest and settled stages, the emergence year, the parent
 * genres with their shares, the dominant parent, and whether each emergence edge is drawn. It reads
 * the layout the 3D view draws from after `paintAtlas`, so its stages and provisional flags are the
 * 3D view's. Ghost copies are not rows: they are the same style drawn again, and the Parents column
 * says where.
 *
 * For a signed-in collector with a taste projection it gains a "Yours" column, the table's
 * equivalent of the Taste Strata marks (ADR 0016): the items the collector holds on each genre and
 * style, and their collector state, read from the `held` that `paintTaste` left on the layout, so it
 * follows the "recorded as of" year as the marks do. It is never part of the table for anyone else.
 *
 * Two halves:
 *   - pure functions (`buildAtlasRows`, `sortAtlasRows`, `atlasRowStatus`) that Vitest covers with
 *     no DOM;
 *   - `AtlasTable`, the DOM: a native table with a caption, column headers that sort, a roving
 *     tabindex over its rows, and arrow, Home, End, PageUp, PageDown, Space, Enter, and Escape keys.
 *
 * The DOM is built with createElement and textContent only, and styled through classes in
 * strata-atlas.css and strata.css, so the `style-src 'self'` policy the renderer holds still holds.
 */

import { genreId } from './strata-atlas-layout.js';
import { stateLabel } from './strata-collector.js';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The columns, in order. `stage` is relabelled with the scrubbed year (see `columnLabel`). */
export const ATLAS_TABLE_COLUMNS = Object.freeze([
    Object.freeze({ id: 'kind', label: 'Kind' }),
    Object.freeze({ id: 'name', label: 'Name' }),
    Object.freeze({ id: 'stage', label: 'Stage' }),
    Object.freeze({ id: 'provisional', label: 'Provisional' }),
    Object.freeze({ id: 'latest', label: 'Latest stage' }),
    Object.freeze({ id: 'settled', label: 'Settled stage' }),
    Object.freeze({ id: 'emerged', label: 'Emerged' }),
    Object.freeze({ id: 'dominant', label: 'Dominant parent' }),
    Object.freeze({ id: 'parents', label: 'Parents (share of releases)' }),
    Object.freeze({ id: 'edges', label: 'Emergence edges drawn' }),
]);

/**
 * The collector's column, present only when a projection is on the atlas. Its `description` is read
 * to a screen reader after the label, so the column says what it counts and in which words.
 */
export const YOURS_COLUMN = Object.freeze({
    id: 'yours',
    label: 'Yours',
    description: 'the items you hold on this genre or style, and their collector state',
});

export const ATLAS_TABLE_HELP = 'Up and Down move between rows, Home and End go to the first and last. PageUp moves to a style\'s dominant parent genre and PageDown to a genre\'s first style. Space or Enter selects a row and describes it in the panel. Escape clears the selection. Column headers are buttons that sort. The year slider scrubs valid time, as in the 3D view.';

export const KIND_WORDS = Object.freeze({ genre: 'Genre', style: 'Style' });

/** The columns of the table: Yours follows Name when there is a collector's layer. */
export function atlasColumns(yours = false) {
    if (!yours) return ATLAS_TABLE_COLUMNS;
    const at = ATLAS_TABLE_COLUMNS.findIndex((column) => column.id === 'name') + 1;
    return [...ATLAS_TABLE_COLUMNS.slice(0, at), YOURS_COLUMN, ...ATLAS_TABLE_COLUMNS.slice(at)];
}

/** The label a column shows. The stage column names the scrubbed year. */
export function columnLabel(column, year) {
    return column.id === 'stage' && year !== null && year !== undefined ? `Stage in ${year}` : column.label;
}

/** The words of a row's Yours cell, which are also what a screen reader hears. */
export function yoursText(held, heldLater, year) {
    if (held) return `${stateLabel(held.state)} ${plural(held.items, 'item')} (${held.owned} owned, ${held.wanted} wanted)`;
    return heldLater ? `first recorded after ${year}` : 'not held';
}

function stageWord(stage) {
    return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'No stage';
}

function percent(share) {
    return `${Math.round(share * 100)}%`;
}

function plural(count, one, many = `${one}s`) {
    return `${count} ${count === 1 ? one : many}`;
}

/** The emergence edges of a style, one clause per parent, so each says whether its edge is drawn. */
export function edgesText(parents) {
    return parents.map((parent) => `${parent.genre}: ${parent.emergenceEdge ? 'drawn' : 'not drawn'}`).join(' · ');
}

/**
 * One row for every genre and every style of a painted layout, in outline order: a genre, then the
 * styles drawn under it.
 *
 * @param {{nodes: object[], atlas: object}} layout - `layoutAtlas` output, painted for the scrubbed
 *   year by `paintAtlas` (each node's `stage` and `provisional`) and, for a collector, by
 *   `paintTaste` (each node's `held`)
 * @param {{year?: number | null}} options - the "recorded as of" year `paintTaste` was given, which
 *   words a row held but first recorded later
 * @returns {Array<object>}
 */
export function buildAtlasRows(layout, { year = null } = {}) {
    const { rule } = layout.atlas;
    const rank = new Map(rule.stages.map((stage, index) => [stage, index]));
    const rankOf = (stage) => (stage && rank.has(stage) ? rank.get(stage) : null);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const rows = [];
    // What the collector holds on a node, or null: `paintTaste` sets `held` and `heldLater` on every
    // node, and leaves them unset when there is no projection.
    const yours = (node) => ({
        held: node.held ?? null,
        heldItems: node.held ? node.held.items : null,
        yoursText: yoursText(node.held ?? null, !!node.heldLater, year),
    });
    const add = (row) => rows.push({ ...row, order: rows.length });
    const genres = layout.nodes.filter((node) => node.entity === 'genre').sort((a, b) => a.ringOrder - b.ringOrder || a.id.localeCompare(b.id));
    for (const genre of genres) {
        add({
            id: genre.id,
            kind: 'genre',
            kindLabel: KIND_WORDS.genre,
            name: genre.label,
            parentId: null,
            stage: genre.stage,
            stageText: stageWord(genre.stage),
            stageRank: rankOf(genre.stage),
            provisional: false,
            provisionalText: 'n/a',
            latestText: 'n/a',
            latestRank: null,
            settledText: 'n/a',
            settledRank: null,
            emergenceYear: genre.emergenceYear,
            emergedText: genre.emergenceYear === null ? 'not yet' : String(genre.emergenceYear),
            dominant: '',
            parents: [],
            parentsText: '',
            edgesText: '',
            edgesDrawn: 0,
            ...yours(genre),
        });
        const styles = genre.children.map((id) => byId.get(id)).filter((node) => node.entity === 'style').sort((a, b) => collator.compare(a.label, b.label));
        for (const node of styles) {
            const style = node.data;
            const dominant = style.parents.find((parent) => parent.dominant)?.genre ?? style.genre;
            add({
                id: node.id,
                kind: 'style',
                kindLabel: KIND_WORDS.style,
                name: node.label,
                parentId: genreId(dominant),
                stage: node.stage,
                stageText: stageWord(node.stage),
                stageRank: rankOf(node.stage),
                provisional: node.provisional,
                provisionalText: node.provisional ? 'provisional' : 'settled',
                latest: style.stage,
                latestText: stageWord(style.stage),
                latestRank: rankOf(style.stage),
                settled: style.settledStage,
                settledText: style.settledStage ? stageWord(style.settledStage) : 'before the timeline',
                settledRank: rankOf(style.settledStage),
                emergenceYear: style.emergenceYear,
                emergedText: style.emergenceYear === null ? 'not yet' : String(style.emergenceYear),
                dominant,
                parents: style.parents,
                parentsText: style.parents.map((parent) => `${parent.genre} ${percent(parent.share)}`).join(' · '),
                edgesText: edgesText(style.parents),
                edgesDrawn: style.parents.filter((parent) => parent.emergenceEdge).length,
                ...yours(node),
            });
        }
    }
    return rows;
}

const COMPARE = {
    kind: (a, b) => a.kind.localeCompare(b.kind),
    name: (a, b) => collator.compare(a.name, b.name),
    stage: (a, b) => a.stageRank - b.stageRank,
    provisional: (a, b) => Number(a.provisional) - Number(b.provisional),
    latest: (a, b) => a.latestRank - b.latestRank,
    settled: (a, b) => a.settledRank - b.settledRank,
    emerged: (a, b) => a.emergenceYear - b.emergenceYear,
    dominant: (a, b) => collator.compare(a.dominant, b.dominant),
    parents: (a, b) => a.parents.length - b.parents.length,
    edges: (a, b) => a.edgesDrawn - b.edgesDrawn,
    // Most held first when descending; a tie in items falls to the outline order.
    yours: (a, b) => a.heldItems - b.heldItems,
};

// A row with nothing in the column goes last, whichever way the column sorts.
const EMPTY = {
    stage: (row) => row.stageRank === null,
    latest: (row) => row.latestRank === null,
    settled: (row) => row.settledRank === null,
    emerged: (row) => row.emergenceYear === null,
    dominant: (row) => row.dominant === '',
    yours: (row) => row.heldItems === null,
};

/**
 * Rows in a column's order. `sort` is `{column, direction: 'ascending' | 'descending'}`, or null for
 * the outline order. The sort is stable: ties keep the outline order.
 */
export function sortAtlasRows(rows, sort) {
    if (!sort || !COMPARE[sort.column]) return rows.slice();
    const sign = sort.direction === 'descending' ? -1 : 1;
    const empty = EMPTY[sort.column];
    return rows.slice().sort((a, b) => {
        if (empty) {
            const ea = empty(a);
            const eb = empty(b);
            if (ea !== eb) return ea ? 1 : -1;
            if (ea) return a.order - b.order;
        }
        return sign * COMPARE[sort.column](a, b) || a.order - b.order;
    });
}

/** The sentence a screen reader hears after the rows change. */
export function atlasRowStatus({ shown, year = null, sort = null }) {
    const column = sort ? [...ATLAS_TABLE_COLUMNS, YOURS_COLUMN].find((item) => item.id === sort.column) : null;
    const order = column ? `sorted by ${columnLabel(column, year).toLowerCase()}, ${sort.direction}` : 'in outline order';
    return `${plural(shown, 'row')}${year === null ? '' : ` as of ${year}`}, ${order}.`;
}

// ---------------------------------------------------------------------------------------------
// The DOM.
// ---------------------------------------------------------------------------------------------

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

/**
 * The table in the page. `host` is an empty element; the table builds a native `<table>` in it.
 * Callbacks: `onSelect(id | null)` when a row is chosen or cleared, `onStatus(text)` for the live
 * sentence after sorting.
 */
export class AtlasTable {
    constructor({ doc = globalThis.document, host, helpId = null, onSelect = () => {}, onStatus = () => {} } = {}) {
        this.doc = doc;
        this.host = host;
        this.helpId = helpId;
        this.onSelect = onSelect;
        this.onStatus = onStatus;
        this.sort = null;
        this.year = null;
        this.yours = false;
        this.rows = [];
        this.shown = [];
        this.selected = null;
        this.stop = null;
        this.build();
    }

    build() {
        const { doc } = this;
        this.table = el(doc, 'table', 'strata-table atlas-table');
        this.caption = el(doc, 'caption', 'strata-table-caption');
        this.head = el(doc, 'thead');
        this.body = el(doc, 'tbody');
        this.headRow = el(doc, 'tr');
        this.head.append(this.headRow);
        this.buildHead(false);
        this.table.append(this.caption, this.head, this.body);
        if (this.helpId) this.table.setAttribute('aria-describedby', this.helpId);
        this.body.addEventListener('keydown', (event) => this.handleKey(event));
        this.body.addEventListener('click', (event) => this.handleClick(event));
        this.host.replaceChildren(this.table);
    }

    // The header cells for the columns in play. Rebuilt only when Yours comes or goes.
    buildHead(yours) {
        const { doc } = this;
        this.yours = yours;
        this.columns = atlasColumns(yours);
        this.headers = new Map();
        this.sorters = new Map();
        this.headRow.replaceChildren();
        for (const column of this.columns) {
            const th = el(doc, 'th');
            th.scope = 'col';
            th.dataset.column = column.id;
            const button = el(doc, 'button', 'strata-table-sort', column.label);
            button.type = 'button';
            button.addEventListener('click', () => this.sortBy(column.id));
            th.append(button);
            th.setAttribute('aria-sort', 'none');
            this.headers.set(column.id, th);
            this.sorters.set(column.id, button);
            this.headRow.append(th);
        }
    }

    /** Sort by a column: ascending, then descending, then the outline order again. */
    sortBy(column) {
        if (!this.sort || this.sort.column !== column) this.sort = { column, direction: 'ascending' };
        else if (this.sort.direction === 'ascending') this.sort = { column, direction: 'descending' };
        else this.sort = null;
        this.draw({ announce: true });
        return this.sort;
    }

    /**
     * Replace the rows (a new year, a new atlas) and keep the user's place and sort. `yours` adds
     * the collector's column; a sort on a column that goes away is dropped.
     */
    setRows(rows, { year = this.year, selected = this.selected, yours = this.yours } = {}) {
        if (!!yours !== this.yours) {
            this.buildHead(!!yours);
            if (this.sort && !this.headers.has(this.sort.column)) this.sort = null;
        }
        this.rows = rows;
        this.year = year;
        this.selected = selected;
        this.draw({ announce: false });
    }

    draw({ announce = false } = {}) {
        const { doc } = this;
        // Keyboard focus in the rows survives a redraw, on the same row if it is still there, so
        // scrubbing the year with the table focused does not drop it.
        const hadFocus = this.body.contains(doc.activeElement);
        const focused = hadFocus ? doc.activeElement.closest('tr')?.dataset.id : null;
        this.shown = sortAtlasRows(this.rows, this.sort);
        for (const column of this.columns) {
            this.headers.get(column.id).setAttribute('aria-sort', this.sort && this.sort.column === column.id ? this.sort.direction : 'none');
            const button = this.sorters.get(column.id);
            button.textContent = columnLabel(column, this.year);
            // The collector's column says what it counts to a screen reader, after its label.
            if (column.description) button.append(el(this.doc, 'span', 'strata-sr-only', ` (${column.description})`));
        }
        const status = atlasRowStatus({ shown: this.shown.length, year: this.year, sort: this.sort });
        this.caption.textContent = `Genres and styles: ${status}`;
        this.stop = this.shown.some((row) => row.id === focused) ? focused : this.shown.some((row) => row.id === this.selected) ? this.selected : this.shown[0]?.id ?? null;
        const fragment = doc.createDocumentFragment();
        for (const row of this.shown) fragment.append(this.rowElement(row));
        this.body.replaceChildren(fragment);
        if (hadFocus) this.rowFor(this.stop)?.focus();
        if (announce) this.onStatus(status);
    }

    rowElement(row) {
        const { doc } = this;
        const tr = el(doc, 'tr', `strata-row atlas-row atlas-row--${row.kind}`);
        tr.dataset.id = row.id;
        tr.tabIndex = row.id === this.stop ? 0 : -1;
        if (row.id === this.selected) tr.setAttribute('aria-current', 'true');
        tr.append(el(doc, 'td', 'atlas-cell-kind', row.kindLabel));
        const name = el(doc, 'th', 'atlas-cell-name', row.name);
        name.scope = 'row';
        tr.append(name);
        if (this.yours) tr.append(this.yoursCell(row));
        tr.append(this.stageCell(row.stageText, row.stageRank === null ? null : row.stage));
        const provisional = el(doc, 'td', 'atlas-cell-provisional');
        if (row.provisional) provisional.append(el(doc, 'span', 'atlas-provisional-badge', row.provisionalText));
        else provisional.textContent = row.provisionalText;
        tr.append(provisional);
        tr.append(this.stageCell(row.latestText, row.latestRank === null ? null : row.latest));
        tr.append(this.stageCell(row.settledText, row.settledRank === null ? null : row.settled));
        tr.append(el(doc, 'td', 'atlas-cell-year', row.emergedText));
        tr.append(el(doc, 'td', 'atlas-cell-dominant', row.dominant));
        tr.append(el(doc, 'td', 'atlas-cell-parents', row.parentsText));
        tr.append(el(doc, 'td', 'atlas-cell-edges', row.edgesText));
        return tr;
    }

    // What the collector holds: the state as a chip beside the counts in words, so it never rests on
    // color alone. A row they do not hold says so in words.
    yoursCell(row) {
        const cell = el(this.doc, 'td', 'atlas-cell-yours');
        if (row.held) {
            cell.append(el(this.doc, 'span', `strata-chip strata-chip--${row.held.state}`, stateLabel(row.held.state)));
            cell.append(this.doc.createTextNode(` ${plural(row.held.items, 'item')} (${row.held.owned} owned, ${row.held.wanted} wanted)`));
        } else {
            cell.textContent = row.yoursText;
        }
        return cell;
    }

    // A stage is a word beside its swatch, so it never rests on color alone. A cell with no stage
    // (a genre, or a style before the timeline) is words only.
    stageCell(text, stage) {
        const cell = el(this.doc, 'td', 'atlas-cell-stage');
        if (stage) cell.append(el(this.doc, 'span', `atlas-chip atlas-stage--${stage}`, text));
        else cell.textContent = text;
        return cell;
    }

    rowFor(id) {
        for (const tr of this.body.children) if (tr.dataset.id === id) return tr;
        return null;
    }

    /** Mark a row as the selected one without rebuilding the table. An id with no row clears the mark. */
    select(id, { focus = false } = {}) {
        this.selected = id;
        for (const tr of this.body.children) {
            if (tr.dataset.id === id) tr.setAttribute('aria-current', 'true');
            else tr.removeAttribute('aria-current');
        }
        if (id !== null && this.rowFor(id)) this.moveTo(id, { focus });
    }

    // The one row in the tab order is the roving stop.
    moveTo(id, { focus = true } = {}) {
        const target = this.rowFor(id);
        if (!target) return false;
        for (const tr of this.body.children) tr.tabIndex = tr === target ? 0 : -1;
        this.stop = id;
        if (focus) target.focus();
        target.scrollIntoView?.({ block: 'nearest' });
        return true;
    }

    handleClick(event) {
        const tr = event.target.closest?.('tr');
        if (!tr || !this.body.contains(tr)) return;
        this.moveTo(tr.dataset.id, { focus: false });
        this.onSelect(tr.dataset.id);
    }

    handleKey(event) {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const tr = event.target;
        if (!tr || tr.tagName !== 'TR' || tr.parentNode !== this.body) return;
        const at = this.shown.findIndex((row) => row.id === tr.dataset.id);
        if (at < 0) return;
        const row = this.shown[at];
        let target = null;
        switch (event.key) {
            case 'ArrowDown': target = this.shown[Math.min(at + 1, this.shown.length - 1)]; break;
            case 'ArrowUp': target = this.shown[Math.max(at - 1, 0)]; break;
            case 'Home': target = this.shown[0]; break;
            case 'End': target = this.shown[this.shown.length - 1]; break;
            case 'PageUp': target = this.shown.find((item) => item.id === row.parentId) ?? row; break;
            case 'PageDown': target = this.shown.find((item) => item.parentId === row.id) ?? row; break;
            case ' ':
            case 'Spacebar':
            case 'Enter':
                event.preventDefault();
                this.onSelect(row.id);
                return;
            case 'Escape':
                if (this.selected === null) return;
                event.preventDefault();
                this.onSelect(null);
                return;
            default: return;
        }
        event.preventDefault();
        if (target) this.moveTo(target.id);
    }
}
