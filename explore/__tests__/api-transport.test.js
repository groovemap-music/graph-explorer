import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadScript } from './helpers.js';

describe('ApiTransport', () => {
    beforeEach(() => {
        delete globalThis.window;
        globalThis.window = globalThis;
        loadScript('api-transport.js');
    });

    it('resolves the fetch implementation at request time', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const transport = new window.ApiTransport();

        await transport.fetch('/api/health');

        expect(fetchMock).toHaveBeenCalledWith('/api/health', undefined);
    });

    it('owns and cancels active request sessions', () => {
        const transport = new window.ApiTransport();
        const session = transport.openSession();

        transport.cancelSession(session);

        expect(session.signal.aborted).toBe(true);
        expect(transport._sessions.size).toBe(0);
    });

    it('reconciles authenticated state on unauthorized responses', () => {
        window.authManager = {
            isLoggedIn: vi.fn().mockReturnValue(true),
            clear: vi.fn(),
            notify: vi.fn(),
        };
        const transport = new window.ApiTransport();

        transport.checkAuthResponse({ status: 401 });

        expect(window.authManager.clear).toHaveBeenCalledOnce();
        expect(window.authManager.notify).toHaveBeenCalledOnce();
    });
});
