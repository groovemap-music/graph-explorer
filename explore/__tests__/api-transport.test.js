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

    describe('credential re-check requests (gm-graph-explorer-8ww.2)', () => {
        function response401(header) {
            return {
                status: 401,
                headers: { get: (name) => (name === 'WWW-Authenticate' ? header ?? null : null) },
            };
        }

        beforeEach(() => {
            window.authManager = {
                isLoggedIn: vi.fn().mockReturnValue(true),
                clear: vi.fn(),
                notify: vi.fn(),
            };
        });

        it('keeps the session on a credential-recheck 401 without WWW-Authenticate', () => {
            const transport = new window.ApiTransport();

            transport.checkAuthResponse(response401(null), { credentialRecheck: true });

            expect(window.authManager.clear).not.toHaveBeenCalled();
            expect(window.authManager.notify).not.toHaveBeenCalled();
        });

        it('still ends the session when a credential-recheck 401 carries WWW-Authenticate', () => {
            const transport = new window.ApiTransport();

            transport.checkAuthResponse(response401('Bearer'), { credentialRecheck: true });

            expect(window.authManager.clear).toHaveBeenCalledOnce();
            expect(window.authManager.notify).toHaveBeenCalledOnce();
        });

        it('ends the session on a plain 401 even without WWW-Authenticate when not declared a re-check', () => {
            const transport = new window.ApiTransport();

            transport.checkAuthResponse(response401(null));

            expect(window.authManager.clear).toHaveBeenCalledOnce();
            expect(window.authManager.notify).toHaveBeenCalledOnce();
        });

        it('does nothing for a credential-recheck response that is not a 401', () => {
            const transport = new window.ApiTransport();

            transport.checkAuthResponse({ status: 200, headers: { get: () => null } }, { credentialRecheck: true });

            expect(window.authManager.clear).not.toHaveBeenCalled();
            expect(window.authManager.notify).not.toHaveBeenCalled();
        });
    });
});
