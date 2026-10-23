/**
 * Generated discographies for the strata layout properties.
 *
 * `rng` is gm-design-on0x's seeded mulberry32 (docs/spikes/gm-design-on0x/lib/rng.mjs).
 * `buildPayload` is a port of gm-design-1h2l's `payload_model.build_payload`
 * (docs/spikes/gm-design-1h2l/scripts/payload_model.py): the aggregation rule catalog-api's strata
 * route applies after its graph read. Running the layout over its output tests the layout against
 * payloads shaped the way the route will shape them. Names are placeholders; nothing here comes
 * from a real catalog.
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

const ROOT_ARTIST = 1;
const STATES = ['none', 'wanted', 'owned'];

/**
 * A synthetic discography for one root artist: releases with a credit (the sorted set of artists
 * it is BY, always holding the root), a master or none, a year or none, and collector state.
 * Shapes swing widely between seeds: masterless shares from 0 to 1, undated shares from 0 to 1, a
 * few releases to `maxReleases`, and one to fourteen credits.
 */
export function generateDiscography(r, { maxReleases = 600 } = {}) {
    const releaseCount = Math.max(1, Math.round(Math.exp(r() * Math.log(maxReleases))));
    const creditCount = r.pick([1, 2, 3, 5, 8, 14]);
    const credits = [[ROOT_ARTIST]];
    const seen = new Set(['1']);
    for (let guard = 0; credits.length < creditCount && guard < 100; guard++) {
        const others = Array.from({ length: r.int(1, 3) }, () => r.int(2, 16));
        const credit = [...new Set([ROOT_ARTIST, ...others])].sort((a, b) => a - b);
        if (!seen.has(credit.join('+'))) {
            seen.add(credit.join('+'));
            credits.push(credit);
        }
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
    const reuse = r.pick([0.2, 0.5, 0.8, 0.95]);
    const start = r.int(1950, 2010);
    const masters = new Map();
    const releases = [];
    for (let id = 1; id <= releaseCount; id++) {
        const year = r.chance(undated) ? null : Math.min(2026, start + Math.floor(Math.pow(r(), 1.4) * (2027 - start)));
        let masterId = null;
        let isMain = false;
        if (!r.chance(masterless)) {
            const ids = [...masters.keys()];
            if (ids.length && r.chance(reuse)) {
                masterId = ids[Math.floor(Math.pow(r(), 2) * ids.length)];
            } else {
                masterId = 500 + masters.size + 1;
                masters.set(masterId, { id: masterId, year: r.chance(masterUndated) ? null : year ?? start });
                isMain = true;
            }
        }
        const state = r.chance(stateful) ? r.pick(STATES.slice(1)) : 'none';
        releases.push({ id, masterId, isMain, year, credit: pickCredit(), state });
    }
    return { rootId: ROOT_ARTIST, releases, masters };
}

/** Lateral edges between payload entry ids, many of which the planar rule must leave off. */
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

// ---------------------------------------------------------------------------------------------
// The payload rule, ported from payload_model.build_payload.
// ---------------------------------------------------------------------------------------------

const NO_YEAR = 'unknown';
const decade = (year) => (year === null ? NO_YEAR : `${Math.floor(year / 10) * 10}s`);
const creditKey = (credit) => credit.join('+');
const creditId = (key) => `c:${key}`;

function span(years) {
    const known = years.filter((year) => year !== null);
    return known.length ? [Math.min(...known), Math.max(...known)] : [null, null];
}

function compareTuples(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
}

function countStates(rs) {
    const states = {};
    for (const r of rs) states[r.state] = (states[r.state] || 0) + 1;
    return states;
}

function rollup(states) {
    return states.includes('owned') ? 'owned' : states.includes('wanted') ? 'wanted' : 'none';
}

export function planeBudgets(budget) {
    if (!budget) return null;
    const [credits, masters, releases] = budget;
    if (!(credits >= 1 && credits <= masters && credits <= releases)) throw new Error('a budget needs 1 <= credits <= masters and credits <= releases');
    return [credits, masters, releases];
}

export function buildPayload({ rootId, releases, masters }, budget, { signedIn = false } = {}) {
    const budgets = planeBudgets(budget);
    const [creditLimit, limit, releaseLimit] = budgets ?? [null, null, null];

    // Credit plane.
    const byCredit = new Map();
    const creditOf = new Map();
    for (const r of releases) {
        const key = creditKey(r.credit);
        byCredit.set(key, (byCredit.get(key) || 0) + 1);
        creditOf.set(key, r.credit);
    }
    const rootKey = String(rootId);
    creditOf.set(rootKey, [rootId]);
    const order = [...byCredit.keys()].sort(
        (a, b) => (a !== rootKey) - (b !== rootKey) || byCredit.get(b) - byCredit.get(a) || compareTuples(creditOf.get(a), creditOf.get(b)),
    );
    if (!byCredit.has(rootKey)) order.unshift(rootKey);
    const shownCredits = creditLimit === null || order.length <= creditLimit ? order : order.slice(0, creditLimit - 1);
    const shownSet = new Set(shownCredits);
    const foldedCredits = order.filter((key) => !shownSet.has(key));
    const creditParent = new Map([...shownCredits.map((key) => [key, creditId(key)]), ...foldedCredits.map((key) => [key, 'c:other'])]);
    const parentOf = (r) => creditParent.get(creditKey(r.credit));
    const creditNodes = shownCredits.map((key) => ({
        id: creditId(key),
        artists: creditOf.get(key).map((id) => ({ id, name: `artist ${id}` })),
        releases: byCredit.get(key) || 0,
    }));
    const creditAggs = foldedCredits.length
        ? [{ id: 'c:other', credits: foldedCredits.length, releases: foldedCredits.reduce((sum, key) => sum + (byCredit.get(key) || 0), 0) }]
        : [];

    // Master plane.
    const relByMaster = new Map();
    let masterless = [];
    for (const r of releases) {
        if (r.masterId === null) masterless.push(r);
        else {
            if (!relByMaster.has(r.masterId)) relByMaster.set(r.masterId, []);
            relByMaster.get(r.masterId).push(r);
        }
    }
    const masterParent = new Map();
    for (const [mid, rs] of relByMaster) {
        const anchor = rs.find((r) => r.isMain) || rs.reduce((lo, r) => (r.id < lo.id ? r : lo));
        masterParent.set(mid, parentOf(anchor));
    }
    const masterlessParents = [...new Set(masterless.map(parentOf))].sort();
    const stateful = new Set([...relByMaster].filter(([, rs]) => rs.some((r) => r.state !== 'none')).map(([mid]) => mid));
    const masterOrder = [...relByMaster.keys()].sort(
        (a, b) => !stateful.has(a) - !stateful.has(b) || relByMaster.get(b).length - relByMaster.get(a).length || a - b,
    );
    const masterYear = (mid) => (masters.has(mid) ? masters.get(mid).year : null);
    const byDecade = (mid) => [masterParent.get(mid), decade(masterYear(mid))];
    const byBand = (mid) => [masterParent.get(mid), 'all'];
    const plan = (bucketOf) => {
        let keep = masterOrder.length;
        const rest = new Set();
        if (limit !== null) {
            const room = limit - masterlessParents.length;
            const releaseRoom = releaseLimit - masterlessParents.length;
            while (keep > 0 && (keep + rest.size > room || keep > releaseRoom)) {
                keep -= 1;
                rest.add(bucketOf(masterOrder[keep]).join('\u0000'));
            }
        }
        return [keep, rest];
    };
    let bucketOf = byDecade;
    let [keep, rest] = plan(bucketOf);
    if (limit !== null && keep + rest.size + masterlessParents.length > limit) {
        bucketOf = byBand;
        [keep, rest] = plan(bucketOf);
    }
    const wholeBands = limit !== null && keep + rest.size + masterlessParents.length > limit;
    if (wholeBands) keep = 0;
    const shownMasters = masterOrder.slice(0, keep);
    const foldedMasters = masterOrder.slice(keep);
    const masterNodes = shownMasters.map((mid) => {
        const rs = relByMaster.get(mid);
        const [y0, y1] = span(rs.map((r) => r.year));
        const node = { id: `m:${mid}`, parent: masterParent.get(mid), title: `master ${mid}`, year: masterYear(mid), releases: rs.length, y0, y1 };
        if (signedIn) node.state = rollup(rs.map((r) => r.state));
        return node;
    });
    const masterAgg = (id, parent, kind, mids, rs, dec = null) => {
        const [y0, y1] = span(rs.map((r) => r.year));
        const agg = { id, parent, kind, masters: mids.length, releases: rs.length, y0, y1 };
        if (dec !== null) agg.decade = dec;
        if (signedIn) agg.states = countStates(rs);
        return agg;
    };
    const masterAggs = [];
    const buckets = new Map();
    for (const mid of foldedMasters) {
        const key = (wholeBands ? byBand : bucketOf)(mid);
        const k = key.join('\u0000');
        if (!buckets.has(k)) buckets.set(k, { key, mids: [] });
        buckets.get(k).mids.push(mid);
    }
    let foldedReleases = foldedMasters.reduce((sum, mid) => sum + relByMaster.get(mid).length, 0);
    if (wholeBands) {
        const bands = [...new Set([...[...buckets.values()].map((b) => b.key[0]), ...masterlessParents])].sort();
        for (const parent of bands) {
            const mids = buckets.get([parent, 'all'].join('\u0000'))?.mids ?? [];
            const rs = [...mids.flatMap((mid) => relByMaster.get(mid)), ...masterless.filter((r) => parentOf(r) === parent)];
            masterAggs.push(masterAgg(`ma:${parent}:all`, parent, 'band', mids, rs));
        }
        foldedReleases += masterless.length;
        masterless = [];
    } else {
        for (const parent of masterlessParents) {
            masterAggs.push(masterAgg(`nm:${parent}`, parent, 'no_master', [], masterless.filter((r) => parentOf(r) === parent)));
        }
        const sorted = [...buckets.values()].sort((a, b) => compareTuples(a.key, b.key));
        for (const { key, mids } of sorted) {
            const rs = mids.flatMap((mid) => relByMaster.get(mid));
            masterAggs.push(masterAgg(`ma:${key[0]}:${key[1]}`, key[0], 'masters', mids, rs, key[1]));
        }
    }

    // Release plane: only releases under a shown master or a no-master band compete.
    const candidates = [...shownMasters.flatMap((mid) => relByMaster.get(mid)), ...masterless];
    let releaseNodes = [];
    let releaseAggs = [];
    const releaseNode = (r) => {
        const parent = r.masterId !== null ? `m:${r.masterId}` : `nm:${parentOf(r)}`;
        const node = { id: `r:${r.id}`, parent, title: `release ${r.id}`, year: r.year };
        if (signedIn) {
            node.state = r.state;
            node.recorded_at = r.state !== 'none' ? '2026-10-22T00:00:00Z' : null;
        }
        return node;
    };
    const countAgg = (id, parent, rs) => {
        const [y0, y1] = span(rs.map((r) => r.year));
        const agg = { id, parent, releases: rs.length, y0, y1 };
        if (signedIn) agg.states = countStates(rs);
        return agg;
    };
    const masterlessAggs = (perDecade = true) => {
        const groups = new Map();
        for (const r of masterless) {
            const key = [`nm:${parentOf(r)}`, perDecade ? decade(r.year) : 'all'];
            const k = key.join('\u0000');
            if (!groups.has(k)) groups.set(k, { key, rs: [] });
            groups.get(k).rs.push(r);
        }
        return [...groups.values()].sort((a, b) => compareTuples(a.key, b.key)).map(({ key, rs }) => countAgg(`ra:${key[0]}:${key[1]}`, key[0], rs));
    };
    if (releaseLimit === null || candidates.length <= releaseLimit) {
        releaseNodes = candidates.map(releaseNode);
    } else {
        const stepNodes = [];
        const stepAggs = [];
        for (const mid of shownMasters) {
            const rs = relByMaster.get(mid);
            const main = rs.find((r) => r.isMain);
            const kept = rs.filter((r) => r === main || r.state !== 'none');
            const others = rs.filter((r) => !kept.includes(r));
            stepNodes.push(...kept.map(releaseNode));
            if (others.length) stepAggs.push(countAgg(`ra:m:${mid}`, `m:${mid}`, others));
        }
        stepAggs.push(...masterlessAggs());
        if (stepNodes.length + stepAggs.length <= releaseLimit) {
            releaseNodes = stepNodes;
            releaseAggs = stepAggs;
        } else {
            releaseAggs = shownMasters.map((mid) => countAgg(`ra:m:${mid}`, `m:${mid}`, relByMaster.get(mid)));
            const tail = masterlessAggs();
            releaseAggs.push(...(releaseAggs.length + tail.length <= releaseLimit ? tail : masterlessAggs(false)));
        }
    }

    return {
        root: { type: 'artist', id: rootId, name: `artist ${rootId}` },
        budget: budgets ? { credits: budgets[0], masters: budgets[1], releases: budgets[2] } : null,
        totals: {
            credits: order.length,
            masters: relByMaster.size,
            releases: releases.length,
            masterless_releases: masterless.length,
            releases_only_in_master_aggregates: foldedReleases,
        },
        planes: [
            { level: 0, kind: 'credit', nodes: creditNodes, aggregates: creditAggs },
            { level: 1, kind: 'master', nodes: masterNodes, aggregates: masterAggs },
            { level: 2, kind: 'release', nodes: releaseNodes, aggregates: releaseAggs },
        ],
    };
}

/** Freeze a value and everything under it, so a layout that writes to its input throws. */
export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}
