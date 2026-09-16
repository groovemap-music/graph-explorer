class ApiTransport {
    constructor(fetchImplementation = (...args) => window.fetch(...args)) {
        this._fetchImplementation = fetchImplementation;
        this._sessions = new Set();
    }

    fetch(resource, options) {
        return this._fetchImplementation(resource, options);
    }

    readJson(response) {
        return response.json();
    }

    readBlob(response) {
        return response.blob();
    }

    /**
     * Reconcile client-side auth state against a response's 401, or leave it
     * alone.
     *
     * A route that re-authenticates the caller with their own password (or a
     * TOTP code) also answers a mismatch with 401 — the same status an
     * expired or revoked bearer token produces. Ending the session on every
     * 401 alike would sign a collector out for typing their password wrong.
     * The caller declares that distinction on the request, by passing
     * `credentialRecheck: true`, rather than the transport parsing response
     * bodies to guess at it — that keeps this method generic across every
     * route.
     *
     * A declared credential re-check still ends the session when the 401 is
     * genuinely about the bearer token: the API sets `WWW-Authenticate` on
     * every token-validation failure and omits it when the rejection is the
     * route's own credential check, so that header (not the body) is what
     * tells the two apart on a re-check route.
     * @param {Response} response
     * @param {{credentialRecheck?: boolean}} [options]
     */
    checkAuthResponse(response, { credentialRecheck = false } = {}) {
        if (response?.status !== 401 || !window.authManager?.isLoggedIn()) return;
        if (credentialRecheck && !this._isSessionInvalid(response)) return;
        window.authManager.clear();
        window.authManager.notify();
    }

    /**
     * Whether a 401 is the API's token-validation boundary rejecting the
     * bearer token itself, as opposed to a route re-checking a credential.
     * @param {Response} response
     * @returns {boolean}
     */
    _isSessionInvalid(response) {
        const header = typeof response?.headers?.get === 'function'
            ? response.headers.get('WWW-Authenticate')
            : null;
        return Boolean(header);
    }

    openSession() {
        const controller = new window.AbortController();
        this._sessions.add(controller);
        return controller;
    }

    closeSession(controller) {
        this._sessions.delete(controller);
    }

    cancelSession(controller) {
        if (!controller) return;
        controller.abort();
        this.closeSession(controller);
    }

    cancelAll() {
        for (const controller of this._sessions) controller.abort();
        this._sessions.clear();
    }
}

window.ApiTransport = ApiTransport;
