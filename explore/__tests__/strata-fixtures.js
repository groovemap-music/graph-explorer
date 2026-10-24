/**
 * Generated discographies and server-shaped strata payloads for the strata layout properties.
 *
 * `rng` is gm-design-on0x's seeded mulberry32 (docs/spikes/gm-design-on0x/lib/rng.mjs).
 * `buildStrata` is a port of catalog-api's `api/strata.py` `build_strata` at the promoted producer
 * commit (contracts/catalog-api/graph-explorer/v1/source.json): the fold `GET /api/explore/strata`
 * applies after its graph read, focus cursors and server-side pages included. Running the layout
 * over its output tests the layout against payloads shaped the way the route shapes them. The port
 * was checked against the Python on generated catalogs (every budget, cursor, and page) before it
 * was committed; `explore/__tests__/strata-route-recorded.test.js` replays payloads the Python
 * wrote. Names are placeholders; nothing here comes from a real catalog.
 */

export function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    next.pick = (list) => list[Math.floor(next() * list.length)];
    next.chance = (p) => next() < p;
    return next;
}

const ROOT_ARTIST = '1';

/**
 * A synthetic catalog for one root artist, in the shape the route's catalog read returns: releases
 * with a credit (the sorted set of artists it is BY, always holding the root), a master or none, a
 * year or none, and a provider; the masters' own years; and, for a signed-in caller, collector
 * marks with their recorded `date_added`. Shapes swing widely between seeds: masterless shares
 * from 0 to 1, undated shares from 0 to 1, a few releases to `maxReleases`, one to fourteen
 * credits, and MusicBrainz-only releases joined to masters.
 *
 * @returns {{rootId: string, releases: object[], masterYears: Map<string, number|null>,
 *            marks: Map<string, object>}}
 */
export function generateDiscography(r, { maxReleases = 600 } = {}) {
    const releaseCount = Math.max(1, Math.round(Math.exp(r() * Math.log(maxReleases))));
    const creditCount = r.pick([1, 2, 3, 5, 8, 14]);
    const credits = [ROOT_ARTIST];
    for (let guard = 0; credits.length < creditCount && guard < 100; guard++) {
        const others = Array.from({ length: r.int(1, 3) }, () => r.int(2, 16));
        const key = [...new Set([1, ...others])].sort((a, b) => a - b).join('+');
        if (!credits.includes(key)) credits.push(key);
    }
    // Credit weights fall off as a Zipf curve, as in gm-design-on0x's fixtures.
    const weights = credits.map((_, i) => 1 / Math.pow(i + 1, 1.1));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const pickCredit = () => {
        let x = r() * total;
        for (let i = 0; i < credits.length; i++) if ((x -= weights[i]) < 0) return credits[i];
        return credits[0];
    };
    const masterless = r.pick([0, 0.1, 0.4, 0.8, 1]);
    const undated = r.pick([0, 0.05, 0.3, 1]);
    const masterUndated = r.pick([0, 0.07, 0.5, 1]);
    const stateful = r.pick([0, 0.05, 0.3]);
    const musicbrainz = r.pick([0, 0, 0.05, 0.2]);
    const reuse = r.pick([0.2, 0.5, 0.8, 0.95]);
    const start = r.int(1950, 2010);
    const masterYears = new Map();
    const releases = [];
    const marks = new Map();
    const date = () => `20${String(r.int(5, 26)).padStart(2, '0')}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}T00:00:00Z`;
    for (let n = 1; n <= releaseCount; n++) {
        const year = r.chance(undated) ? null : Math.min(2026, start + Math.floor(Math.pow(r(), 1.4) * (2027 - start)));
        let masterId = null;
        if (!r.chance(masterless)) {
            const ids = [...masterYears.keys()];
            if (ids.length && r.chance(reuse)) masterId = ids[Math.floor(Math.pow(r(), 2) * ids.length)];
            else {
                masterId = String(500 + masterYears.size + 1);
                masterYears.set(masterId, r.chance(masterUndated) ? null : (year ?? start));
            }
        }
        if (masterId !== null && r.chance(musicbrainz)) {
            releases.push({ id: `mb-${n}`, masterId, year, credit: null, provider: 'musicbrainz', title: `MusicBrainz release ${n}` });
            continue;
        }
        const id = String(n);
        releases.push({ id, masterId, year, credit: pickCredit(), provider: 'discogs', title: null });
        if (r.chance(stateful)) {
            const kind = r.pick(['wanted', 'owned', 'both']);
            const owned = kind !== 'wanted';
            const wanted = kind !== 'owned';
            marks.set(id, { owned, wanted, ownedAt: owned && r.chance(0.9) ? date() : null, wantedAt: wanted && r.chance(0.9) ? date() : null });
        }
    }
    // A master no Discogs release reaches is never on the ladder; the route reads none.
    return { rootId: ROOT_ARTIST, releases, masterYears, marks };
}

