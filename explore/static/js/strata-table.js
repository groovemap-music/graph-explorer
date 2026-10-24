/**
 * The strata table: Discography Strata as rows. It is a peer of the 3D view, not a fallback
 * (ADR 0016 section 1, gm-design-on0x section "Accessibility" and Recommendation 6).
 *
 * The table is the only view that answers "which items cannot change state, and why" at every
 * scale, because it lists every credit, lane, master, and pressing the route sent, folded into a
 * count node or not, with its path, year, state, and blocked reason. It reads the same two inputs
 * the 3D view draws from, the clock-applied graph and its layout, so the planes, lanes,
 * aggregates, and server page are the 3D view's; the layout says only whether an entry has a node
 * of its own or sits inside a count node.
 *
 * Two halves:
 *   - pure functions (`buildTableRows`, `sortRows`, `filterRows`, `rowStatus`) that Vitest covers
 *     against the layout module's conservation, and that need no DOM;
 *   - `StrataTable`, the DOM: a native table with a caption, column headers that sort, a roving
 *     tabindex over its rows, and arrow, Home, End, PageUp, PageDown, Enter, Space, and Escape keys.
 *
 * The DOM is built with createElement and textContent only, and styled through classes in
 * strata.css, so the `style-src 'self'` policy the renderer holds still holds here.
 */

import { COLLECTOR_STATES, stateLabel } from './strata-collector.js';
import { blockedReason, displayLabel } from './strata-scene.js';

export const KIND_LABELS = Object.freeze({
    credit: 'Credit',
    creditGroup: 'Credit group',
    master: 'Master',
    masterGroup: 'Master group',
    lane: 'No-master lane',
    pressing: 'Pressing',
    pressingGroup: 'Pressing group',
});

/** The columns, in order. `sort` is false for the column that holds the row's action. */
export const TABLE_COLUMNS = Object.freeze([
    Object.freeze({ id: 'kind', label: 'Kind', sort: true }),
    Object.freeze({ id: 'name', label: 'Name', sort: true }),
    Object.freeze({ id: 'path', label: 'Under', sort: true }),
    Object.freeze({ id: 'year', label: 'Year', sort: true }),
    Object.freeze({ id: 'state', label: 'State', sort: true }),
    Object.freeze({ id: 'blocked', label: 'Cannot change because', sort: true }),
    Object.freeze({ id: 'releases', label: 'Releases', sort: true }),
    Object.freeze({ id: 'drawn', label: 'In the 3D view', sort: true }),
    Object.freeze({ id: 'open', label: 'Open', sort: false }),
]);

export const TABLE_HELP = 'Up and Down move between rows, Home and End go to the first and last. PageUp moves to the row\'s parent and PageDown to its first child. Space selects a row and describes it in the panel. Enter opens a group or a master as the 3D view does, and selects any other row. Escape clears the selection. Column headers are buttons that sort.';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The cursor an entry opens, if any: an aggregate, or a master (whose cursor pages its pressings). */
export function entryCursor(entry) {
    return entry.agg || (entry.level === 1 && !entry.lane) ? entry.id : null;
}

function kindOf(entry) {
    if (entry.lane) return 'lane';
    if (entry.level === 0) return entry.agg ? 'creditGroup' : 'credit';
    if (entry.level === 1) return entry.agg ? 'masterGroup' : 'master';
    return entry.agg ? 'pressingGroup' : 'pressing';
}

function yearText(entry) {
    if (!entry.agg && entry.level > 0) {
        if (entry.year === null) return 'no year';
        return entry.level === 2 && entry.yearSource === 'master' ? `${entry.year} (its master's)` : String(entry.year);
    }
    if (entry.y0 === null || entry.y0 === undefined) return 'no year';
    return entry.y0 === entry.y1 ? String(entry.y0) : `${entry.y0}–${entry.y1}`;
}

function plural(count, one, many = `${one}s`) {
    return `${count} ${count === 1 ? one : many}`;
}

function statesText(states) {
    if (!states) return null;
    const parts = COLLECTOR_STATES.filter((state) => states[state] > 0).map((state) => `${states[state]} ${stateLabel(state)}`);
    return parts.length ? parts.join(' · ') : null;
}

/**
 * The state a row shows, as words, plus the state its chip is colored by (or null). A pressing has
 * its own state; a group, master, or credit counts the states it holds. A MusicBrainz-only pressing
 * has no collector state at all, which is not the same as `none`.
 */
