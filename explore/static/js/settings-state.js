const SETTINGS_STATE_FIELDS = [
    '_initialized', '_twoFaState', '_setupData', '_recoveryCodes',
    '_appTokensView', '_activeTokens', '_revokedTokens',
    '_mintedPlaintext', '_mintedTokenMeta',
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
    }
}

window.SettingsState = SettingsState;