// ---------------------------------------------------------------------------------------------
// The route's fold, ported from catalog-api api/strata.py.
// ---------------------------------------------------------------------------------------------

export const ROUTE_PAGE_SIZE = 8;
const OTHER_CREDITS = 'c:other';
const UNDATED = 'undated';
const ALL = 'all';
export const DEFAULT_BUDGET = Object.freeze([3, 12, 16]);

/** A budget the route accepts: at least 3 credits, twice as many masters, more releases than credits. */
export function validBudget([credits, masters, releases]) {
    return credits >= 3 && credits <= 48 && masters >= 2 * credits && masters <= 500 && releases >= credits + 1 && releases <= 500;
}

const creditId = (credit) => `c:${credit}`;
const idKey = (value) => (/^\d+$/.test(value) ? [0, Number(value), ''] : [1, 0, value]);
export const decade = (year) => (year === null ? UNDATED : `${Math.floor(year / 10) * 10}s`);

// Python's tuple ordering: element by element, booleans as 0 and 1, nested tuples recursively.
function compareKeys(a, b) {
    if (Array.isArray(a)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const c = compareKeys(a[i], b[i]);
            if (c) return c;
        }
        return a.length - b.length;
    }
    const x = typeof a === 'boolean' ? Number(a) : a;
    const y = typeof b === 'boolean' ? Number(b) : b;
    return x < y ? -1 : x > y ? 1 : 0;
}
const sortedBy = (list, key) => list.slice().sort((a, b) => compareKeys(key(a), key(b)));
const minBy = (list, key) => list.reduce((best, item) => (compareKeys(key(item), key(best)) < 0 ? item : best));
const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
};

function span(items) {
    const years = items.map((item) => item.year).filter((year) => year !== null);
    return years.length ? [Math.min(...years), Math.max(...years)] : [null, null];
}

function rollup(items) {
    const states = new Set(items.map((item) => item.state));
    if (states.has('owned') || states.has('wanted_owned')) return 'owned';
    return states.has('wanted') ? 'wanted' : 'none';
}

function markState(mark) {
    if (mark.owned && mark.wanted) return 'wanted_owned';
    if (mark.owned) return 'owned';
    return mark.wanted ? 'wanted' : 'none';
}

function pageSize(members, withoutRest, withRest) {
    if (members <= Math.min(ROUTE_PAGE_SIZE, withoutRest)) return members;
    return Math.max(1, Math.min(ROUTE_PAGE_SIZE, withRest));
}

const nodeId = (item) => (item.release.provider === 'discogs' ? `r:${item.release.id}` : `mb:${item.release.id}`);
const stateful = (item) => item.state !== null && item.state !== 'none';
const BLANK_MARK = Object.freeze({ owned: false, wanted: false, ownedAt: null, wantedAt: null });

export class FocusNotFound extends Error {}