export function rowState(entry, { signedIn }) {
    const own = entry.state && COLLECTOR_STATES.includes(entry.state) ? entry.state : null;
    if (entry.level === 2 && !entry.agg && entry.provider === 'musicbrainz') return { text: 'no state', key: null };
    if (!signedIn) return { text: 'not signed in', key: null };
    if (own) return { text: stateLabel(own), key: own };
    const counts = statesText(entry.states);
    return counts ? { text: counts, key: null } : { text: 'not known', key: null };
}

/**
 * Why a row cannot change state, or null. A MusicBrainz-only pressing says why in full. A credit,
 * master, or group says how many MusicBrainz-only pressings it holds, so the reader knows to open
 * it.
 */
export function rowBlocked(entry) {
    const own = blockedReason(entry);
    if (own) return { text: own, count: 1 };
    if (entry.level === 2 && !entry.agg) return null;
    const count = entry.musicbrainzReleases || 0;
    if (!count) return null;
    const [verb, pronoun] = count === 1 ? ['exists', 'it'] : ['exist', 'them'];
    return { text: `${plural(count, 'pressing')} here ${verb} only in MusicBrainz, so GrooveMap has no collector state for ${pronoun}.${entryCursor(entry) ? ' Open this row to list them.' : ''}`, count };
}

function startOf(entry) {
    if (entry.agg || entry.level === 0) return entry.y0 ?? null;
    return entry.year ?? null;
}

