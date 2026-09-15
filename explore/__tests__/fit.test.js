import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadScript } from './helpers.js';

/** A full profile: every component scored, every component with evidence. */
const FULL_PROFILE = {
    release: {
        id: '249504',
        gm_id: 'gm:release:249504',
        title: 'Never Gonna Give You Up',
        artist: 'Rick Astley',
        year: 1987,
        media_families: ['vinyl'],
        rarity: { score: 0.31, tier: 'common' },
    },
    fit: 0.62,
    components: {
        affinity: { score: 0.55, evidence: ['shares artist Rick Astley with 2 releases you hold'] },
        novelty: { score: 0.4, evidence: ['Stock Aitken Waterman is a label your collection has never held'] },
        bridge: {
            score: 1.0,
            evidence: [
                'bridges Electronic and Rock, which share no artist or label in your collection',
                'region boundaries are the v0 genre heuristic, not a computed community',
            ],
        },
        depth: { score: 0.4, evidence: ['deepens artist Rick Astley (2 held)'] },
        redundancy: { score: 0.0, evidence: [] },
    },
    confidence: 'exact',
    policy_id: 'cratefit_v0',
    fit_version: 'cratefit_v0',
    impression_id: 'imp-fit-1',
};

/**
 * A sparse profile: a collection thin enough that four of the five components
 * say nothing, the release carries no native id so the API minted no impression,
 * and the graph has no title, artist, year, media family, or rarity for it.
 */
const SPARSE_PROFILE = {
    release: { id: '999', gm_id: null, title: null, artist: null, year: null, media_families: [], rarity: null },
    fit: 0.1,
    components: {
        affinity: { score: 0.0, evidence: [] },
        novelty: { score: 0.1, evidence: [] },
        bridge: { score: 0.0, evidence: [] },
        depth: { score: 0.0, evidence: [] },
        redundancy: { score: 0.0, evidence: [] },
    },
    confidence: 'master',
    policy_id: 'cratefit_v0',
    fit_version: 'cratefit_v0',
    impression_id: null,
};

const RELEASE_HIT = {
    id: '249504',
    name: 'Never Gonna Give You Up',
    type: 'release',
    relevance: 0.91,
    metadata: { artist: 'Rick Astley', year: 1987, media_families: ['vinyl'] },
};

function setupFitDOM() {
    document.body.textContent = '';
    document.body.innerHTML = `
        <div class="pane" id="fitPane">
            <div class="user-pane-empty" id="fitSignedOut" hidden></div>
            <div class="fit-picker" id="fitPicker" hidden>
                <input type="text" id="fitSearchInput">
                <button id="fitSearchBtn"></button>
                <button id="fitRunBtn" disabled></button>
                <div class="fit-candidates" id="fitCandidates"></div>
            </div>
            <div class="loading-overlay" id="fitLoading"></div>
            <div class="fit-profile" id="fitBody"></div>
        </div>`;
}

function signedIn(token = 'valid-token') {
    window.authManager = { getToken: vi.fn().mockReturnValue(token), isLoggedIn: vi.fn().mockReturnValue(Boolean(token)) };
}

function anonymous() {
    window.authManager = { getToken: vi.fn().mockReturnValue(null), isLoggedIn: vi.fn().mockReturnValue(false) };
}