class Ladder {
    constructor(catalog, marks) {
        this.catalog = catalog;
        this.root = catalog.rootId;
        this.signedIn = marks != null;
        const byMaster = new Map();
        for (const release of catalog.releases) if (release.provider === 'discogs' && release.masterId !== null) push(byMaster, release.masterId, release);
        this.anchor = new Map();
        this.masterCredit = new Map();
        for (const [masterId, releases] of byMaster) {
            const original = minBy(releases, (r) => [r.year === null, r.year ?? 0, idKey(r.id)]);
            this.anchor.set(masterId, original.id);
            this.masterCredit.set(masterId, original.credit);
        }
        const items = [];
        for (const release of catalog.releases) {
            const ownMasterYear = release.masterId !== null ? (catalog.masterYears.get(release.masterId) ?? null) : null;
            let year = null;
            let yearSource = null;
            if (release.year !== null) [year, yearSource] = [release.year, 'release'];
            else if (ownMasterYear !== null) [year, yearSource] = [ownMasterYear, 'master'];
            let credit;
            let mark = null;
            let state = null;
            if (release.provider === 'discogs') {
                credit = release.credit;
                mark = marks != null ? (marks.get(release.id) ?? BLANK_MARK) : null;
                state = mark ? markState(mark) : null;
            } else if (this.masterCredit.has(release.masterId)) {
                credit = this.masterCredit.get(release.masterId);
            } else {
                continue;
            }
            items.push({ release, year, yearSource, credit, state, mark });
        }
        this.itemsByMaster = new Map();
        this.masterless = new Map();
        for (const item of items) {
            if (item.release.masterId !== null) push(this.itemsByMaster, item.release.masterId, item);
            else push(this.masterless, item.credit, item);
        }
        const sortKey = (item) => [item.year !== null, item.year ?? 0, item.release.provider !== 'discogs', idKey(item.release.id)];
        for (const map of [this.itemsByMaster, this.masterless]) for (const [key, group] of map) map.set(key, sortedBy(group, sortKey));
        this.items = items;
        this.masterYear = new Map();
        for (const [masterId, group] of this.itemsByMaster) {
            const own = catalog.masterYears.get(masterId) ?? null;
            this.masterYear.set(masterId, own !== null ? own : span(group)[0]);
        }
        this.mastersByCredit = new Map();
        for (const masterId of this.itemsByMaster.keys()) push(this.mastersByCredit, this.masterCredit.get(masterId), masterId);
        for (const [credit, masters] of this.mastersByCredit) {
            this.mastersByCredit.set(credit, sortedBy(masters, (m) => [this.masterYear.get(m) !== null, this.masterYear.get(m) ?? 0, idKey(m)]));
        }
        this.statefulMasters = new Set([...this.itemsByMaster].filter(([, group]) => group.some(stateful)).map(([masterId]) => masterId));
        const placed = new Map();
        const add = (credit, n) => placed.set(credit, (placed.get(credit) || 0) + n);
        for (const [credit, masters] of this.mastersByCredit) add(credit, masters.reduce((sum, m) => sum + this.itemsByMaster.get(m).length, 0));
        for (const [credit, group] of this.masterless) add(credit, group.length);
        const others = sortedBy([...placed.keys()].filter((c) => c !== this.root), (c) => [-placed.get(c), creditId(c)]);
        this.creditOrder = [this.root, ...others];
    }

    creditItems(credit) {
        const held = (this.mastersByCredit.get(credit) || []).flatMap((m) => this.itemsByMaster.get(m));
        return [...held, ...(this.masterless.get(credit) || [])];
    }

    masterPriority(masterId) {
        return [!this.statefulMasters.has(masterId), -this.itemsByMaster.get(masterId).length, idKey(masterId)];
    }

    bucket(masterId, mode) {
        return [this.masterCredit.get(masterId), mode === 'decade' ? decade(this.masterYear.get(masterId)) : ALL];
    }

