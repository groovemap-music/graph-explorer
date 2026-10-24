// @vitest-environment node
/**
 * The strata fixtures port catalog-api's fold (strata-fixtures.js `buildStrata`). These bodies were
 * written by the Python itself (`api.strata.build_strata` and `apply_labels` at the promoted
 * producer commit) over an invented catalog, so replaying the catalog through the port must give
 * the same bodies, labels aside. If catalog-api changes its fold, re-record the bodies with the new
 * contract and this test names what moved.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildStrata } from './strata-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'tests', 'fixtures', 'strata-route.json'), 'utf8'));
const SOURCE = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'contracts', 'catalog-api', 'graph-explorer', 'v1', 'source.json'), 'utf8'));

const catalog = {
    rootId: RECORDED.catalog.rootId,
    releases: RECORDED.catalog.releases,
    masterYears: new Map(RECORDED.catalog.masterYears),
    marks: new Map(RECORDED.catalog.marks),
};

// What apply_labels fills: names, titles of drawn Discogs entries, and the master edges.
function unlabelled(body) {
    const copy = structuredClone(body);
    const [credits, masters, releases] = copy.planes;
    copy.root.name = null;
    for (const node of credits.nodes) for (const artist of node.artists) artist.name = null;
    for (const node of masters.nodes) node.title = null;
    for (const node of releases.nodes) if (node.provider === 'discogs') node.title = null;
    masters.edges = [];
    return copy;
}

describe('the fixture fold against bodies the route recorded', () => {
    it('was recorded at the promoted producer commit', () => {
        expect(RECORDED.producer_commit).toBe(SOURCE.producer_commit);
        expect(RECORDED.responses.length).toBeGreaterThan(20);
    });

    it.each(RECORDED.responses.map((entry) => [entry.query.focus ?? 'default', entry.query.page, entry.query.signed_in, entry]))(
        'replays %s page %i (signed in: %s)',
        (_, __, ___, { query, body }) => {
            const replayed = buildStrata(catalog, RECORDED.budget, { focus: query.focus, page: query.page, signedIn: query.signed_in });
            expect(replayed).toEqual(unlabelled(body));
        },
    );
});
