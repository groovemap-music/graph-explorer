class ApplicationLifecycle {
    constructor(app) {
        this.app = app;
        this._authUnsubscribe = null;
        this._accountUnsubscribe = null;
        this._startup = null;
        this._destroyed = false;
    }

    start() {
        this._authUnsubscribe = window.authManager.onChange(() => {
            if (!this._destroyed) this.app._updateAuthUI();
        });
        this._accountUnsubscribe = window.authManager.onAccountChange?.((account) => {
            if (!this._destroyed) this.app._onAccountChange?.(account);
        }) || null;
        this.app._bindEvents();
        this._startup = this.app._initAuth()
            .then(() => this.app._restoreFromUrl())
            .catch((err) => {
                console.error('Auth initialisation failed:', err);
                return this.app._restoreFromUrl();
            });
        return this._startup;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        if (typeof this._authUnsubscribe === 'function') this._authUnsubscribe();
        if (typeof this._accountUnsubscribe === 'function') this._accountUnsubscribe();
        this.app.timeline?.destroy?.();
        this.app.graph?.destroy?.();
        this.app.userPanes?.destroy?.();
        window.settingsPane?.destroy?.();
        window.insightsPanel?.stopPolling?.();
    }
}

window.ApplicationLifecycle = ApplicationLifecycle;