    resolveFocus(focusId, page, budget) {
        // A pressing is a cursor too: it opens the member set that holds it, on the page that holds it.
        const pressing = this.pressing(focusId);
        const parsed = this.parseFocus(pressing === null ? focusId : this.pressingCursor(pressing));
        if (!parsed) throw new FocusNotFound(`focus '${focusId}' names nothing under this artist`);
        const { id, level, members, credit, master, lane, label } = parsed;
        const [credits, masters, releases] = budget;
        let size;
        if (level === 0) {
            size = pageSize(members.length, credits - 1, credits - 2);
        } else if (level === 1) {
            const labelMembers = new Set(members);
            let othersM = Number(!!(this.masterless.get(credit) || []).length);
            othersM += Number((this.mastersByCredit.get(credit) || []).some((m) => !labelMembers.has(m)));
            if (credit !== this.root) othersM += Number(!!(this.masterless.get(this.root) || []).length) + Number(!!(this.mastersByCredit.get(this.root) || []).length);
            const lanes = [...new Set([this.root, credit])].filter((c) => (this.masterless.get(c) || []).length).length;
            const room = Math.min(masters - othersM, releases - lanes);
            size = pageSize(members.length, room, Math.min(masters - othersM - 1, releases - lanes));
        } else {
            let lanes = 0;
            for (const c of new Set([this.root, credit])) {
                const laneItems = this.masterless.get(c) || [];
                lanes += c === lane ? Number(laneItems.length > members.length) : Number(!!laneItems.length);
            }
            const room = releases - lanes;
            size = pageSize(members.length, room, room - 1);
        }
        const pages = Math.ceil(members.length / size);
        const index = pressing === null ? ((page % pages) + pages) % pages : Math.floor(members.indexOf(pressing) / size);
        const start = index * size;
        return {
            id,
            level,
            members,
            credit,
            master,
            lane,
            decade: label,
            page: index,
            pageSize: size,
            pages,
            pageMembers: members.slice(start, start + size),
            rest: [...members.slice(0, start), ...members.slice(start + size)],
        };
    }

    /** The release a `r:<id>` or `mb:<mbid>` cursor names, if this root holds it. */
    pressing(focusId) {
        if (!focusId.startsWith('r:') && !focusId.startsWith('mb:')) return null;
        const wanted = focusId.startsWith('mb:') ? focusId.toLowerCase() : focusId;
        return this.items.find((item) => nodeId(item) === wanted) ?? null;
    }

    /** The aggregate cursor whose members hold a pressing: its master, else its credit's lane. */
    pressingCursor(item) {
        return item.release.masterId !== null ? `ra:m:${item.release.masterId}` : `ra:nm:${creditId(item.credit)}`;
    }

    parseFocus(focusId) {
        if (focusId === OTHER_CREDITS) {
            const others = this.creditOrder.slice(1);
            return others.length ? { id: OTHER_CREDITS, level: 0, members: others, credit: null, master: null, lane: null, label: null } : null;
        }
        for (const prefix of ['ra:m:', 'm:']) {
            if (!focusId.startsWith(prefix)) continue;
            const masterId = focusId.slice(prefix.length);
            if (!this.itemsByMaster.has(masterId)) return null;
            return { id: `ra:m:${masterId}`, level: 2, members: this.itemsByMaster.get(masterId).slice(), credit: this.masterCredit.get(masterId), master: masterId, lane: null, label: null };
        }
        for (const prefix of ['ra:nm:', 'nm:']) {
            if (!focusId.startsWith(prefix)) continue;
            const [credit, label] = parseCredit(focusId.slice(prefix.length));
            let laneItems = credit ? this.masterless.get(credit) || [] : [];
            if (label !== null) laneItems = laneItems.filter((item) => decade(item.year) === label);
            if (!laneItems.length || credit === null) return null;
            const id = `ra:nm:${creditId(credit)}${label ? `:${label}` : ''}`;
            return { id, level: 2, members: laneItems, credit, master: null, lane: credit, label };
        }
        if (focusId.startsWith('ma:')) {
            const [credit, label] = parseCredit(focusId.slice(3));
            if (credit === null || label === null) return null;
            const masters = (this.mastersByCredit.get(credit) || []).filter((m) => label === ALL || this.bucket(m, 'decade')[1] === label);
            if (!masters.length) return null;
            return { id: `ma:${creditId(credit)}:${label}`, level: 1, members: masters, credit, master: null, lane: null, label };
        }
        return null;
    }

