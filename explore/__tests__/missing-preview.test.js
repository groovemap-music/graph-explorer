import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadScript, loadScriptDirect } from './helpers.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(complete = false) {
    return { preview: { catalog_snapshot_id: '<catalog>', collection_snapshot_id: 'owner-window', denominator_evidence: { denominator: 4, owned: 1, missing: complete ? 3 : 1, ownership_review: complete ? 0 : 2, needs_review: complete ? 0 : 3, excluded: 2, unknown_excluded: 0, denominator_complete: complete, ownership_complete: complete, completion_fraction: 0.25 } }, sources: Object.fromEntries(['catalog', 'aliases', 'ownership'].map(name => [name, { status: 'observed', truncated: false, version: complete ? 'synthetic-test-only' : null, started_at: 'start', finished_at: 'end' }])), scope_basis: 'bounded projection', consistency: 'independent windows', co_release_policy: 'needs_review' };
}
describe('transient Missing preview', () => {
    let panes;
    beforeAll(() => { delete globalThis.window; globalThis.window = globalThis; loadScript('user-pane-state.js'); loadScriptDirect('user-panes.js'); });
    beforeEach(() => {
        document.body.innerHTML = '<div id="gapsPane"><div id="gapsBody"></div></div>';
        window.authManager = { getToken: vi.fn(() => 'A') };
        window.apiClient = { previewMissing: vi.fn(async () => ({ ok: true, body: fixture() })) };
        panes = new UserPanes();
    });
    it('renders bounded counts, review buckets and escaped independent source provenance without a percent', async () => {
        await panes._loadMissingPreview('artist', '9', 'A');
        expect(window.apiClient.previewMissing).toHaveBeenCalledWith('A', 'artist', '9');
        const view = document.getElementById('missingPreview');
        expect(view.textContent).toContain('Known eligible native editions: 4');
        expect(view.textContent).toContain('Ownership review: 2');
        expect(view.textContent).toContain('Needs review: 3');
        expect(view.textContent).toContain('version: unknown');
        expect(view.textContent).toContain('<catalog>');
        expect(view.querySelector('catalog')).toBeNull();
        expect(view.textContent).not.toContain('%');
        expect(view.getAttribute('aria-live')).toBe('polite');
    });
    it('allows a percent only for a synthetic complete scope with complete sources', () => {
        const view = document.getElementById('gapsBody');
        panes._renderMissingPreview(view, fixture(true), 'label', '5');
        expect(view.textContent).toContain('Completion: 25%');
        for (const mutate of [data => data.sources.ownership.status = 'unavailable', data => data.sources.catalog.truncated = true, data => data.sources.aliases.version = null, data => data.preview.denominator_evidence.ownership_complete = false, data => data.preview.denominator_evidence.ownership_review = 1, data => data.preview.denominator_evidence.needs_review = 1, data => data.preview.denominator_evidence.unknown_excluded = 1, data => data.preview.denominator_evidence.completion_fraction = 1.5]) {
            const data = fixture(true); mutate(data); panes._renderMissingPreview(view, data, 'label', '5'); expect(view.textContent).not.toContain('%');
        }
    });
    it('explains empty and unknown evidence without turning it into completion', () => {
        const data = fixture(); data.preview.denominator_evidence = { denominator: 0 }; data.sources = {};
        panes._renderMissingPreview(document.getElementById('gapsBody'), data, 'artist', '9');
        expect(document.body.textContent).toContain('No eligible editions observed');
        expect(document.body.textContent).toContain('Owned: unknown');
    });
    it.each([[403, 'access denied'], [503, 'sources are unavailable'], [500, 'could not be loaded']])('handles HTTP %s', async (status, text) => {
        window.apiClient.previewMissing.mockResolvedValue({ ok: false, status });
        await panes._loadMissingPreview('label', '9', 'A'); expect(document.body.textContent).toContain(text);
    });
    it('does not call unsupported master preview', async () => {
        await panes._loadMissingPreview('master', '9', 'A'); expect(window.apiClient.previewMissing).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('unavailable for this target');
    });
    it.each([false, true])('ignores a late scope success/error (%s)', async error => {
        const old = deferred(); window.apiClient.previewMissing.mockReturnValueOnce(old.promise);
        const first = panes._loadMissingPreview('artist', 'old', 'A');
        expect(document.body.textContent).toContain('Loading');
        await panes._loadMissingPreview('label', 'new', 'A');
        if (error) old.reject(Error('offline')); else old.resolve({ ok: true, body: fixture(true) });
        await first; expect(document.body.textContent).toContain('Discogs label new'); expect(document.body.textContent).not.toContain('25%');
    });
    it.each([false, true])('clears account A and still loads account B after stale success/error (%s)', async error => {
        const old = deferred(); window.apiClient.previewMissing.mockReturnValueOnce(old.promise);
        const first = panes._loadMissingPreview('artist', 'private-A', 'A');
        panes.resetForAccountChange(); window.authManager.getToken.mockReturnValue('B');
        await panes._loadMissingPreview('artist', 'B-target', 'B');
        if (error) old.reject(Error('offline')); else old.resolve({ ok: true, body: fixture(true) });
        await first; expect(document.body.textContent).toContain('B-target'); expect(document.body.textContent).not.toContain('private-A'); expect(document.body.textContent).not.toContain('25%');
    });
});