describe('FitPane', () => {
    let pane;

    beforeEach(() => {
        globalThis.window = globalThis;
        setupFitDOM();
        window.apiClient = {
            search: vi.fn(),
            getFitProfile: vi.fn(),
            postActivityEvent: vi.fn().mockResolvedValue({ ok: true, status: 202, body: null }),
        };
        signedIn();
        delete window.exploreApp;
        loadScript('fit.js');
        pane = window.fitPane;
    });

    // ------------------------------------------------------------------ //
    // Session state
    // ------------------------------------------------------------------ //

    describe('session state', () => {
        it('shows the picker and hides the sign-in prompt for a signed-in session', () => {
            pane.init();

            expect(document.getElementById('fitPicker').hidden).toBe(false);
            expect(document.getElementById('fitSignedOut').hidden).toBe(true);
        });

        it('shows the sign-in prompt and no picker for an anonymous session', () => {
            anonymous();

            pane.init();

            expect(document.getElementById('fitPicker').hidden).toBe(true);
            expect(document.getElementById('fitSignedOut').hidden).toBe(false);
        });

        it('clears a rendered profile and the picker when the session ends', () => {
            pane.init();
            pane.renderProfile(document.getElementById('fitBody'), FULL_PROFILE);
            document.getElementById('fitSearchInput').value = 'never gonna';
            expect(document.querySelector('.fit-card')).not.toBeNull();

            anonymous();
            pane.refreshSession();

            expect(document.querySelector('.fit-card')).toBeNull();
            expect(document.getElementById('fitSearchInput').value).toBe('');
            expect(document.getElementById('fitCandidates').children.length).toBe(0);
            expect(document.getElementById('fitRunBtn').disabled).toBe(true);
        });
    });

    // ------------------------------------------------------------------ //
    // Release picker
    // ------------------------------------------------------------------ //

    describe('release picker', () => {
        it('searches the release type only', async () => {
            window.apiClient.search.mockResolvedValue({ results: [RELEASE_HIT], total: 1 });

            await pane.findCandidates('never gonna');

            expect(window.apiClient.search).toHaveBeenCalledTimes(1);
            expect(window.apiClient.search.mock.calls[0][0]).toBe('never gonna');
            expect(window.apiClient.search.mock.calls[0][1]).toEqual(['release']);
        });

        it('renders each hit with its title, artist, year and media badges', async () => {
            window.apiClient.search.mockResolvedValue({ results: [RELEASE_HIT], total: 1 });

            await pane.findCandidates('never gonna');

            const option = document.querySelector('.fit-candidate');
            expect(option.dataset.releaseId).toBe('249504');
            expect(option.querySelector('.fit-candidate-name').textContent).toBe('Never Gonna Give You Up');
            expect(option.querySelector('.fit-candidate-meta').textContent).toBe('Rick Astley · 1987');
            expect([...option.querySelectorAll('.fit-media-badge')].map(b => b.textContent)).toEqual(['vinyl']);
        });

        it('refuses a query shorter than the search route accepts, without a request', async () => {
            await pane.findCandidates('ne');

            expect(window.apiClient.search).not.toHaveBeenCalled();
            expect(document.querySelector('.fit-notice').textContent).toContain('at least 3');
        });

        it('says so when the search finds nothing', async () => {
            window.apiClient.search.mockResolvedValue({ results: [], total: 0 });

            await pane.findCandidates('nothing here');

            expect(document.querySelector('.fit-notice').textContent).toContain('No releases found');
        });

        it('says so when the search fails, and does not leave a stale list', async () => {
            window.apiClient.search.mockRejectedValue(new Error('offline'));

            await pane.findCandidates('never gonna');

            expect(document.querySelectorAll('.fit-candidate').length).toBe(0);
            expect(document.querySelector('.fit-notice').textContent).toContain('Could not search');
        });

        it('enables the action only once a candidate is picked', async () => {
            window.apiClient.search.mockResolvedValue({ results: [RELEASE_HIT], total: 1 });
            await pane.findCandidates('never gonna');
            const runBtn = document.getElementById('fitRunBtn');
            expect(runBtn.disabled).toBe(true);

            document.querySelector('.fit-candidate').click();

            expect(runBtn.disabled).toBe(false);
            expect(document.querySelector('.fit-candidate').getAttribute('aria-selected')).toBe('true');
        });

        it('discards a search response that a newer search has overtaken', async () => {
            let releaseFirst;
            window.apiClient.search
                .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve({ results: [RELEASE_HIT], total: 1 }); }))
                .mockResolvedValueOnce({ results: [], total: 0 });

            const first = pane.findCandidates('never gonna');
            await pane.findCandidates('nothing here');
            releaseFirst();
            await first;

            expect(document.querySelectorAll('.fit-candidate').length).toBe(0);
            expect(document.querySelector('.fit-notice').textContent).toContain('No releases found');
        });
    });

    // ------------------------------------------------------------------ //
    // The profile card
    // ------------------------------------------------------------------ //

    describe('profile card', () => {
        beforeEach(() => {
            pane.renderProfile(document.getElementById('fitBody'), FULL_PROFILE);
        });

        it('renders the release, its media badges and its rarity tier', () => {
            expect(document.querySelector('.fit-card-title').textContent).toBe('Never Gonna Give You Up');
            expect(document.querySelector('.fit-card-meta').textContent).toBe('Rick Astley · 1987');
            expect([...document.querySelectorAll('.fit-card-badges .fit-media-badge')].map(b => b.textContent)).toEqual(['vinyl']);
            expect(document.querySelector('.fit-rarity-badge').textContent).toBe('common');
        });

        it('renders the overall fit as a bar and a percentage', () => {
            const bar = document.querySelector('.fit-overall-bar');
            expect(bar.getAttribute('role')).toBe('meter');
            expect(bar.getAttribute('aria-valuenow')).toBe('62');
            expect(bar.querySelector('.fit-bar-fill').style.width).toBe('62%');
            expect(document.querySelector('.fit-overall-value').textContent).toBe('62%');
        });

        it('renders the five components in the order the decomposition names them', () => {
            const rows = [...document.querySelectorAll('.fit-component')];
            expect(rows.map(r => r.dataset.component)).toEqual(['affinity', 'novelty', 'bridge', 'depth', 'redundancy']);
            expect(rows.map(r => r.querySelector('.fit-component-name').textContent))
                .toEqual(['Affinity', 'Novelty', 'Bridge', 'Depth', 'Redundancy']);
        });

        it('gives each component its own score bar', () => {
            const affinity = document.querySelector('.fit-component[data-component="affinity"]');
            expect(affinity.querySelector('.fit-component-bar').getAttribute('aria-valuenow')).toBe('55');
            expect(affinity.querySelector('.fit-component-bar .fit-bar-fill').style.width).toBe('55%');
            expect(affinity.querySelector('.fit-component-score').textContent).toBe('55%');
        });

        it('lists every evidence line a component carries', () => {
            const bridge = document.querySelector('.fit-component[data-component="bridge"]');
            expect([...bridge.querySelectorAll('.fit-evidence li')].map(li => li.textContent)).toEqual([
                'bridges Electronic and Rock, which share no artist or label in your collection',
                'region boundaries are the v0 genre heuristic, not a computed community',
            ]);
        });

        it('renders the identity confidence as a badge, not as part of the score', () => {
            const badge = document.querySelector('.fit-confidence');
            expect(badge.textContent).toBe('exact release');
            expect(badge.dataset.confidence).toBe('exact');
            expect(badge.classList.contains('fit-confidence-exact')).toBe(true);
        });

        it('names the version that scored it', () => {
            expect(document.querySelector('.fit-version').textContent).toBe('Scored by cratefit_v0');
        });

        it('carries the impression and the native id on the card', () => {
            const card = document.querySelector('.fit-card');
            expect(card.dataset.impressionId).toBe('imp-fit-1');
            expect(card.dataset.gmId).toBe('gm:release:249504');
        });

        it('replaces a prior card rather than stacking a second one', () => {
            pane.renderProfile(document.getElementById('fitBody'), FULL_PROFILE);

            expect(document.querySelectorAll('.fit-card').length).toBe(1);
        });
    });

    describe('sparse profile', () => {
        beforeEach(() => {
            pane.renderProfile(document.getElementById('fitBody'), SPARSE_PROFILE);
        });

        it('still renders all five component rows', () => {
            expect([...document.querySelectorAll('.fit-component')].map(r => r.dataset.component))
                .toEqual(['affinity', 'novelty', 'bridge', 'depth', 'redundancy']);
        });

        it('renders no evidence list for a component that carries none', () => {
            expect(document.querySelectorAll('.fit-evidence').length).toBe(0);
        });

        it('falls back to the release id when the graph carries no title', () => {
            expect(document.querySelector('.fit-card-title').textContent).toBe('999');
            expect(document.querySelector('.fit-card-meta').textContent).toBe('');
        });

        it('renders no rarity badge when the insights tables carry none', () => {
            expect(document.querySelector('.fit-rarity-badge')).toBeNull();
        });

        it('reports a master-only identification', () => {
            const badge = document.querySelector('.fit-confidence');
            expect(badge.textContent).toBe('master only');
            expect(badge.classList.contains('fit-confidence-master')).toBe(true);
        });

        it('renders no outcome controls when the profile carries no impression', () => {
            expect(document.querySelector('.rec-outcome-actions')).toBeNull();
        });
    });

    // ------------------------------------------------------------------ //
    // Loading the profile
    // ------------------------------------------------------------------ //

    describe('loadProfile', () => {
        beforeEach(async () => {
            window.apiClient.search.mockResolvedValue({ results: [RELEASE_HIT], total: 1 });
            pane.init();
            await pane.findCandidates('never gonna');
            document.querySelector('.fit-candidate').click();
        });

        it('asks for the picked release and renders the card', async () => {
            window.apiClient.getFitProfile.mockResolvedValue(FULL_PROFILE);

            await pane.loadProfile();

            expect(window.apiClient.getFitProfile).toHaveBeenCalledWith('valid-token', '249504');
            expect(document.querySelector('.fit-card-title').textContent).toBe('Never Gonna Give You Up');
            expect(document.getElementById('fitLoading').classList.contains('active')).toBe(false);
        });

        it('says so when the route has no profile for the release', async () => {
            window.apiClient.getFitProfile.mockResolvedValue(null);

            await pane.loadProfile();

            expect(document.querySelector('.fit-card')).toBeNull();
            expect(document.querySelector('#fitBody p').textContent).toContain('No fit profile');
        });

        it('does nothing without a session', async () => {
            anonymous();

            await pane.loadProfile();

            expect(window.apiClient.getFitProfile).not.toHaveBeenCalled();
        });
    });

    // ------------------------------------------------------------------ //
    // The landing point
    // ------------------------------------------------------------------ //

    describe('landing point', () => {
        let restoreSnapshot;

        beforeEach(() => {
            restoreSnapshot = vi.fn();
            window.exploreApp = { graph: { restoreSnapshot }, _switchPane: vi.fn() };
        });

        it('centres the snapshot on the candidate release', () => {
            pane.drawLandingPoint(FULL_PROFILE);

            expect(restoreSnapshot).toHaveBeenCalledTimes(1);
            expect(restoreSnapshot.mock.calls[0][1]).toEqual({ id: 'Never Gonna Give You Up', type: 'release' });
        });

        it('draws the entities the evidence names as satellites', () => {
            pane.drawLandingPoint(FULL_PROFILE);

            expect(restoreSnapshot.mock.calls[0][0]).toEqual([
                { id: 'Rick Astley', type: 'artist' },
                { id: 'Stock Aitken Waterman', type: 'label' },
                { id: 'Electronic', type: 'genre' },
                { id: 'Rock', type: 'genre' },
            ]);
        });

        it('falls back to the release id as the centre when there is no title', () => {
            pane.drawLandingPoint(SPARSE_PROFILE);

            expect(restoreSnapshot.mock.calls[0][1]).toEqual({ id: '999', type: 'release' });
            expect(restoreSnapshot.mock.calls[0][0]).toEqual([]);
        });

        it('is drawn as soon as the profile loads', async () => {
            window.apiClient.search.mockResolvedValue({ results: [RELEASE_HIT], total: 1 });
            window.apiClient.getFitProfile.mockResolvedValue(FULL_PROFILE);
            pane.init();
            await pane.findCandidates('never gonna');
            document.querySelector('.fit-candidate').click();

            await pane.loadProfile();

            expect(restoreSnapshot).toHaveBeenCalledTimes(1);
        });

        it('switches to the graph view from the card control', () => {
            pane.renderProfile(document.getElementById('fitBody'), FULL_PROFILE);

            document.getElementById('fitLandingBtn').click();

            expect(restoreSnapshot).toHaveBeenCalled();
            expect(window.exploreApp._switchPane).toHaveBeenCalledWith('explore');
        });

        it('does nothing when there is no graph to draw into', () => {
            delete window.exploreApp;

            expect(() => pane.drawLandingPoint(FULL_PROFILE)).not.toThrow();
        });

        describe('evidenceEntities', () => {
            const entities = (component, evidence) => window.FitPane.evidenceEntities({ components: { [component]: { evidence } } });

            it('reads the shared facet out of an affinity line', () => {
                expect(entities('affinity', ['shares label Warp Records with 4 releases you hold']))
                    .toEqual([{ id: 'Warp Records', type: 'label' }]);
            });

            it('reads the new facet out of a novelty line', () => {
                expect(entities('novelty', ['Autechre is an artist your collection has never held']))
                    .toEqual([{ id: 'Autechre', type: 'artist' }]);
            });

            it('reads the deepened facet out of a depth line', () => {
                expect(entities('depth', ['deepens style Ambient (3 held)']))
                    .toEqual([{ id: 'Ambient', type: 'style' }]);
            });

            it('reads every region out of a bridge line', () => {
                expect(entities('bridge', ['bridges Jazz, Rock and Soul, which share no artist or label in your collection']))
                    .toEqual([{ id: 'Jazz', type: 'genre' }, { id: 'Rock', type: 'genre' }, { id: 'Soul', type: 'genre' }]);
            });

            it('reads the held release out of a same-master redundancy line', () => {
                expect(entities('redundancy', ['you hold Kid A, the same record on optical']))
                    .toEqual([{ id: 'Kid A', type: 'release' }]);
            });

            it('reads the held release and its artist out of a same-title redundancy line', () => {
                expect(entities('redundancy', ['you hold Kid A by Radiohead, which no master links to this pressing']))
                    .toEqual([{ id: 'Kid A', type: 'release' }, { id: 'Radiohead', type: 'artist' }]);
            });

            it('contributes nothing for a line it does not recognise', () => {
                expect(entities('bridge', ['region boundaries are the v0 genre heuristic, not a computed community']))
                    .toEqual([]);
            });

            it('names an entity once however many components cite it', () => {
                expect(window.FitPane.evidenceEntities({
                    components: {
                        affinity: { evidence: ['shares artist Radiohead with 2 releases you hold'] },
                        depth: { evidence: ['deepens artist Radiohead (2 held)'] },
                    },
                })).toEqual([{ id: 'Radiohead', type: 'artist' }]);
            });
        });
    });

    // ------------------------------------------------------------------ //
    // Outcomes
    // ------------------------------------------------------------------ //

    describe('outcome controls', () => {
        beforeEach(() => {
            pane.renderProfile(document.getElementById('fitBody'), FULL_PROFILE);
        });

        it('renders Save, Dismiss and Hide', () => {
            expect([...document.querySelectorAll('.rec-outcome-btn')].map(b => b.dataset.outcome))
                .toEqual(['save', 'dismiss', 'hide']);
        });

        it('reports a save against the profile impression and the native id', () => {
            document.querySelector('[data-outcome="save"]').click();

            expect(window.apiClient.postActivityEvent)
                .toHaveBeenCalledWith('valid-token', 'recommendation.saved', 'imp-fit-1', 'gm:release:249504');
        });

        it('records a save once, because the vocabulary has no un-save term', () => {
            const save = document.querySelector('[data-outcome="save"]');
            save.click();
            save.click();

            expect(window.apiClient.postActivityEvent).toHaveBeenCalledTimes(1);
            expect(save.getAttribute('aria-pressed')).toBe('true');
        });

        it('reports a dismiss and collapses the card', () => {
            vi.useFakeTimers();
            document.querySelector('[data-outcome="dismiss"]').click();

            expect(window.apiClient.postActivityEvent)
                .toHaveBeenCalledWith('valid-token', 'recommendation.dismissed', 'imp-fit-1', 'gm:release:249504');
            expect(document.querySelector('.fit-card').classList.contains('rec-outcome-collapsing')).toBe(true);
            vi.advanceTimersByTime(window.FitPane.COLLAPSE_MS);
            expect(document.querySelector('.fit-card')).toBeNull();
            vi.useRealTimers();
        });

        it('reports a hide and collapses the card', () => {
            vi.useFakeTimers();
            document.querySelector('[data-outcome="hide"]').click();

            expect(window.apiClient.postActivityEvent)
                .toHaveBeenCalledWith('valid-token', 'recommendation.hidden', 'imp-fit-1', 'gm:release:249504');
            vi.advanceTimersByTime(window.FitPane.COLLAPSE_MS);
            expect(document.querySelector('.fit-card')).toBeNull();
            vi.useRealTimers();
        });

        it('never lets a failing post reach the collector who pressed the button', () => {
            window.apiClient.postActivityEvent = vi.fn().mockRejectedValue(new Error('gone'));

            expect(() => document.querySelector('[data-outcome="save"]').click()).not.toThrow();
        });

        it('records nothing for an anonymous session', () => {
            anonymous();

            pane.emitOutcome('recommendation.saved', FULL_PROFILE);

            expect(window.apiClient.postActivityEvent).not.toHaveBeenCalled();
        });

        it('records nothing for a profile the API issued no impression for', () => {
            pane.emitOutcome('recommendation.saved', SPARSE_PROFILE);

            expect(window.apiClient.postActivityEvent).not.toHaveBeenCalled();
        });
    });
});