    creditLevels(budget, focus) {
        if (focus && focus.level === 0) return [[[this.root, ...focus.pageMembers], focus.rest.slice()]];
        const base = [this.root];
        if (focus && focus.credit !== null && focus.credit !== this.root) base.push(focus.credit);
        const rest = this.creditOrder.filter((c) => !base.includes(c));
        const most = base.length + rest.length <= budget[0] ? rest.length : budget[0] - base.length - 1;
        const levels = [];
        for (let extra = most; extra >= 0; extra--) {
            const shown = new Set([...base, ...rest.slice(0, extra)]);
            levels.push([this.creditOrder.filter((c) => shown.has(c)), rest.slice(extra)]);
        }
        return levels;
    }

    releaseFloor(pinned, lanes, focus) {
        let floor = 0;
        for (const masterId of pinned) {
            floor += focus && focus.level === 2 && focus.master === masterId ? focus.pageMembers.length + Number(!!focus.rest.length) : 1;
        }
        for (const lane of lanes) {
            if (focus && focus.level === 2 && focus.lane === lane) {
                floor += focus.pageMembers.length + Number(!!focus.rest.length);
                floor += Number(this.masterless.get(lane).length > focus.members.length);
            } else {
                floor += 1;
            }
        }
        return floor;
    }

    planMasters(shown, folded, budget, focus, mode) {
        let pinned = [];
        let remainder = [];
        if (focus && focus.level === 1) [pinned, remainder] = [focus.pageMembers.slice(), focus.rest.slice()];
        else if (focus && focus.master !== null) pinned = [focus.master];
        const held = new Set([...pinned, ...remainder]);
        const candidates = sortedBy(
            shown.flatMap((c) => (this.mastersByCredit.get(c) || []).filter((m) => !held.has(m))),
            (m) => this.masterPriority(m),
        );
        const lanes = shown.filter((c) => (this.masterless.get(c) || []).length);
        const fixedM = pinned.length + Number(!!remainder.length) + lanes.length;
        const fixedR = this.releaseFloor(pinned, lanes, focus);
        let keep = candidates.length;
        const buckets = new Set();
        const over = () => fixedM + keep + buckets.size > budget[1] || fixedR + keep > budget[2];
        while (keep > 0 && over()) {
            keep -= 1;
            buckets.add(this.bucket(candidates[keep], mode).join('\u0000'));
        }
        if (over()) return null;
        const bucketed = new Map();
        for (const masterId of candidates.slice(keep)) {
            const key = this.bucket(masterId, mode);
            const k = key.join('\u0000');
            if (!bucketed.has(k)) bucketed.set(k, { key, masters: [] });
            bucketed.get(k).masters.push(masterId);
        }
        return { shownCredits: shown, foldedCredits: folded, masters: [...pinned, ...candidates.slice(0, keep)], buckets: bucketed, remainder, lanes };
    }

    fit(budget, focus) {
        for (const [shown, folded] of this.creditLevels(budget, focus)) {
            for (const mode of ['decade', ALL]) {
                const plan = this.planMasters(shown, folded, budget, focus, mode);
                if (plan) return plan;
            }
        }
        throw new Error('no strata view fits a validated budget');
    }

