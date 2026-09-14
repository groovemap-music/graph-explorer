const SETTINGS_STATE_FIELDS = [
    '_initialized', '_twoFaState', '_setupData', '_recoveryCodes',
    '_appTokensView', '_activeTokens', '_revokedTokens',
    '_mintedPlaintext', '_mintedTokenMeta',
    '_consentPurposes', '_consentPending', '_consentError',
    '_exportState', '_exportError',
    '_deleteView', '_erasureResult',
];

class SettingsState {
    constructor() {
        this._initialized = false;
        this._twoFaState = 'disabled';
        this._setupData = null;
        this._recoveryCodes = null;
        this._appTokensView = 'list';
        this._activeTokens = [];
        this._revokedTokens = [];
        this._mintedPlaintext = null;
        this._mintedTokenMeta = null;
        this._consentPurposes = [];
        this._consentPending = null;
        this._consentError = '';
        this._exportState = 'idle';
        this._exportError = '';
        this._deleteView = 'idle';
        this._erasureResult = null;
    }

    exposeOn(owner) {
        for (const field of SETTINGS_STATE_FIELDS) {
            Object.defineProperty(owner, field, {
                configurable: true,
                enumerable: false,
                get: () => this[field],
                set: (value) => { this[field] = value; },
            });
        }
    }

    clearTransientSecrets() {
        this._setupData = null;
        this._recoveryCodes = null;
        this._mintedPlaintext = null;
        this._mintedTokenMeta = null;
        this._appTokensView = 'list';
        // The erasure confirm view holds a password field; leaving the pane
        // drops it the way it drops a half-entered 2FA setup.
        this._deleteView = 'idle';
    }
}

window.SettingsState = SettingsState;
