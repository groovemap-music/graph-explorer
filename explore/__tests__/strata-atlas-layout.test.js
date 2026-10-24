/**
 * The Genre Atlas layout's properties, over generated atlases (strata-atlas-fixtures.js) and the
 * body recorded from analytics-engine's own read path (tests/fixtures/style-atlas.json):
 *   - every node sits exactly where the payload puts it, by one uniform scale: no re-layout;
 *   - zero hull intrusions, and every ghost inside and counted in its host genre's hull;
 *   - no two node footprints overlap on a plane;
 *   - emergence edges exactly where `emergence_edge` is true, and lateral edges only for a selection;
 *   - stages over valid time, the provisional years, and the rule's words.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { nodeOverlaps } from '../static/js/strata-layout.js';
import {
    ATLAS_RADIUS,
    ATLAS_SIZES,
    EMPTY_MESSAGE,
    MIN_SIZE,
    NO_MASTERS,
    NO_MASTER_SLOTS,
    adaptAtlasPayload,
    atlasFootprint,
    atlasHullIntrusions,
    atlasSelection,
    ghostId,
    ghostsOutsideHost,
    genreId,
    isProvisional,
    masterId,
    lateralEdges,
    layoutAtlas,
    paintAtlas,
    ruleText,
    splitCotags,
    stageAt,
    stageCounts,
    styleId,
} from '../static/js/strata-atlas-layout.js';
import { RULE, emptyAtlasPayload, generateAtlasPayload, rng } from './strata-atlas-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'style-atlas.json'), 'utf8'));

const layoutOf = (payload) => layoutAtlas(adaptAtlasPayload(payload));
const byIdOf = (layout) => new Map(layout.nodes.map((node) => [node.id, node]));
const generated = (count, seed0 = 1) => Array.from({ length: count }, (_, i) => [seed0 + i, generateAtlasPayload(rng(seed0 + i))]);

describe('positions are the payload', () => {
    const check = (payload) => {
        const layout = layoutOf(payload);
        const byId = byIdOf(layout);
        const expected = [
            ...payload.genres.map((g) => [genreId(g.genre), g]),
            ...payload.styles.map((s) => [styleId(s.style), s]),
            ...payload.ghosts.map((h) => [ghostId(h.style, h.genre), h]),
        ];
        // One node per payload entry, and nothing else.
        expect(layout.nodes).toHaveLength(expected.length);
        for (const [id, entry] of expected) {
            const node = byId.get(id);
            expect(node.ax).toBe(entry.x);
            expect(node.ay).toBe(entry.y);
            expect(node.x).toBe(entry.x * ATLAS_RADIUS);
            expect(node.z).toBe(-entry.y * ATLAS_RADIUS);
        }
    };

    it('holds for the body recorded from analytics-engine', () => check(RECORDED.body));

    it.each(generated(60))('holds for generated atlas %i', (_, payload) => check(payload));

    it('puts genres, styles, and ghosts on their planes, and no node on the master plane', () => {
        const layout = layoutOf(RECORDED.body);
        expect(layout.nodes.filter((node) => node.level === 0).map((node) => node.entity)).toEqual(RECORDED.body.genres.map(() => 'genre'));
        expect(new Set(layout.nodes.filter((node) => node.level === 1).map((node) => node.entity))).toEqual(new Set(['style', 'ghost']));
        expect(layout.nodes.filter((node) => node.level === 2)).toEqual([]);
        expect(layout.planes.map((plane) => [plane.name, plane.count])).toEqual([
            ['Genres', RECORDED.body.genres.length],
            ['Styles', RECORDED.body.styles.length + RECORDED.body.ghosts.length],
            ['Masters', 0],
        ]);
        expect(layout.planes[2].note).toMatch(/not served/);
    });
});

describe('the master plane seam', () => {
    // Landmark masters are served with no position and placed only by a slot rule. These hold the
    // seam with a stand-in rule: no slot rule, no master node. strata-master-slots.test.js holds
    // the real rule.
    const withMasters = (payload) => ({
        ...payload,
        masters: payload.styles.slice(0, 12).map((style, i) => ({ master_id: 500 + i, title: `Landmark ${i}`, year: 1960 + i, style: style.style, release_count: 40 - i })),
    });
    // A stand-in slot: just outside the style's own node, along its radius.
    const slot = (master, { style }) => {
        const k = 1 + 0.004 * (Number(master.masterId) % 7);
        return { x: style.x * k, y: style.y * k, radius: 0.001 };
    };

    it('is empty and says the route serves none, with or without a slot rule', () => {
        for (const options of [{}, { masterSlot: slot }]) {
            const layout = layoutAtlas(adaptAtlasPayload(RECORDED.body), options);
            expect(layout.nodes.filter((n) => n.level === 2)).toEqual([]);
            expect(layout.planes[2].note).toBe(NO_MASTERS);
        }
    });

    it('stays empty when masters are served but no slot rule places them', () => {
        const layout = layoutAtlas(adaptAtlasPayload(withMasters(RECORDED.body)));
        expect(layout.nodes.filter((n) => n.level === 2)).toEqual([]);
        expect(layout.planes[2].note).toBe(NO_MASTER_SLOTS);
    });

    it('needs a footprint radius from the slot rule, since a master is sized by its slot', () => {
        const payload = withMasters(RECORDED.body);
        expect(() => layoutAtlas(adaptAtlasPayload(payload), { masterSlot: (master, { style }) => ({ x: style.x, y: style.y }) })).toThrow(/no footprint radius/);
    });

    it('refuses a master listed twice for one style, and keeps one listed under two styles', () => {
        const payload = withMasters(RECORDED.body);
        const twice = { ...payload, masters: [...payload.masters, payload.masters[0]] };
        expect(() => adaptAtlasPayload(twice)).toThrow(/listed twice/);
        const two = { ...payload, masters: [...payload.masters, { ...payload.masters[0], style: payload.masters[1].style }] };
        expect(adaptAtlasPayload(two).masters).toHaveLength(payload.masters.length + 1);
    });

    it('places served masters only through the slot rule, under their style', () => {
        const payload = withMasters(RECORDED.body);
        const layout = layoutAtlas(adaptAtlasPayload(payload), { masterSlot: slot });
        const byId = byIdOf(layout);
        const masters = layout.nodes.filter((n) => n.level === 2);
        expect(masters).toHaveLength(12);
        expect(layout.planes[2]).toMatchObject({ count: 12, note: null });
        for (const raw of payload.masters) {
            const node = byId.get(masterId(raw.master_id, raw.style));
            const style = byId.get(styleId(raw.style));
            const at = slot({ masterId: String(raw.master_id) }, { style: style.data });
            expect([node.ax, node.ay]).toEqual([at.x, at.y]);
            expect([node.x, node.z]).toEqual([at.x * ATLAS_RADIUS, -at.y * ATLAS_RADIUS]);
            expect(node.parent).toBe(style.id);
            expect(style.children).toContain(node.id);
            expect(atlasSelection(byId, style.id).has(node.id)).toBe(true);
            expect(atlasSelection(byId, node.id)).toEqual(new Set([node.id, style.id, style.parent]));
        }
        expect(nodeOverlaps(layout, 2)).toBe(0);
        expect(atlasHullIntrusions(layout)).toBe(0);
        paintAtlas(layout, 1965);
        expect(masters.map((n) => n.stage)).toEqual(payload.masters.map((m) => (1965 < m.year ? 'absent' : null)));
        expect(lateralEdges(layout, byId, masters[0].id)).toEqual([]);
    });
});

describe('hulls', () => {
    const check = (payload) => {
        const layout = layoutOf(payload);
        expect(atlasHullIntrusions(layout)).toBe(0);
        expect(ghostsOutsideHost(layout)).toEqual([]);
        // Every ghost is counted in its host's hull, and every hull counts exactly what it hosts.
        for (const hull of layout.hulls) {
            const ghosts = payload.ghosts.filter((ghost) => ghost.genre === hull.genre);
            const styles = payload.styles.filter((style) => style.genre === hull.genre);
            expect(hull.ghosts).toBe(ghosts.length);
            expect(hull.styles).toBe(styles.length);
            expect(new Set(hull.members)).toEqual(new Set([...ghosts.map((g) => ghostId(g.style, g.genre)), ...styles.map((s) => styleId(s.style))]));
            expect(hull.pad).toBeGreaterThan(0);
        }
        return layout;
    };

    it('the recorded body has zero intrusions and every ghost counted in its host hull', () => {
        const layout = check(RECORDED.body);
        expect(RECORDED.body.ghosts.length).toBeGreaterThan(20);
        expect(layout.hulls.reduce((sum, hull) => sum + hull.ghosts, 0)).toBe(RECORDED.body.ghosts.length);
    });

    it.each(generated(200, 1000))('generated atlas %i has zero intrusions and every ghost counted', (_, payload) => {
        check(payload);
    });

    it('counts a node inside a foreign hull as an intrusion', () => {
        const payload = generateAtlasPayload(rng(7), { genres: 8, styles: 120 });
        const layout = layoutOf(payload);
        const [first, second] = layout.hulls;
        const intruder = layout.nodes.find((node) => node.group === second.group && node.entity === 'style' && !node.data.parents.some((p) => p.genre === first.genre));
        const member = layout.nodes.find((node) => node.id === first.members[0]);
        intruder.x = member.x;
        intruder.z = member.z;
        expect(atlasHullIntrusions(layout)).toBeGreaterThan(0);
    });

    it('a primary node inside a secondary parent hull is not an intrusion', () => {
        const payload = generateAtlasPayload(rng(11), { genres: 8, styles: 150 });
        const layout = layoutOf(payload);
        const ghost = layout.nodes.find((node) => node.entity === 'ghost');
        const primary = layout.nodes.find((node) => node.id === ghost.ghostOf);
        primary.x = ghost.x;
        primary.z = ghost.z;
        expect(atlasHullIntrusions(layout)).toBe(0);
    });
});

describe('the footprint check', () => {
    it('sizes each plane so no two footprints overlap, over generated atlases and the recorded body', () => {
        for (const payload of [RECORDED.body, ...generated(80, 3000).map(([, p]) => p)]) {
            const layout = layoutOf(payload);
            for (const level of [0, 1]) expect(nodeOverlaps(layout, level)).toBe(0);
            for (const check of layout.footprint) {
                expect(check.size).toBeLessThanOrEqual(ATLAS_SIZES[check.level]);
                if (check.nodes > 1) expect(check.fit).toBe(true);
            }
        }
    });

    it('keeps the plane size when there is room, and gives way when there is not', () => {
        expect(atlasFootprint([[0, 0], [100, 0]], 2)).toEqual({ size: 2, nearest: 100, fit: true });
        expect(atlasFootprint([[0, 0], [1, 0]], 2).size).toBeCloseTo(0.4);
        expect(atlasFootprint([[0, 0], [0.01, 0]], 2)).toMatchObject({ size: MIN_SIZE, fit: false });
        expect(atlasFootprint([[0, 0]], 2)).toMatchObject({ size: 2, nearest: Infinity, fit: true });
    });
});

describe('edges', () => {
    it('draws an emergence edge exactly for each (style, parent) pair the payload marks', () => {
        for (const payload of [RECORDED.body, ...generated(40, 5000).map(([, p]) => p)]) {
            const layout = layoutOf(payload);
            const expected = new Set();
            for (const style of payload.styles) {
                for (const parent of style.parents) {
                    if (!parent.emergence_edge) continue;
                    const from = parent.dominant ? styleId(style.style) : ghostId(style.style, parent.genre);
                    expected.add(`${from}>${genreId(parent.genre)}`);
                }
            }
            expect(new Set(layout.emergence.map((link) => `${link.from}>${link.to}`))).toEqual(expected);
            for (const link of layout.emergence) expect(link.ghost).toBe(link.from.startsWith('h:'));
        }
    });

    it('the recorded body has emergence edges and pairs without one', () => {
        const parents = RECORDED.body.styles.flatMap((style) => style.parents);
        expect(parents.some((parent) => parent.emergence_edge)).toBe(true);
        expect(parents.some((parent) => !parent.emergence_edge)).toBe(true);
    });

    it('draws no lateral edge without a selected style, and a star around it with one', () => {
        const layout = layoutOf(RECORDED.body);
        const byId = byIdOf(layout);
        expect(layout.edges).toEqual([]);
        expect(lateralEdges(layout, byId, null)).toEqual([]);
        expect(lateralEdges(layout, byId, genreId(RECORDED.body.genres[0].genre))).toEqual([]);

        const ghost = layout.nodes.find((node) => node.entity === 'ghost');
        const primary = byId.get(ghost.ghostOf);
        const star = lateralEdges(layout, byId, ghost.id);
        expect(star).toEqual(primary.ghosts.map((id) => ({ a: primary.id, b: id, kind: 'ghost' })));
        expect(lateralEdges(layout, byId, primary.id)).toEqual(star);

        // A co-tag source adds its drawn styles, still as a star around the selection.
        // The source's entries have the planned cotags route's shape; they are drawn best rank first.
        const [other, third] = layout.nodes.filter((node) => node.entity === 'style' && node.id !== primary.id);
        const entries = [
            { other: third.style, release_count: 80, rank: 2 },
            { other: 'Not Drawn', release_count: 90, rank: 3 },
            { other: primary.style, release_count: 99, rank: 0 },
            { other: other.style, release_count: 120, rank: 1 },
        ];
        const withCotags = lateralEdges(layout, byId, primary.id, (name) => (name === primary.style ? entries : []));
        expect(withCotags.filter((edge) => edge.kind === 'cotag')).toEqual([
            { a: primary.id, b: other.id, kind: 'cotag', rank: 1, releaseCount: 120 },
            { a: primary.id, b: third.id, kind: 'cotag', rank: 2, releaseCount: 80 },
        ]);
        expect(withCotags.every((edge) => edge.a === primary.id)).toBe(true);
    });

    it('splits co-tags into the pairs drawn and the pairs only listed, best rank first', () => {
        const layout = layoutOf(RECORDED.body);
        const byId = byIdOf(layout);
        const ghost = layout.nodes.find((node) => node.entity === 'ghost');
        const primary = byId.get(ghost.ghostOf);
        const [other, third] = layout.nodes.filter((node) => node.entity === 'style' && node.id !== primary.id);
        const entries = [
            { other: 'Not Drawn', release_count: 90, rank: 3 },
            { other: third.style, release_count: 80, rank: 2 },
            { other: primary.style, release_count: 99, rank: 0 },
            { other: other.style, release_count: 120, rank: 1 },
            null,
            { release_count: 5, rank: 9 },
        ];
        const { drawn, listed } = splitCotags(byId, primary.id, entries);
        expect(drawn.map((entry) => entry.other)).toEqual([other.style, third.style]);
        // A style paired with itself, and one the atlas does not draw, stay listed.
        expect(listed.map((entry) => entry.other)).toEqual([primary.style, 'Not Drawn']);
        // A ghost copy splits the same as its style; nothing is drawn without a style selected.
        expect(splitCotags(byId, ghost.id, entries).drawn).toEqual(drawn);
        expect(splitCotags(byId, null, entries).drawn).toEqual([]);
        expect(splitCotags(byId, primary.id, undefined)).toEqual({ drawn: [], listed: [] });
    });

    it('a selection lights every copy of a style and its parent genres, or a genre and what it hosts', () => {
        const layout = layoutOf(RECORDED.body);
        const byId = byIdOf(layout);
        const ghost = layout.nodes.find((node) => node.entity === 'ghost');
        const primary = byId.get(ghost.ghostOf);
        const lit = atlasSelection(byId, ghost.id);
        expect(lit).toEqual(new Set([primary.id, ...primary.ghosts, ...primary.data.parents.map((p) => genreId(p.genre))]));
        const genre = byId.get(genreId(ghost.genre));
        expect(atlasSelection(byId, genre.id)).toEqual(new Set([genre.id, ...genre.children]));
        expect(genre.children).toContain(ghost.id);
        expect(atlasSelection(byId, null)).toBeNull();
    });
});

describe('valid time', () => {
    it('paints each style with its stage in the scrubbed year, and ghosts with their style', () => {
        const payload = RECORDED.body;
        const layout = layoutOf(payload);
        const { timeline } = layout.atlas;
        for (const year of [timeline.firstYear, 1975, timeline.provisionalFrom - 1, timeline.lastYear]) {
            const painted = paintAtlas(layout, year);
            expect(painted).toEqual({ year, provisional: year >= payload.timeline.provisional_from });
            for (const style of payload.styles) {
                const expected = payload.rule.stages[style.stages[year - payload.timeline.first_year]];
                for (const node of layout.nodes.filter((n) => n.style === style.style)) {
                    expect(node.stage).toBe(expected);
                    expect(node.provisional).toBe(painted.provisional);
                }
            }
        }
        expect(paintAtlas(layout, 1800).year).toBe(timeline.firstYear);
        expect(paintAtlas(layout, 3000).year).toBe(timeline.lastYear);
    });

    it('the latest stage is the last year, and the settled stage the last year before the provisional ones', () => {
        const atlas = adaptAtlasPayload(RECORDED.body);
        const { timeline, rule } = atlas;
        for (const style of atlas.styles) {
            expect(stageAt(style, timeline, rule, timeline.lastYear)).toBe(style.stage);
            expect(stageAt(style, timeline, rule, timeline.provisionalFrom - 1)).toBe(style.settledStage);
        }
    });

    it('marks the timeline latest two years provisional', () => {
        const { timeline } = adaptAtlasPayload(RECORDED.body);
        const provisional = [];
        for (let year = timeline.firstYear; year <= timeline.lastYear; year++) if (isProvisional(timeline, year)) provisional.push(year);
        expect(provisional).toEqual([timeline.lastYear - 1, timeline.lastYear]);
    });

    it('a genre is absent before its emergence year and has no stage after it', () => {
        const layout = layoutOf(RECORDED.body);
        const genre = layout.nodes.find((node) => node.entity === 'genre' && node.emergenceYear !== null && node.emergenceYear > layout.atlas.timeline.firstYear);
        paintAtlas(layout, genre.emergenceYear - 1);
        expect(genre.stage).toBe('absent');
        paintAtlas(layout, genre.emergenceYear);
        expect(genre.stage).toBeNull();
        expect(genre.provisional).toBe(false);
    });

    it('counts styles per stage, primary nodes only', () => {
        const layout = layoutOf(RECORDED.body);
        paintAtlas(layout, layout.atlas.timeline.lastYear);
        const counts = stageCounts(layout);
        expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(RECORDED.body.styles.length);
    });
});

describe('the stage rule on screen', () => {
    it('words every stage with its thresholds, names every threshold, and carries the version', () => {
        const words = ruleText(RULE);
        expect(words.version).toBe('gm-design-4804/1');
        expect(words.title).toBe('Stage rule (version 1)');
        expect(words.notes[0]).toBe('Stages are judged over release-year counts.');
        expect(words.stages.map((s) => s.stage)).toEqual(RULE.stages);
        const condition = Object.fromEntries(words.stages.map((s) => [s.stage, s.condition]));
        expect(condition.absent).toBe('before the year it reaches 25 cumulative releases');
        expect(condition.emerging).toBe('trailing mean at least 0.5 × its peak, under 10 years after emergence');
        expect(condition.established).toBe('trailing mean at least 0.5 × its peak, 10 or more years after emergence');
        expect(condition.reviving).toBe('trailing mean under 0.5 × its peak, but at least 1.5 × its trough and 0.25 × its peak');
        expect(condition.declining).toBe('otherwise');
        expect(words.notes.join(' ')).toContain('over 3 years');
        expect(words.notes.join(' ')).toContain('The latest 2 years are provisional');
        expect(words.thresholds).toEqual([
            { name: 'emerge_total', value: '25' },
            { name: 'active_share', value: '0.5' },
            { name: 'establish_years', value: '10' },
            { name: 'revive_ratio', value: '1.5' },
            { name: 'revive_floor', value: '0.25' },
            { name: 'window', value: '3' },
            { name: 'provisional_years', value: '2' },
        ]);
    });

    it('reads changed thresholds, and still shows a stage or threshold it has no words for', () => {
        const words = ruleText({ ...RULE, active_share: 0.55, rule_version: 'gm-design-4804/2', stages: [...RULE.stages, 'dormant'], dormant_after: 30 });
        expect(words.title).toBe('Stage rule (version 2)');
        expect(words.version).toBe('gm-design-4804/2');
        expect(words.stages.find((s) => s.stage === 'emerging').condition).toContain('0.55 × its peak');
        expect(words.stages.find((s) => s.stage === 'dormant').condition).toMatch(/no description/);
        expect(words.thresholds).toContainEqual({ name: 'dormant_after', value: '30' });
        expect(ruleText({ stages: ['absent'] }).version).toBe('unversioned');
        expect(ruleText({ stages: ['absent'] }).title).toBe('Stage rule');
    });
});

describe('the payload', () => {
    it('reads an empty month as empty, with the rule still present', () => {
        const atlas = adaptAtlasPayload(emptyAtlasPayload());
        expect(atlas).toMatchObject({ empty: true, month: null, timeline: null, genres: [], styles: [], ghosts: [] });
        expect(atlas.rule.rule_version).toBe('gm-design-4804/1');
        expect(EMPTY_MESSAGE).toMatch(/no monthly run yet/);
    });

    it('refuses a body it cannot read', () => {
        const good = generateAtlasPayload(rng(5), { genres: 6, styles: 20, years: 20 });
        const broken = [
            null,
            { ...good, rule: null },
            { ...good, styles: [{ ...good.styles[0], stages: good.styles[0].stages.slice(1) }] },
            { ...good, styles: [{ ...good.styles[0], stages: good.styles[0].stages.map(() => 9) }] },
            { ...good, styles: [{ ...good.styles[0], x: 'east' }] },
            { ...good, ghosts: [{ style: 'Nobody', genre: good.genres[0].genre, x: 0, y: 0 }] },
            { ...good, genres: [good.genres[0], good.genres[0]] },
            { ...good, timeline: { ...good.timeline, last_year: good.timeline.first_year - 1 } },
        ];
        for (const payload of broken) expect(() => adaptAtlasPayload(payload)).toThrow(/invalid style-atlas payload/);
    });

    it('the recorded body is analytics-engine read path output at a pinned producer commit', () => {
        expect(RECORDED.producer_repository).toBe('https://github.com/groovemap-music/analytics-engine');
        expect(RECORDED.producer_commit).toMatch(/^[0-9a-f]{40}$/);
        expect(RECORDED.body.rule.rule_version).toBe('gm-design-4804/1');
    });
});