    planReleases(plan, budget, focus) {
        const fixedNodes = [];
        const fixedAggs = [];
        const openMasters = [];
        const openLanes = [];
        for (const masterId of plan.masters) {
            if (focus && focus.level === 2 && focus.master === masterId) {
                fixedNodes.push(...focus.pageMembers.map((item) => [item, `m:${masterId}`]));
                if (focus.rest.length) fixedAggs.push({ id: focus.id, parent: `m:${masterId}`, items: focus.rest.slice(), decade: null });
            } else {
                openMasters.push(masterId);
            }
        }
        for (const lane of plan.lanes) {
            const parent = `nm:${creditId(lane)}`;
            let laneItems = this.masterless.get(lane);
            if (focus && focus.level === 2 && focus.lane === lane) {
                fixedNodes.push(...focus.pageMembers.map((item) => [item, parent]));
                if (focus.rest.length) fixedAggs.push({ id: focus.id, parent, items: focus.rest.slice(), decade: focus.decade });
                const focused = new Set(focus.members);
                laneItems = laneItems.filter((item) => !focused.has(item));
            }
            if (laneItems.length) openLanes.push([lane, laneItems]);
        }
        const room = budget[2] - fixedNodes.length - fixedAggs.length;
        const everything = [
            ...openMasters.flatMap((m) => this.itemsByMaster.get(m).map((item) => [item, `m:${m}`])),
            ...openLanes.flatMap(([lane, laneItems]) => laneItems.map((item) => [item, `nm:${creditId(lane)}`])),
        ];
        if (everything.length <= room) return [[...fixedNodes, ...everything], fixedAggs];
        const strategies = [[true, true, true], [true, true, false], [false, true, false], [false, false, false]];
        for (const [keepOriginal, keepStateful, byDecade] of strategies) {
            const [nodes, aggs] = this.foldReleases(openMasters, openLanes, keepOriginal, keepStateful, byDecade);
            if (nodes.length + aggs.length <= room || !(keepOriginal || keepStateful || byDecade)) return [[...fixedNodes, ...nodes], [...fixedAggs, ...aggs]];
        }
        throw new Error('unreachable');
    }

    foldReleases(masters, lanes, keepOriginal, keepStateful, byDecade) {
        const nodes = [];
        const aggs = [];
        for (const masterId of masters) {
            const parent = `m:${masterId}`;
            const kept = [];
            const rest = [];
            for (const item of this.itemsByMaster.get(masterId)) {
                const original = keepOriginal && item.release.provider === 'discogs' && item.release.id === this.anchor.get(masterId);
                (original || (keepStateful && stateful(item)) ? kept : rest).push(item);
            }
            nodes.push(...kept.map((item) => [item, parent]));
            if (rest.length) aggs.push({ id: `ra:m:${masterId}`, parent, items: rest, decade: null });
        }
        for (const [lane, laneItems] of lanes) {
            const parent = `nm:${creditId(lane)}`;
            nodes.push(...laneItems.filter((item) => keepStateful && stateful(item)).map((item) => [item, parent]));
            const rest = laneItems.filter((item) => !(keepStateful && stateful(item)));
            if (!rest.length) continue;
            if (byDecade) {
                const groups = new Map();
                for (const item of rest) push(groups, decade(item.year), item);
                for (const [label, group] of groups) aggs.push({ id: `ra:nm:${creditId(lane)}:${label}`, parent, items: group, decade: label });
            } else {
                aggs.push({ id: `ra:nm:${creditId(lane)}`, parent, items: rest, decade: null });
            }
        }
        return [nodes, aggs];
    }

    counts(items) {
        const [y0, y1] = span(items);
        const counts = {
            releases: items.length,
            undated_releases: items.filter((item) => item.year === null).length,
            musicbrainz_releases: items.filter((item) => item.release.provider === 'musicbrainz').length,
            y0,
            y1,
        };
        if (this.signedIn) {
            const states = {};
            for (const item of items) if (item.state !== null) states[item.state] = (states[item.state] || 0) + 1;
            counts.states = states;
        }
        return counts;
    }

    releaseNode(item, parent) {
        const node = {
            id: nodeId(item),
            parent,
            provider: item.release.provider,
            release_id: item.release.id,
            title: item.release.title,
            year: item.year,
            year_source: item.yearSource,
            undated: item.year === null,
        };
        if (this.signedIn) {
            node.state = item.state;
            node.recorded_at = item.mark === null ? null : { owned: item.mark.ownedAt, wanted: item.mark.wantedAt };
            node.owned_copy_ids = item.mark?.ownedCopyIds ? [...item.mark.ownedCopyIds] : [];
        }
        return node;
    }

