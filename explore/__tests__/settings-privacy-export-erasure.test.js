/**
 * Tests for the Privacy, Export, and Delete Account settings cards in settings.js.
 *
 * Mirrors settings-app-tokens.test.js: a bare DOM carrying only the ids
 * settings.js touches during init(), a fully stubbed apiClient, and a
 * microtask flush after each init() because the card loaders are async.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadScript } from './helpers.js';

globalThis.QRCode = vi.fn();
QRCode.CorrectLevel = { M: 1 };

const CONSENT_RESPONSE = {
    purposes: [
        { purpose: 'product_analytics', granted: true, granted_at: '2026-05-01T00:00:00Z', revoked_at: null },
        { purpose: 'model_training', granted: false, granted_at: null, revoked_at: null },
    ],
};

function setupDOM() {
    document.body.textContent = '';
    for (const id of [
        'settingsEmail', 'settingsCreatedAt', 'settingsDiscogsStatus',
        'settingsCurrentPassword', 'settingsNewPassword', 'settingsConfirmPassword',
        'passwordChangeError', 'passwordChangeSuccess', 'changePasswordBtn',
        'twoFactorContent', 'appTokensContent',
    ]) {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
    }
    const containers = {};
    for (const id of ['privacyContent', 'exportContent', 'deleteAccountContent']) {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
        containers[id] = el;
    }
    // The receipt region lives outside the settings pane in index.html, which
    // is the whole point of it: the session clear hides the pane.
    const banner = document.createElement('div');
    banner.id = 'erasureReceiptBanner';
    banner.hidden = true;
    document.body.appendChild(banner);
    containers.erasureReceiptBanner = banner;
    return containers;
}

function setupMocks(opts = {}) {
    window.authManager = {
        getUser: vi.fn().mockReturnValue({ id: 1, email: 'u@test.com', totp_enabled: Boolean(opts.totpEnabled) }),
        getDiscogsStatus: vi.fn().mockReturnValue(null),
        getToken: vi.fn().mockReturnValue(opts.signedOut ? null : 'test-token'),
        updateTotpEnabled: vi.fn(),
        clear: vi.fn(),
        notify: vi.fn(),
    };
    window.apiClient = {
        // Stubs for the parts of init() these cards don't exercise.
        changePassword: vi.fn().mockResolvedValue({ ok: true }),
        twoFactorSetup: vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
        twoFactorConfirm: vi.fn(),
        twoFactorDisable: vi.fn(),
        listAppTokens: vi.fn().mockResolvedValue({ active: [], revoked: [] }),
        // The surface under test.
        getConsent: vi.fn().mockResolvedValue(CONSENT_RESPONSE),
        setConsent: vi.fn().mockResolvedValue({ purpose: 'product_analytics', granted: false, changed: true }),
        requestExport: vi.fn().mockResolvedValue(new Blob(['{"kind":"user"}\n'])),
        requestErasure: vi.fn().mockResolvedValue({
            ok: true,
            status: 202,
            body: { erasure_id: 'era-42', events_deleted: 3, impressions_deleted: 2, incomplete: [] },
        }),
    };
}

async function flush() {
    await new Promise(resolve => setTimeout(resolve, 0));
}

function toggleFor(purpose) {
    return document.querySelector(`[data-consent-toggle="${purpose}"]`);
}

function fillTotp(code) {
    const inputs = document.querySelectorAll('[data-erasure-totp]');
    inputs.forEach((input, idx) => { input.value = code[idx] ?? ''; });
}

async function openConfirm() {
    document.getElementById('deleteAccountBtn').click();
    await flush();
}

describe('SettingsPane — Privacy card', () => {
    let privacy;

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        privacy = setupDOM().privacyContent;
        setupMocks();
        loadScript('settings-state.js');
        loadScript('settings.js');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('loads consent with the bearer token and renders both purposes', async () => {
        window.settingsPane.init();
        await flush();

        expect(window.apiClient.getConsent).toHaveBeenCalledWith('test-token');
        expect(privacy.textContent).toContain('Product analytics');
        expect(privacy.textContent).toContain('Model training');
        expect(toggleFor('product_analytics').checked).toBe(true);
        expect(toggleFor('model_training').checked).toBe(false);
    });

    it('renders a purpose the server has never recorded as not granted', async () => {
        window.apiClient.getConsent.mockResolvedValue({
            purposes: [{ purpose: 'product_analytics', granted: true, granted_at: null, revoked_at: null }],
        });
        window.settingsPane.init();
        await flush();

        expect(toggleFor('model_training')).toBeTruthy();
        expect(toggleFor('model_training').checked).toBe(false);
    });

    it('calls setConsent with the purpose and the new granted value', async () => {
        window.settingsPane.init();
        await flush();

        const toggle = toggleFor('model_training');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await flush();

        expect(window.apiClient.setConsent).toHaveBeenCalledWith('test-token', 'model_training', true);
    });

    it('disables both toggles while a consent request is in flight', async () => {
        window.settingsPane.init();
        await flush();

        let resolveSet;
        window.apiClient.setConsent.mockReturnValue(new Promise(resolve => { resolveSet = resolve; }));

        const toggle = toggleFor('model_training');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(toggleFor('model_training').disabled).toBe(true);
        expect(toggleFor('product_analytics').disabled).toBe(true);

        resolveSet({ purpose: 'model_training', granted: true, changed: true });
        await flush();

        expect(toggleFor('model_training').disabled).toBe(false);
        expect(toggleFor('model_training').checked).toBe(true);
    });

    it('reflects the server answer rather than the click', async () => {
        window.settingsPane.init();
        await flush();

        // The server refuses the grant and reports the purpose still revoked.
        window.apiClient.setConsent.mockResolvedValue({ purpose: 'model_training', granted: false, changed: false });

        const toggle = toggleFor('model_training');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await flush();

        expect(toggleFor('model_training').checked).toBe(false);
    });

    it('shows an error when the consent write fails', async () => {
        window.settingsPane.init();
        await flush();

        window.apiClient.setConsent.mockResolvedValue(null);

        const toggle = toggleFor('product_analytics');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await flush();

        expect(document.getElementById('consentError').textContent).toContain('Could not save that choice');
    });

    it('shows an error when consent cannot be loaded', async () => {
        window.apiClient.getConsent.mockResolvedValue(null);
        window.settingsPane.init();
        await flush();

        expect(document.getElementById('consentError').textContent).toContain('Could not load your privacy choices');
    });

    it('prompts to sign in and makes no request when signed out', async () => {
        setupMocks({ signedOut: true });
        window.settingsPane.init();
        await flush();

        expect(window.apiClient.getConsent).not.toHaveBeenCalled();
        expect(privacy.textContent).toContain('Sign in to manage your privacy choices');
    });
});

describe('SettingsPane — Export card', () => {
    let exportContainer;
    let anchor;
    let clickSpy;

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        exportContainer = setupDOM().exportContent;
        setupMocks();
        loadScript('settings-state.js');
        loadScript('settings.js');

        window.URL.createObjectURL = vi.fn().mockReturnValue('blob:groovemap-export');
        window.URL.revokeObjectURL = vi.fn();

        // Capture the anchor _downloadBlob builds and neuter its click, which
        // jsdom would otherwise treat as an unimplemented navigation.
        anchor = null;
        clickSpy = vi.fn();
        const realCreateElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => {
            const el = realCreateElement(tag, ...rest);
            if (String(tag).toLowerCase() === 'a') {
                anchor = el;
                el.click = clickSpy;
            }
            return el;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        delete window.URL.createObjectURL;
        delete window.URL.revokeObjectURL;
    });

    it('renders a download button for a signed-in collector', async () => {
        window.settingsPane.init();
        await flush();

        expect(exportContainer.querySelector('#exportDataBtn')).toBeTruthy();
        expect(exportContainer.textContent).toContain('Download my data');
    });

    it('downloads the NDJSON body as groovemap-export.ndjson', async () => {
        window.settingsPane.init();
        await flush();

        document.getElementById('exportDataBtn').click();
        await flush();

        expect(window.apiClient.requestExport).toHaveBeenCalledWith('test-token');
        expect(window.URL.createObjectURL).toHaveBeenCalledTimes(1);
        expect(anchor.download).toBe('groovemap-export.ndjson');
        expect(anchor.getAttribute('href')).toBe('blob:groovemap-export');
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:groovemap-export');
        expect(document.getElementById('exportNote').textContent).toContain('downloaded');
    });

    it('disables the button while the export is in flight', async () => {
        window.settingsPane.init();
        await flush();

        let resolveExport;
        window.apiClient.requestExport.mockReturnValue(new Promise(resolve => { resolveExport = resolve; }));

        document.getElementById('exportDataBtn').click();

        expect(document.getElementById('exportDataBtn').disabled).toBe(true);
        expect(exportContainer.textContent).toContain('Preparing');

        resolveExport(new Blob(['{}\n']));
        await flush();

        expect(document.getElementById('exportDataBtn').disabled).toBe(false);
    });

    it('shows an error and starts no download when the export fails', async () => {
        window.apiClient.requestExport.mockResolvedValue(null);
        window.settingsPane.init();
        await flush();

        document.getElementById('exportDataBtn').click();
        await flush();

        expect(document.getElementById('exportError').textContent).toContain('Export failed');
        expect(clickSpy).not.toHaveBeenCalled();
    });

    it('prompts to sign in when signed out', async () => {
        setupMocks({ signedOut: true });
        window.settingsPane.init();
        await flush();

        expect(exportContainer.textContent).toContain('Sign in to export your data');
        expect(exportContainer.querySelector('#exportDataBtn')).toBeNull();
    });
});

describe('SettingsPane — Delete account card', () => {
    let deleteContainer;
    let receiptBanner;

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const containers = setupDOM();
        deleteContainer = containers.deleteAccountContent;
        receiptBanner = containers.erasureReceiptBanner;
        setupMocks();
        loadScript('settings-state.js');
        loadScript('settings.js');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('renders a destructive button that explains the consequence', async () => {
        window.settingsPane.init();
        await flush();

        const btn = deleteContainer.querySelector('#deleteAccountBtn');
        expect(btn).toBeTruthy();
        expect(btn.className).toContain('btn-danger');
        expect(deleteContainer.textContent).toContain('cannot be undone');
    });

    it('opens a confirm panel asking only for the password when 2FA is off', async () => {
        window.settingsPane.init();
        await flush();
        await openConfirm();

        expect(document.getElementById('erasurePassword')).toBeTruthy();
        expect(document.querySelectorAll('[data-erasure-totp]').length).toBe(0);
        expect(document.getElementById('erasureConfirmBtn')).toBeTruthy();
    });

    it('asks for a TOTP code as well when the profile reports 2FA enabled', async () => {
        setupMocks({ totpEnabled: true });
        window.settingsPane.init();
        await flush();
        await openConfirm();

        expect(document.querySelectorAll('[data-erasure-totp]').length).toBe(6);
        expect(deleteContainer.textContent).toContain('Authenticator Code');
    });

    it('cancelling returns to the idle view', async () => {
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasureCancelBtn').click();

        expect(document.getElementById('erasurePassword')).toBeNull();
        expect(deleteContainer.querySelector('#deleteAccountBtn')).toBeTruthy();
    });

    it('requires a password before calling the API', async () => {
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(window.apiClient.requestErasure).not.toHaveBeenCalled();
        expect(document.getElementById('erasureError').textContent).toContain('Password is required');
    });

    it('requires a six-digit code when 2FA is enabled', async () => {
        setupMocks({ totpEnabled: true });
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasurePassword').value = 'hunter2hunter2';
        fillTotp('123');
        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(window.apiClient.requestErasure).not.toHaveBeenCalled();
        expect(document.getElementById('erasureError').textContent).toContain('6-digit code');
    });

    it('erases, shows the erasure id, clears the session, and signs out', async () => {
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasurePassword').value = 'hunter2hunter2';
        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(window.apiClient.requestErasure).toHaveBeenCalledWith('test-token', 'hunter2hunter2', null);
        expect(document.getElementById('erasureId').textContent).toBe('era-42');
        expect(deleteContainer.textContent).toContain('Your account has been deleted');
        expect(window.settingsPane._deleteView).toBe('done');
        expect(window.authManager.clear).toHaveBeenCalledTimes(1);
        expect(window.authManager.notify).toHaveBeenCalledTimes(1);
    });

    it('sends the TOTP code with the erasure when 2FA is enabled', async () => {
        setupMocks({ totpEnabled: true });
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasurePassword').value = 'hunter2hunter2';
        fillTotp('123456');
        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(window.apiClient.requestErasure).toHaveBeenCalledWith('test-token', 'hunter2hunter2', '123456');
    });

    it('reports the stores that did not finish alongside the erasure id', async () => {
        window.apiClient.requestErasure.mockResolvedValue({
            ok: true,
            status: 202,
            body: {
                erasure_id: 'era-43',
                events_deleted: 1,
                impressions_deleted: 0,
                incomplete: ['Neo4j deletion failed: ServiceUnavailable'],
            },
        });
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasurePassword').value = 'hunter2hunter2';
        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(document.getElementById('erasureId').textContent).toBe('era-43');
        const notice = document.getElementById('erasureIncomplete');
        expect(notice).toBeTruthy();
        expect(notice.textContent).toContain('Neo4j deletion failed: ServiceUnavailable');
        expect(notice.textContent).toContain('contact support');
    });

    it('keeps the confirm panel open and shows the detail on a rejected password', async () => {
        // requestErasure declares itself a credential re-check to ApiTransport (see
        // api-transport.test.js / api-client.test.js for that layer); from settings.js's
        // own perspective this is just a rejected envelope that must not touch auth state
        // or move the card's _deleteView state off 'confirm' (gm-graph-explorer-8ww.2).
        window.apiClient.requestErasure.mockResolvedValue({
            ok: false,
            status: 401,
            body: { detail: 'Incorrect password' },
        });
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasurePassword').value = 'wrong-password';
        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(document.getElementById('erasureError').textContent).toBe('Incorrect password');
        expect(document.getElementById('erasurePassword')).toBeTruthy();
        expect(document.getElementById('erasureConfirmBtn').disabled).toBe(false);
        expect(window.settingsPane._deleteView).toBe('confirm');
        expect(window.authManager.notify).not.toHaveBeenCalled();
        expect(window.authManager.clear).not.toHaveBeenCalled();
    });

    it('keeps the confirm panel open on a 403 and re-enables the buttons', async () => {
        window.apiClient.requestErasure.mockResolvedValue({ ok: false, status: 403, body: null });
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasurePassword').value = 'hunter2hunter2';
        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(document.getElementById('erasureError').textContent).toContain('Could not delete your account');
        expect(document.getElementById('erasureCancelBtn').disabled).toBe(false);
        expect(window.authManager.notify).not.toHaveBeenCalled();
    });

    it('surfaces a network rejection instead of letting it escape', async () => {
        window.apiClient.requestErasure.mockRejectedValue(new Error('offline'));
        window.settingsPane.init();
        await flush();
        await openConfirm();

        document.getElementById('erasurePassword').value = 'hunter2hunter2';
        document.getElementById('erasureConfirmBtn').click();
        await flush();

        expect(document.getElementById('erasureError').textContent).toContain('Could not delete your account');
        expect(window.authManager.clear).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------ //
    // Receipt on the signed-out view
    //
    // The settings card renders a receipt the user never sees: clearing the
    // session switches the browser off Settings before the paint the card was
    // written for. These cover the copy that outlives that switch.
    // ------------------------------------------------------------------ //

    async function erase() {
        window.settingsPane.init();
        await flush();
        await openConfirm();
        document.getElementById('erasurePassword').value = 'hunter2hunter2';
        document.getElementById('erasureConfirmBtn').click();
        await flush();
    }

    it('renders the receipt outside the settings pane after the session clear', async () => {
        await erase();

        expect(receiptBanner.hidden).toBe(false);
        expect(receiptBanner.contains(deleteContainer)).toBe(false);
        expect(receiptBanner.querySelector('#erasureId').textContent).toBe('era-42');
        expect(receiptBanner.textContent).toContain('Your account has been deleted');
    });

    it('carries the partial-failure notice onto the signed-out view', async () => {
        window.apiClient.requestErasure.mockResolvedValue({
            ok: true,
            status: 202,
            body: {
                erasure_id: 'era-44',
                events_deleted: 1,
                impressions_deleted: 0,
                incomplete: ['Redis deletion failed: ConnectionError'],
            },
        });
        await erase();

        expect(receiptBanner.querySelector('#erasureId').textContent).toBe('era-44');
        const notice = receiptBanner.querySelector('#erasureIncomplete');
        expect(notice).toBeTruthy();
        expect(notice.textContent).toContain('Redis deletion failed: ConnectionError');
    });

    it('keeps the receipt out of localStorage', async () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        await erase();

        const written = setItem.mock.calls.map(([, value]) => String(value)).join('\n');
        expect(written).not.toContain('era-42');
    });

    it('dismissing the receipt removes it and nothing brings it back', async () => {
        await erase();

        receiptBanner.querySelector('#erasureReceiptDismissBtn').click();

        expect(receiptBanner.hidden).toBe(true);
        expect(receiptBanner.textContent).toBe('');

        // A later render finds nothing held: the notice is one-time.
        window.settingsPane._renderErasureReceiptBanner();
        expect(receiptBanner.hidden).toBe(true);
        expect(receiptBanner.querySelector('#erasureId')).toBeNull();
    });

    it('renders no receipt when the erasure never succeeded', async () => {
        window.apiClient.requestErasure.mockResolvedValue({ ok: false, status: 403, body: null });
        await erase();

        expect(receiptBanner.hidden).toBe(true);
        expect(receiptBanner.textContent).toBe('');
    });
});