// Children first by year (undated last), then by id, so the default order reads as an outline.
function byOutline(a, b) {
    const ya = startOf(a);
    const yb = startOf(b);
    if (ya !== yb) return ya === null ? 1 : yb === null ? -1 : ya - yb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One row for every entry of a clock-applied graph, in outline order: the root credit, then its
 * masters and lanes, then their pressings, and the other credits after.
 *
 * @param {{entries: object[], rootCredit: string|null}} view - `applyClocks` output (or an adapted
 *   graph), the entries the 3D view draws from
 * @param {{nodes: object[]}} layout - `layoutStrata` output for the same view, which says whether
 *   each entry has a node of its own or sits inside a count node
 * @param {object} [options]
 * @param {boolean} [options.signedIn]
 * @param {(node: object) => ({id: string, label: string, cursor: string}|null)} [options.openAction]
 *   the action that opens a row's cursor, as the panel words it
 * @returns {Array<object>} rows; `node` is the entry in the shape the panel and `nodeActions` read
 */
export function buildTableRows(view, layout, { signedIn = false, openAction = () => null } = {}) {
    const holder = new Map();
    for (const node of layout.nodes) for (const id of node.members) holder.set(id, node);
    const entries = view.entries;
    const children = new Map();
    const roots = [];
    for (const entry of entries) {
        if (entry.level === 0) roots.push(entry);
        else {
            if (!children.has(entry.parent)) children.set(entry.parent, []);
            children.get(entry.parent).push(entry);
        }
    }
    roots.sort((a, b) => (a.id === view.rootCredit ? -1 : b.id === view.rootCredit ? 1 : 0) || byOutline(a, b));
    for (const list of children.values()) list.sort(byOutline);

    const labelOf = (entry) => displayLabel(entry);
    const rows = [];
    const visit = (entry, trail) => {
        const held = holder.get(entry.id) || null;
        const drawn = held !== null && held.id === entry.id;
        const node = { ...entry, cursor: entryCursor(entry), origin: drawn ? 'payload' : 'fold' };
        const state = rowState(entry, { signedIn });
        const blocked = rowBlocked(entry);
        const open = node.cursor || node.origin === 'fold' ? openAction(node) : null;
        rows.push({
            id: entry.id,
            order: rows.length,
            level: entry.level,
            agg: entry.agg,
            kind: kindOf(entry),
            kindLabel: KIND_LABELS[kindOf(entry)],
            name: labelOf(entry),
            parentId: entry.parent,
            path: trail.map(labelOf).join(' › '),
            year: startOf(entry),
            yearEnd: entry.agg || entry.level === 0 ? entry.y1 ?? null : entry.year ?? null,
            yearText: yearText(entry),
            state: state.text,
            stateKey: state.key,
            blocked: blocked ? blocked.text : null,
            blockedCount: blocked ? blocked.count : 0,
            releases: entry.level === 2 && !entry.agg ? 1 : entry.releases,
            drawn,
            drawnText: drawn ? 'drawn' : `in ${held ? `“${labelOf(held)}”` : 'a count node'}`,
            heldBy: held ? held.id : null,
            open,
            node,
        });
        for (const child of children.get(entry.id) || []) visit(child, [...trail, entry]);
    };
    for (const root of roots) visit(root, []);
    return rows;
}

const COMPARE = {
    kind: (a, b) => a.level - b.level || a.kind.localeCompare(b.kind),
    name: (a, b) => collator.compare(a.name, b.name),
    path: (a, b) => collator.compare(a.path, b.path),
    year: (a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.yearEnd ?? 0) - (b.yearEnd ?? 0),
    state: (a, b) => collator.compare(a.state, b.state),
    blocked: (a, b) => b.blockedCount - a.blockedCount || collator.compare(a.blocked || '', b.blocked || ''),
    releases: (a, b) => a.releases - b.releases,
    drawn: (a, b) => Number(b.drawn) - Number(a.drawn),
};

// A row with nothing in the column goes last, whichever way the column sorts.
const EMPTY = {
    year: (row) => row.year === null,
    blocked: (row) => row.blocked === null,
};

/**
 * Rows in a column's order. `sort` is `{column, direction: 'ascending' | 'descending'}`, or null for
 * the outline order. The sort is stable: ties keep the outline order.
 */
export function sortRows(rows, sort) {
    if (!sort || !COMPARE[sort.column]) return rows.slice();
    const sign = sort.direction === 'descending' ? -1 : 1;
    const empty = EMPTY[sort.column];
    return rows.slice().sort((a, b) => {
        if (empty) {
            const ea = empty(a);
            const eb = empty(b);
            if (ea !== eb) return ea ? 1 : -1;
        }
        return sign * COMPARE[sort.column](a, b) || a.order - b.order;
    });
}

/** The rows the table shows under its filter: all of them, or only those that cannot change state. */
export function filterRows(rows, { blockedOnly = false } = {}) {
    return blockedOnly ? rows.filter((row) => row.blocked !== null) : rows;
}

/** The sentence a screen reader hears after the rows change. */
export function rowStatus({ shown, total, sort = null, blockedOnly = false }) {
    const count = blockedOnly ? `${shown} of ${plural(total, 'row')} that cannot change state` : plural(shown, 'row');
    const column = sort ? TABLE_COLUMNS.find((item) => item.id === sort.column) : null;
    return `${count}, ${column ? `sorted by ${column.label.toLowerCase()}, ${sort.direction}` : 'in outline order'}.`;
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
 * Callbacks: `onSelect(id | null)` when a row is chosen or cleared, `onOpen(cursor)` when a row's
 * group or master is opened, `onStatus(text)` for the live sentence after sorting or filtering.
 */
export class StrataTable {
    constructor({ doc = globalThis.document, host, onSelect = () => {}, onOpen = () => {}, onStatus = () => {} } = {}) {
        this.doc = doc;
        this.host = host;
        this.onSelect = onSelect;
        this.onOpen = onOpen;
        this.onStatus = onStatus;
        this.sort = null;
        this.blockedOnly = false;
        this.rows = [];
        this.shown = [];
        this.selected = null;
        this.stop = null;
        this.build();
    }

    build() {
        const { doc } = this;
        this.table = el(doc, 'table', 'strata-table');
        this.caption = el(doc, 'caption', 'strata-table-caption');
        this.head = el(doc, 'thead');
        this.body = el(doc, 'tbody');
        const headRow = el(doc, 'tr');
        this.headers = new Map();
        for (const column of TABLE_COLUMNS) {
            const th = el(doc, 'th');
            th.scope = 'col';
            th.dataset.column = column.id;
            if (column.sort) {
                const button = el(doc, 'button', 'strata-table-sort', column.label);
                button.type = 'button';
                button.addEventListener('click', () => this.sortBy(column.id));
                th.append(button);
                th.setAttribute('aria-sort', 'none');
            } else {
                th.textContent = column.label;
            }
            this.headers.set(column.id, th);
            headRow.append(th);
        }
        this.head.append(headRow);
        this.table.append(this.caption, this.head, this.body);
        this.table.setAttribute('aria-describedby', 'strataTableHelp');
        this.body.addEventListener('keydown', (event) => this.handleKey(event));
        this.body.addEventListener('click', (event) => this.handleClick(event));
        this.host.replaceChildren(this.table);
    }

    /** Sort by a column: ascending, then descending, then the outline order again. */
    sortBy(column) {
        if (!this.sort || this.sort.column !== column) this.sort = { column, direction: 'ascending' };
        else if (this.sort.direction === 'ascending') this.sort = { column, direction: 'descending' };
        else this.sort = null;
        this.draw({ announce: true });
        return this.sort;
    }

    setFilter({ blockedOnly = false } = {}) {
        this.blockedOnly = !!blockedOnly;
        this.draw({ announce: true });
    }

    /** Replace the rows (a new page, a clock, a filter on the view) and keep the user's place. */
    setRows(rows, { selected = this.selected } = {}) {
        this.rows = rows;
        this.selected = selected;
        this.draw({ announce: false });
    }

    draw({ announce = false } = {}) {
        const { doc } = this;
        // Keyboard focus in the rows survives a redraw: on the same row if it is still there, and
        // otherwise on the table's tab stop, so a key press that opened a group does not drop focus.
        const hadFocus = this.body.contains(doc.activeElement);
        const focused = hadFocus ? doc.activeElement.closest('tr')?.dataset.id : null;
        this.shown = sortRows(filterRows(this.rows, { blockedOnly: this.blockedOnly }), this.sort);
        for (const column of TABLE_COLUMNS) {
            if (column.sort) this.headers.get(column.id).setAttribute('aria-sort', this.sort && this.sort.column === column.id ? this.sort.direction : 'none');
        }
        const status = rowStatus({ shown: this.shown.length, total: this.rows.length, sort: this.sort, blockedOnly: this.blockedOnly });
        this.caption.textContent = `Credits, masters, and pressings: ${status}`;
        const stop = this.shown.some((row) => row.id === focused) ? focused : this.shown.some((row) => row.id === this.selected) ? this.selected : this.shown[0]?.id ?? null;
        this.stop = stop;
        const fragment = doc.createDocumentFragment();
        for (const row of this.shown) fragment.append(this.rowElement(row));
        this.body.replaceChildren(fragment);
        if (hadFocus) this.rowFor(this.shown.some((row) => row.id === focused) ? focused : this.stop)?.focus();
        if (announce) this.onStatus(status);
    }

    rowElement(row) {
        const { doc } = this;
        const tr = el(doc, 'tr', `strata-row strata-row--${row.kind}${row.blocked ? ' strata-row--blocked' : ''}`);
        tr.dataset.id = row.id;
        tr.tabIndex = row.id === this.stop ? 0 : -1;
        if (row.id === this.selected) tr.setAttribute('aria-current', 'true');
        tr.append(el(doc, 'td', 'strata-cell-kind', row.kindLabel));
        const name = el(doc, 'th', 'strata-cell-name', row.name);
        name.scope = 'row';
        tr.append(name);
        tr.append(el(doc, 'td', 'strata-cell-path', row.path));
        tr.append(el(doc, 'td', 'strata-cell-year', row.yearText));
        const state = el(doc, 'td', 'strata-cell-state');
        if (row.stateKey) state.append(el(doc, 'span', `strata-state strata-state--${row.stateKey}`, row.state));
        else if (row.state === 'no state') state.append(el(doc, 'span', 'strata-chip strata-chip--blocked', row.state));
        else state.textContent = row.state;
        tr.append(state);
        tr.append(el(doc, 'td', 'strata-cell-blocked', row.blocked || ''));
        tr.append(el(doc, 'td', 'strata-cell-releases', String(row.releases)));
        tr.append(el(doc, 'td', 'strata-cell-drawn', row.drawnText));
        const action = el(doc, 'td', 'strata-cell-open');
        if (row.open) {
            const button = el(doc, 'button', 'strata-table-open', row.open.label);
            button.type = 'button';
            // Rows are the tab stops. Enter on a row opens it, and this button is for pointers
            // and for a screen reader's browse mode.
            button.tabIndex = -1;
            button.setAttribute('aria-label', `${row.open.label}: ${row.name}`);
            button.dataset.cursor = row.open.cursor;
            action.append(button);
        }
        tr.append(action);
        return tr;
    }

    rowFor(id) {
        for (const tr of this.body.children) if (tr.dataset.id === id) return tr;
        return null;
    }

    /** Mark a row as the selected one without rebuilding the table. */
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
        if (focus) {
            target.focus();
            target.scrollIntoView?.({ block: 'nearest' });
        }
        return true;
    }

    handleClick(event) {
        const button = event.target.closest?.('.strata-table-open');
        const tr = event.target.closest?.('tr');
        if (!tr || !this.body.contains(tr)) return;
        const id = tr.dataset.id;
        if (button) {
            this.moveTo(id, { focus: false });
            this.onOpen(button.dataset.cursor);
            return;
        }
        this.moveTo(id, { focus: false });
        this.onSelect(id);
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
                event.preventDefault();
                this.onSelect(row.id);
                return;
            case 'Enter':
                event.preventDefault();
                if (row.open) this.onOpen(row.open.cursor);
                else this.onSelect(row.id);
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