    render(budget, focus) {
        const plan = this.fit(budget, focus);
        const [releaseNodes, releaseAggs] = this.planReleases(plan, budget, focus);
        const creditNodes = plan.shownCredits.map((credit) => {
            const items = this.creditItems(credit);
            const node = {
                id: creditId(credit),
                artists: credit.split('+').map((id) => ({ id, name: null })),
                masters: (this.mastersByCredit.get(credit) || []).length,
                masterless: (this.masterless.get(credit) || []).length,
                ...this.counts(items),
            };
            if (this.signedIn) node.state = rollup(items);
            return node;
        });
        const creditAggs = [];
        if (plan.foldedCredits.length) {
            const items = plan.foldedCredits.flatMap((c) => this.creditItems(c));
            creditAggs.push({
                id: OTHER_CREDITS,
                credits: plan.foldedCredits.length,
                masters: plan.foldedCredits.reduce((sum, c) => sum + (this.mastersByCredit.get(c) || []).length, 0),
                ...this.counts(items),
            });
        }
        const creditRank = new Map(this.creditOrder.map((c, i) => [c, i]));
        const masterNodes = sortedBy(plan.masters, (m) => [creditRank.get(this.masterCredit.get(m)), this.masterYear.get(m) === null, this.masterYear.get(m) ?? 0, idKey(m)]).map((masterId) => {
            const items = this.itemsByMaster.get(masterId);
            const ownYear = this.catalog.masterYears.get(masterId) ?? null;
            const year = this.masterYear.get(masterId);
            const node = {
                id: `m:${masterId}`,
                parent: creditId(this.masterCredit.get(masterId)),
                master_id: masterId,
                title: null,
                year,
                year_source: ownYear !== null ? 'master' : year !== null ? 'releases' : null,
                undated: year === null,
                ...this.counts(items),
            };
            if (this.signedIn) node.state = rollup(items);
            return node;
        });
        const bucket = (credit, label, masters) => ({
            id: `ma:${creditId(credit)}:${label}`,
            parent: creditId(credit),
            kind: 'masters',
            decade: label === ALL ? null : label,
            masters: masters.length,
            ...this.counts(masters.flatMap((m) => this.itemsByMaster.get(m))),
        });
        const masterAggs = plan.lanes.map((lane) => ({
            id: `nm:${creditId(lane)}`,
            parent: creditId(lane),
            kind: 'no_master',
            decade: null,
            masters: 0,
            ...this.counts(this.masterless.get(lane)),
        }));
        const buckets = sortedBy([...plan.buckets.values()], ({ key: [credit, label] }) => [creditRank.get(credit), label === UNDATED, label]);
        for (const { key: [credit, label], masters } of buckets) masterAggs.push(bucket(credit, label, masters));
        if (plan.remainder.length) masterAggs.push(bucket(focus.credit, focus.decade, plan.remainder));
        const aggregatesOut = releaseAggs.map((agg) => {
            const entry = { id: agg.id, parent: agg.parent };
            if (agg.decade !== null) entry.decade = agg.decade;
            return { ...entry, ...this.counts(agg.items) };
        });
        const payload = {
            root: { type: 'artist', id: this.catalog.rootId, name: null },
            budget: { credits: budget[0], masters: budget[1], releases: budget[2] },
            focus: null,
            signed_in: this.signedIn,
            totals: {
                credits: this.creditOrder.length,
                masters: this.itemsByMaster.size,
                releases: this.items.length,
                masterless_releases: [...this.masterless.values()].reduce((sum, group) => sum + group.length, 0),
                undated_releases: this.items.filter((item) => item.year === null).length,
                musicbrainz_releases: this.items.filter((item) => item.release.provider === 'musicbrainz').length,
            },
            planes: [
                { level: 0, kind: 'credit', nodes: creditNodes, aggregates: creditAggs },
                { level: 1, kind: 'master', nodes: masterNodes, aggregates: masterAggs, edges: [] },
                { level: 2, kind: 'release', nodes: releaseNodes.map(([item, parent]) => this.releaseNode(item, parent)), aggregates: aggregatesOut },
            ],
        };
        if (focus) {
            payload.focus = {
                id: focus.id,
                plane: ['credit', 'master', 'release'][focus.level],
                page: focus.page,
                pages: focus.pages,
                page_size: focus.pageSize,
                members: focus.members.length,
            };
        }
        return payload;
    }
}

