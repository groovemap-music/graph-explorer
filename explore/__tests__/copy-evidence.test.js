import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadScript, loadScriptDirect } from './helpers.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const ok = observations => ({ ok: true, body: { observations } });
const observation = value => ({ kind: 'note', value, source: 'user', confidence: 0.7, observed_at: '2020-observed', created_at: '2021-recorded' });
describe('selected physical copy evidence', () => {
    let api, auth, component, container, onStatus;
    beforeAll(() => { delete globalThis.window; globalThis.window = globalThis; loadScript('copy-evidence.js'); loadScript('user-pane-state.js'); loadScriptDirect('user-panes.js'); });
    beforeEach(() => {
        document.body.innerHTML = '<section id="detail"></section>';
        container = document.getElementById('detail');
        auth = { getToken: vi.fn(() => 'A') };
        api = { getOwnedCopies: vi.fn(async () => ({ ok: true, body: { copies: [{ id: 'a' }, { id: 'b' }], truncated: false } })), getCopyObservations: vi.fn(async (_token, copy) => ok([observation(`${copy} history`)])), createObservation: vi.fn(async () => ({ ok: true })) };
        onStatus = vi.fn();
        component = new CopyEvidence({ container, api, auth, onStatus });
    });
    it('requires a choice for duplicate copies and reads/posts only the selected second copy', async () => {
        await component.loadItem('native-uuid');
        expect(api.getOwnedCopies).toHaveBeenCalledWith('A', 'native-uuid');
        expect(component.selectedCopyId).toBeNull(); expect(api.getCopyObservations).not.toHaveBeenCalled();
        await component.selectCopy('b');
        expect(container.textContent).toContain('Selected physical copy: b');
        expect(container.textContent).toContain('b history'); expect(container.textContent).not.toContain('a history');
        expect(container.textContent).toContain('Source: user · Confidence: 0.7');
        expect(container.textContent).toContain('Observed at: 2020-observed · Recorded at: 2021-recorded');
        await component.record({ kind: 'note', value: '  second evidence  ' });
        expect(api.createObservation).toHaveBeenCalledWith('A', 'b', { kind: 'note', value: 'second evidence', source: 'user' });
        await component.selectCopy('a'); expect(container.textContent).toContain('a history'); expect(container.textContent).not.toContain('b history');
    });
    it('only preselects a clearly identified single copy when completeness is known', async () => {
        component.showCopies([{ id: 'a' }]); expect(component.selectedCopyId).toBeNull();
        component.showCopies([{ id: 'a' }], { complete: true }); expect(component.selectedCopyId).toBe('a'); expect(container.textContent).toContain('Selected physical copy: a');
        component.showCopies([{ id: 'a' }], { complete: true, truncated: true }); expect(component.selectedCopyId).toBeNull(); expect(container.textContent).toContain('truncated');
    });
    it('handles unknown, empty, capped and unavailable copy lists honestly', async () => {
        component.showCopies(null); expect(container.textContent).toContain('unavailable');
        component.showCopies([]); expect(container.textContent).toContain('No physical copies in this read');
        component.showCopies([{ id: 'a' }]); expect(container.textContent).toContain('completeness is unknown');
        component.showCopies(Array.from({ length: 51 }, (_, i) => ({ id: String(i) }))); expect(component.copies).toHaveLength(50); expect(container.textContent).toContain('truncated');
        api.getOwnedCopies.mockResolvedValue({ ok: false, status: 404 }); await component.loadItem('unknown'); expect(container.textContent).toBe('Physical copies unavailable.');
        api.getOwnedCopies.mockRejectedValue(Error('offline')); await component.loadItem('unknown'); expect(container.textContent).toBe('Physical copies unavailable.');
    });
    it.each([false,true])('ignores late GET success/error after copy selection changes (%s)', async error => {
        component.showCopies([{ id: 'a' }, { id: 'b' }]); const old = deferred(); api.getCopyObservations.mockReturnValueOnce(old.promise);
        const first = component.selectCopy('a'); await component.selectCopy('b');
        if (error) old.reject(Error('offline')); else old.resolve(ok([observation('private A')]));
        await first; expect(container.textContent).toContain('b history'); expect(container.textContent).not.toContain('private A'); expect(container.textContent).not.toContain('unavailable');
    });
    it.each([false,true])('ignores late POST success/error after account/reset (%s)', async error => {
        component.showCopies([{ id: 'a' }]); await component.selectCopy('a'); const old = deferred(); api.createObservation.mockReturnValueOnce(old.promise);
        const posted = component.record({ kind: 'note', value: 'private' }); component.destroy(); auth.getToken.mockReturnValue('B');
        if (error) old.reject(Error('offline')); else old.resolve({ ok: true });
        expect(await posted).toBe(false); expect(container.textContent).toBe(''); expect(onStatus).not.toHaveBeenCalled();
    });
    it.each([false,true])('ignores a late POST success/error after selecting another copy (%s)', async error => {
        component.showCopies([{ id: 'a' }, { id: 'b' }]); await component.selectCopy('a');
        const old = deferred(); api.createObservation.mockReturnValueOnce(old.promise);
        const posted = component.record({ kind: 'note', value: 'old copy' }); await component.selectCopy('b');
        if (error) old.reject(Error('offline')); else old.resolve({ ok: true });
        expect(await posted).toBe(false); expect(container.textContent).toContain('b history'); expect(onStatus).not.toHaveBeenCalled();
    });
    it.each([false,true])('ignores late copy-list success/error after destroy (%s)', async error => {
        const old = deferred(); api.getOwnedCopies.mockReturnValueOnce(old.promise); const pending = component.loadItem('item'); component.destroy();
        if (error) old.reject(Error('offline')); else old.resolve({ ok: true, body: { copies: [{ id:'private' }], truncated:false } });
        await pending; expect(container.textContent).toBe('');
    });
    it('keeps unknown/foreign timeline failures indistinguishable and renders empty history', async () => {
        component.showCopies([{ id:'a' }]);
        for (const status of [404,503]) { api.getCopyObservations.mockResolvedValueOnce({ ok:false, status, body:{ detail:'foreign secret' } }); await component.selectCopy('a'); expect(component.timeline.textContent).toBe('Observations unavailable.'); }
        api.getCopyObservations.mockResolvedValueOnce(ok([])); await component.selectCopy('a'); expect(container.textContent).toContain('No observations recorded');
    });
    it('preserves the historical write lock while reading the all-history timeline', async () => {
        component.readOnly = true; component.showCopies([{ id:'a' }]); await component.selectCopy('a');
        expect(container.textContent).toContain('all recorded history'); expect(component.openForm()).toBeNull(); expect(await component.record({kind:'note',value:'x'})).toBe(false); expect(api.createObservation).not.toHaveBeenCalled();
    });
    it('uses accessible controls and text nodes, and discards an obsolete open form', async () => {
        component.showCopies([{ id:'a' }, {id:'b'}]); await component.selectCopy('a');
        const form = component.openForm(); expect(form.getAttribute('aria-label')).toBe('Record an observation about your copy');
        form.querySelector('input').value = '<img src=x onerror=alert(1)>';
        form.dispatchEvent(new Event('submit', { cancelable:true })); await vi.waitFor(() => expect(api.createObservation).toHaveBeenCalled());
        await component.selectCopy('b'); form.dispatchEvent(new Event('submit', {cancelable:true})); expect(api.createObservation).toHaveBeenCalledTimes(1); expect(container.querySelector('img')).toBeNull();
    });
    it('Collection integration uses gm_item_id and account reset clears evidence while B can still load', async () => {
        window.apiClient=api; window.authManager=auth; const panes = new UserPanes();
        await panes._openCollectionCopies({ gm_item_id:'native-item', owned_copy_id:'old-shortcut', title:'Release' }, container);
        expect(api.getOwnedCopies).toHaveBeenCalledWith('A','native-item');
        await panes._copyEvidence.selectCopy('b'); expect(container.textContent).toContain('b history'); panes.resetForAccountChange();
        expect(container.textContent).not.toContain('b history'); auth.getToken.mockReturnValue('B');
        await panes._openCollectionCopies({gm_item_id:'native-B'},container); await panes._copyEvidence.selectCopy('b'); expect(api.getCopyObservations).toHaveBeenLastCalledWith('B','b');
        await panes._openCollectionCopies({ owned_copy_id:'never-use'},container); expect(container.textContent).toContain('Native item identity is unknown');
    });
});
