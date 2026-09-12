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

    checkAuthResponse(response) {
        if (response?.status === 401 && window.authManager?.isLoggedIn()) {
            window.authManager.clear();
            window.authManager.notify();
        }
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