function parseCredit(text) {
    const parts = text.split(':');
    if (![2, 3].includes(parts.length) || parts[0] !== 'c' || !parts[1]) return [null, null];
    return [parts[1], parts.length === 3 ? parts[2] : null];
}

/**
 * The route's payload before labels, as `api.strata.build_strata` returns it.
 *
 * @param {object} catalog - from generateDiscography
 * @param {number[]} [budget] - credits, masters, releases
 * @param {{focus?: string, page?: number, signedIn?: boolean}} [options] - a signed-in caller sees
 *   the catalog's marks; an anonymous one sees no collector field at all
 * @throws {FocusNotFound} when the cursor names nothing under the root (the route's 404)
 */
export function buildStrata(catalog, budget = DEFAULT_BUDGET, { focus = null, page = 0, signedIn = false } = {}) {
    if (!validBudget(budget)) throw new Error(`the route refuses budget ${budget.join('/')}`);
    const ladder = new Ladder(catalog, signedIn ? catalog.marks : null);
    return ladder.render(budget, focus ? ladder.resolveFocus(focus, page, budget) : null);
}

/**
 * What the route's `apply_labels` adds once the fold has run: names and titles for drawn entries,
 * and shared-personnel edges between drawn masters (here, a seeded sample of pairs).
 */
export function labelPayload(payload, r = rng(1)) {
    const [credits, masters, releases] = payload.planes;
    payload.root.name = `Artist ${payload.root.id}`;
    for (const node of credits.nodes) for (const artist of node.artists) artist.name = `Artist ${artist.id}`;
    for (const node of masters.nodes) node.title = `Master ${node.master_id}`;
    for (const node of releases.nodes) if (node.title === null) node.title = `Release ${node.release_id}`;
    const drawn = masters.nodes.map((node) => node.id);
    const edges = [];
    for (let i = 0; i < drawn.length * 2 && drawn.length > 1; i++) {
        const [source, target] = [r.pick(drawn), r.pick(drawn)];
        if (source !== target) edges.push({ source, target, kind: 'shared_personnel', categories: ['Production'], people: r.int(1, 4) });
    }
    masters.edges = edges;
    return payload;
}

/** A labelled route payload for one generated catalog. */
export function buildPayload(catalog, budget = DEFAULT_BUDGET, { focus = null, page = 0, signedIn = false, r = rng(1) } = {}) {
    return labelPayload(buildStrata(catalog, budget, { focus, page, signedIn }), r);
}

/** Every focus cursor a payload offers: its aggregates and its drawn masters. */
export function cursorsOf(payload) {
    return payload.planes.flatMap((plane, level) => [...plane.aggregates.map((agg) => agg.id), ...(level === 1 ? plane.nodes.map((node) => node.id) : [])]);
}

/**
 * Lateral edges between payload entry ids beyond the route's shared personnel: member and collab
 * edges on the credit plane and company edges on the release plane, many of which the planar rule
 * must leave off.
 */
export function generateEdges(r, payload) {
    const ids = (level) => payload.planes[level].nodes.map((node) => node.id);
    const edges = [];
    const pairs = (list, count, kind) => {
        for (let i = 0; i < count && list.length > 1; i++) edges.push({ a: r.pick(list), b: r.pick(list), kind });
    };
    const credits = ids(0);
    for (const id of credits.slice(1)) edges.push({ a: credits[0], b: id, kind: r.chance(0.5) ? 'member' : 'collab' });
    pairs(credits, 4, 'collab');
    const masters = ids(1);
    pairs(masters, masters.length * 2, 'personnel');
    const releases = ids(2);
    pairs(releases, releases.length, 'company');
    pairs([...masters, ...releases], 4, 'personnel');
    return edges;
}

/** Freeze a value and everything under it, so a layout that writes to its input throws. */
export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}
