/**
 * Generated `GET /api/insights/style-atlas` bodies for the Genre Atlas property tests.
 *
 * The generator follows analytics-engine's geography rule (insights/style_atlas.py), so the
 * properties hold over the layouts the server can produce: a genre ring whose sectors are sized
 * by the square root of their membership plus one, each style in its dominant parent's sector and
 * a ghost copy in every secondary parent's, placed by lean rank (angle, inside the middle 80% of
 * the sector) and emergence rank (radius 0.35 to 0.95), and each genre node at radius 0.65 in its
 * sector's middle. The ring starts at a random angle, so sector bounds pass 2π as pinned frames
 * can. Stages are a random walk over the rule's indexes, absent before emergence.
 */

import { rng } from './strata-fixtures.js';

export { rng };

export const RULE = Object.freeze({
    basis: 'release_year',
    stages: ['absent', 'emerging', 'established', 'declining', 'reviving'],
    emerge_total: 25.0,
    active_share: 0.5,
    establish_years: 10.0,
    revive_ratio: 1.5,
    revive_floor: 0.25,
    window: 3,
    provisional_years: 2,
    rule_version: 'gm-design-4804/1',
});

const TAU = Math.PI * 2;

function ranks(keys) {
    const order = keys.map((key, i) => i).sort((a, b) => keys[a][0] - keys[b][0] || (keys[a][1] < keys[b][1] ? -1 : keys[a][1] > keys[b][1] ? 1 : 0));
    const out = new Array(keys.length);
    order.forEach((i, rank) => {
        out[i] = (rank + 0.5) / keys.length;
    });
    return out;
}

/**
 * A style-atlas body.
 *
 * @param {Function} r - a seeded rng (strata-fixtures.js rng)
 * @param {{genres?: number, styles?: number, years?: number, firstYear?: number}} [options]
 */
export function generateAtlasPayload(r, { genres: genreCount = r.int(6, 16), styles: styleCount = r.int(20, 260), years = r.int(12, 76), firstYear = 1950 } = {}) {
    const lastYear = firstYear + years - 1;
    const genreNames = Array.from({ length: genreCount }, (_, i) => `Genre ${String.fromCharCode(65 + i)}`);
    const genreYear = new Map(genreNames.map((name) => [name, r.chance(0.1) ? null : r.int(firstYear - 20, lastYear)]));

    const styles = [];
    for (let i = 0; i < styleCount; i++) {
        const home = r.int(0, genreCount - 1);
        const shares = new Map([[home, 0.85 + r() * 0.15]]);
        if (r.chance(0.45)) {
            const near = r.chance(0.7) ? (home + (r.chance(0.5) ? 1 : genreCount - 1)) % genreCount : r.int(0, genreCount - 1);
            if (near !== home) shares.set(near, 0.2 + r() * 0.4);
        }
        if (r.chance(0.12)) {
            const third = r.int(0, genreCount - 1);
            if (!shares.has(third)) shares.set(third, 0.2 + r() * 0.15);
        }
        const emergence = r.chance(0.08) ? null : r.int(firstYear, lastYear);
        const start = emergence === null ? years : emergence - firstYear;
        const stages = [];
        let stage = 1;
        for (let k = 0; k < years; k++) {
            if (k < start) stages.push(0);
            else {
                if (r.chance(0.12)) stage = r.int(1, 4);
                stages.push(stage);
            }
        }
        const name = `Style ${String(i).padStart(4, '0')}`;
        const parents = [...shares]
            .map(([g, share]) => ({ genre: genreNames[g], share: Math.round(share * 1e4) / 1e4 }))
            .sort((a, b) => b.share - a.share || (a.genre < b.genre ? -1 : 1))
            .map((parent, k) => {
                const gy = genreYear.get(parent.genre);
                return { ...parent, dominant: k === 0, emergence_edge: emergence !== null && gy !== null && emergence > gy };
            });
        styles.push({ name, parents, emergence, stages, lean: r() });
    }

    // Entries: one per (style, parent), hosted in that parent's sector.
    const hosted = new Map(genreNames.map((name) => [name, []]));
    for (const style of styles) for (const parent of style.parents) hosted.get(parent.genre).push({ style, kind: parent.dominant ? 'style' : 'ghost' });
    const raw = genreNames.map((name) => Math.sqrt(hosted.get(name).length + 1));
    const total = raw.reduce((a, b) => a + b, 0);
    let at = r() * TAU;
    const genres = [];
    const nodes = [];
    genreNames.forEach((name, k) => {
        const start = at;
        const end = at + (TAU * raw[k]) / total;
        at = end;
        const mid = (start + end) / 2;
        genres.push({ genre: name, ring_order: k, sector_start: start, sector_end: end, x: 0.65 * Math.cos(mid), y: 0.65 * Math.sin(mid), emergence_year: genreYear.get(name) });
        const entries = hosted.get(name);
        if (!entries.length) return;
        const lean = ranks(entries.map(({ style }) => [style.lean, style.name]));
        const age = ranks(entries.map(({ style }) => [style.emergence === null ? Infinity : style.emergence, style.name]));
        entries.forEach(({ style, kind }, i) => {
            const theta = start + (end - start) * (0.1 + 0.8 * lean[i]);
            const rho = 0.35 + 0.6 * age[i];
            nodes.push({ kind, style: style.name, genre: name, x: rho * Math.cos(theta), y: rho * Math.sin(theta) });
        });
    });

    const at0 = (style) => nodes.find((node) => node.kind === 'style' && node.style === style.name);
    const settledIndex = years - RULE.provisional_years - 1;
    return {
        month: `${lastYear + 1}-10-01`,
        computed_at: `${lastYear + 1}-10-02T03:00:00Z`,
        rule: { ...RULE, stages: [...RULE.stages] },
        timeline: { first_year: firstYear, last_year: lastYear, provisional_from: lastYear - RULE.provisional_years + 1 },
        genres,
        styles: styles.map((style) => {
            const node = at0(style);
            return {
                style: style.name,
                genre: node.genre,
                x: node.x,
                y: node.y,
                stage: RULE.stages[style.stages[years - 1]],
                settled_stage: settledIndex >= 0 ? RULE.stages[style.stages[settledIndex]] : null,
                emergence_year: style.emergence,
                stages: style.stages,
                parents: style.parents,
            };
        }),
        ghosts: nodes.filter((node) => node.kind === 'ghost').map(({ style, genre, x, y }) => ({ style, genre, x, y })),
    };
}

/** The body before the first monthly run: no month, no geography, and the rule still shown. */
export function emptyAtlasPayload() {
    return { month: null, computed_at: null, rule: { ...RULE, stages: [...RULE.stages] }, timeline: null, genres: [], styles: [], ghosts: [] };
}
