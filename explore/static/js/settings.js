// The consent vocabulary catalog-api publishes, in its order. A purpose the
// server has never recorded still renders (as not granted), so the same two
// controls appear before and after the first decision.
const CONSENT_PURPOSES = [
    {
        purpose: 'product_analytics',
        label: 'Product analytics',
        description: 'Count what happens in the app so we can see what works.',
    },
    {
        purpose: 'model_training',
        label: 'Model training',
        description: 'Use your activity to improve the recommendation models.',
    },
];

// The erasure receipt outlives the settings pane on purpose.
//
// A successful erasure clears the session, the auth listener switches the
// browser off Settings, and `SettingsState` drops the delete card's transient
// state — so the card that rendered the receipt is behind the signed-out view
// before anyone can read it. The erasure id is the only durable handle the
// user has on an erasure that did not finish in every store, so it is held
// here, in module scope, where the session clear cannot reach it, and rendered
// once into a region that lives outside every pane.
//
// Deliberately not localStorage: the erasure has just emptied that key space,
// and a receipt written there would outlive the session on a shared machine.
// Losing the receipt on reload is the correct trade — it is a one-time notice,
// not a record the browser is responsible for keeping.
let pendingErasureReceipt = null;

class SettingsPane {
    constructor() {
        this._state = new window.SettingsState();
        this._state.exposeOn(this);
        this._events = new window.AbortController();
    }

    init() {
        this._loadProfile();
        this._renderTwoFaState();
        this._loadAppTokens();
        this._loadConsent();
        this._renderExportCard();
        this._renderDeleteAccountCard();

        if (!this._initialized) {
            this._bindEvents();
            this._initialized = true;
        }
    }

    // ------------------------------------------------------------------ //
    // Profile card
    // ------------------------------------------------------------------ //

    _loadProfile() {
        const user = window.authManager.getUser();
        if (!user) return;

        const emailEl = document.getElementById('settingsEmail');
        if (emailEl) emailEl.textContent = user.email || '';

        const createdEl = document.getElementById('settingsCreatedAt');
        if (createdEl) {
            if (user.created_at) {
                const d = new Date(user.created_at);
                createdEl.textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
            } else {
                createdEl.textContent = '';
            }
        }

        const discogsEl = document.getElementById('settingsDiscogsStatus');
        if (discogsEl) {
            const status = window.authManager.getDiscogsStatus();
            if (status && status.connected) {
                discogsEl.textContent = '';
                const badge = document.createElement('span');
                badge.className = 'twofa-badge twofa-badge-enabled';
                badge.textContent = 'Connected';
                discogsEl.appendChild(badge);
                if (status.username) {
                    const username = document.createElement('span');
                    username.className = 'ml-2 text-text-mid text-sm';
                    username.textContent = status.username;
                    discogsEl.appendChild(username);
                }
            } else {
                discogsEl.textContent = 'Not connected';
            }
        }

        // Derive 2FA state from user data — but never while a transient flow
        // (setup / recovery / disableConfirm) is in progress. init() runs on
        // EVERY pane activation, so re-entering Settings mid-flow would
        // otherwise clobber the one-time recovery-codes screen (codes are
        // returned once by /2fa/setup and cannot be re-fetched), mirroring
        // the 'revealing' guard in _loadAppTokens above.
        if (!['setup', 'recovery', 'disableConfirm'].includes(this._twoFaState)) {
            this._twoFaState = user.totp_enabled ? 'enabled' : 'disabled';
        }
    }

    // ------------------------------------------------------------------ //
    // Event binding
    // ------------------------------------------------------------------ //

    _bindEvents() {
        const changeBtn = document.getElementById('changePasswordBtn');
        if (changeBtn) {
            changeBtn.addEventListener('click', () => this._handleChangePassword(), { signal: this._events.signal });
        }
    }

    destroy() {
        this._events.abort();
        this._state.clearTransientSecrets();
        this._initialized = false;
    }

    // ------------------------------------------------------------------ //
    // Change password
    // ------------------------------------------------------------------ //

    async _handleChangePassword() {
        const currentPw = document.getElementById('settingsCurrentPassword');
        const newPw = document.getElementById('settingsNewPassword');
        const confirmPw = document.getElementById('settingsConfirmPassword');
        const errorEl = document.getElementById('passwordChangeError');
        const successEl = document.getElementById('passwordChangeSuccess');

        errorEl.textContent = '';
        successEl.textContent = '';
        successEl.classList.add('hidden');

        const current = currentPw.value;
        const next = newPw.value;
        const confirm = confirmPw.value;

        if (!current) { errorEl.textContent = 'Current password is required'; return; }
        if (!next || next.length < 8) { errorEl.textContent = 'New password must be at least 8 characters'; return; }
        if (next !== confirm) { errorEl.textContent = 'Passwords do not match'; return; }

        const token = window.authManager.getToken();
        if (!token) { errorEl.textContent = 'Not authenticated'; return; }

        const btn = document.getElementById('changePasswordBtn');
        btn.disabled = true;

        try {
            const response = await window.apiClient.changePassword(token, current, next);
            if (response.ok) {
                successEl.textContent = 'Password changed successfully';
                successEl.classList.remove('hidden');
                currentPw.value = '';
                newPw.value = '';
                confirmPw.value = '';
            } else {
                const data = await response.json().catch(() => ({}));
                errorEl.textContent = data.detail || 'Failed to change password';
            }
        } catch {
            errorEl.textContent = 'Network error — please try again';
        } finally {
            btn.disabled = false;
        }
    }

    // ------------------------------------------------------------------ //
    // 2FA state machine
    // ------------------------------------------------------------------ //

    _renderTwoFaState() {
        const container = document.getElementById('twoFactorContent');
        if (!container) return;
        container.textContent = '';

        switch (this._twoFaState) {
            case 'disabled':       this._renderDisabledState(container); break;
            case 'enabled':        this._renderEnabledState(container); break;
            case 'setup':          this._renderSetupState(container); break;
            case 'recovery':       this._renderRecoveryState(container); break;
            case 'disableConfirm': this._renderDisableConfirmState(container); break;
        }
    }

    // -- Disabled state ------------------------------------------------ //

    _renderDisabledState(container) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between';

        const left = document.createElement('div');
        const statusLabel = document.createElement('span');
        statusLabel.className = 'text-sm text-text-mid mr-2';
        statusLabel.textContent = 'Status:';
        const badge = document.createElement('span');
        badge.className = 'twofa-badge twofa-badge-disabled';
        badge.textContent = 'Disabled';
        left.appendChild(statusLabel);
        left.appendChild(badge);

        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.type = 'button';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined mr-1';
        icon.style.fontSize = '18px';
        icon.textContent = 'security';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode('Enable 2FA'));
        btn.addEventListener('click', () => this._startSetup());

        row.appendChild(left);
        row.appendChild(btn);
        container.appendChild(row);
    }

    // -- Enabled state ------------------------------------------------- //

    _renderEnabledState(container) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between';

        const left = document.createElement('div');
        const statusLabel = document.createElement('span');
        statusLabel.className = 'text-sm text-text-mid mr-2';
        statusLabel.textContent = 'Status:';
        const badge = document.createElement('span');
        badge.className = 'twofa-badge twofa-badge-enabled';
        badge.textContent = 'Enabled';
        left.appendChild(statusLabel);
        left.appendChild(badge);

        const btn = document.createElement('button');
        btn.className = 'btn-danger';
        btn.type = 'button';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined mr-1';
        icon.style.fontSize = '18px';
        icon.textContent = 'shield';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode('Disable 2FA'));
        btn.addEventListener('click', () => {
            this._twoFaState = 'disableConfirm';
            this._renderTwoFaState();
        });

        row.appendChild(left);
        row.appendChild(btn);
        container.appendChild(row);
    }

    // -- Setup state --------------------------------------------------- //

    _renderSetupState(container) {
        if (!this._setupData) return;

        // Instructions
        const instructions = document.createElement('p');
        instructions.className = 'text-sm text-text-mid mb-3';
        instructions.textContent = 'Scan the QR code with your authenticator app, then enter the 6-digit code to verify.';
        container.appendChild(instructions);

        // QR code
        const qrContainer = document.createElement('div');
        qrContainer.className = 'twofa-qr-container';
        container.appendChild(qrContainer);
        /* global QRCode */
        new QRCode(qrContainer, {
            text: this._setupData.otpauth_uri,
            width: 160,
            height: 160,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M,
        });

        // Manual secret
        const manualDiv = document.createElement('div');
        manualDiv.className = 'twofa-manual-secret';
        const manualLabel = document.createElement('span');
        manualLabel.textContent = 'Manual entry: ';
        const codeEl = document.createElement('code');
        codeEl.textContent = this._setupData.secret;
        manualDiv.appendChild(manualLabel);
        manualDiv.appendChild(codeEl);
        container.appendChild(manualDiv);

        // TOTP 6-digit inputs
        const inputGroup = document.createElement('div');
        inputGroup.className = 'twofa-code-inputs';
        for (let i = 0; i < 6; i++) {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.inputMode = 'numeric';
            inp.maxLength = 1;
            inp.className = 'form-input-dark text-center';
            inp.style.width = '2.5rem';
            inp.style.fontSize = '1.25rem';
            inp.dataset.setupTotp = String(i);
            inputGroup.appendChild(inp);
        }
        container.appendChild(inputGroup);
        this._bindTotpInputs('setupTotp');

        // Error
        const errorEl = document.createElement('div');
        errorEl.className = 'text-sm text-accent-red min-h-[1.2rem] mb-2';
        errorEl.id = 'setupTotpError';
        container.appendChild(errorEl);

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'flex gap-2';

        const verifyBtn = document.createElement('button');
        verifyBtn.className = 'btn-primary';
        verifyBtn.type = 'button';
        verifyBtn.textContent = 'Verify & Enable';
        verifyBtn.addEventListener('click', () => this._confirmSetup());

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-secondary';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            this._setupData = null;
            this._twoFaState = 'disabled';
            this._renderTwoFaState();
        });

        btnRow.appendChild(verifyBtn);
        btnRow.appendChild(cancelBtn);
        container.appendChild(btnRow);
    }

    // -- Recovery state ------------------------------------------------ //

    _renderRecoveryState(container) {
        // Warning banner
        const warning = document.createElement('div');
        warning.className = 'recovery-warning';
        const warnIcon = document.createElement('span');
        warnIcon.className = 'material-symbols-outlined';
        warnIcon.style.fontSize = '20px';
        warnIcon.style.color = '#eab308';
        warnIcon.textContent = 'warning';
        const warnText = document.createElement('span');
        warnText.textContent = 'Save these recovery codes in a secure location. Each code can only be used once. If you lose access to your authenticator app, you can use these codes to sign in.';
        warning.appendChild(warnIcon);
        warning.appendChild(warnText);
        container.appendChild(warning);

        // Codes grid
        const grid = document.createElement('div');
        grid.className = 'recovery-codes-grid';
        if (this._recoveryCodes) {
            for (const code of this._recoveryCodes) {
                const cell = document.createElement('div');
                cell.textContent = code;
                grid.appendChild(cell);
            }
        }
        container.appendChild(grid);

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'flex gap-2';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-secondary';
        copyBtn.type = 'button';
        const copyIcon = document.createElement('span');
        copyIcon.className = 'material-symbols-outlined mr-1';
        copyIcon.style.fontSize = '18px';
        copyIcon.textContent = 'content_copy';
        copyBtn.appendChild(copyIcon);
        copyBtn.appendChild(document.createTextNode('Copy Codes'));
        copyBtn.addEventListener('click', () => {
            if (this._recoveryCodes) {
                navigator.clipboard.writeText(this._recoveryCodes.join('\n')).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => {
                        copyBtn.textContent = '';
                        const icon2 = document.createElement('span');
                        icon2.className = 'material-symbols-outlined mr-1';
                        icon2.style.fontSize = '18px';
                        icon2.textContent = 'content_copy';
                        copyBtn.appendChild(icon2);
                        copyBtn.appendChild(document.createTextNode('Copy Codes'));
                    }, 2000);
                });
            }
        });

        const doneBtn = document.createElement('button');
        doneBtn.className = 'btn-primary';
        doneBtn.type = 'button';
        doneBtn.textContent = "I've Saved My Codes";
        doneBtn.addEventListener('click', () => {
            this._recoveryCodes = null;
            this._setupData = null;
            this._twoFaState = 'enabled';
            this._renderTwoFaState();
        });

        btnRow.appendChild(copyBtn);
        btnRow.appendChild(doneBtn);
        container.appendChild(btnRow);
    }

    // -- Disable confirm state ----------------------------------------- //

    _renderDisableConfirmState(container) {
        const instructions = document.createElement('p');
        instructions.className = 'text-sm text-text-mid mb-3';
        instructions.textContent = 'Enter your current TOTP code and password to disable two-factor authentication.';
        container.appendChild(instructions);

        // TOTP inputs
        const label1 = document.createElement('label');
        label1.className = 'settings-label mb-1 block';
        label1.textContent = 'Authenticator Code';
        container.appendChild(label1);

        const inputGroup = document.createElement('div');
        inputGroup.className = 'twofa-code-inputs';
        for (let i = 0; i < 6; i++) {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.inputMode = 'numeric';
            inp.maxLength = 1;
            inp.className = 'form-input-dark text-center';
            inp.style.width = '2.5rem';
            inp.style.fontSize = '1.25rem';
            inp.dataset.disableTotp = String(i);
            inputGroup.appendChild(inp);
        }
        container.appendChild(inputGroup);
        this._bindTotpInputs('disableTotp');

        // Password
        const label2 = document.createElement('label');
        label2.className = 'settings-label mb-1 block';
        label2.textContent = 'Password';
        container.appendChild(label2);

        const pwInput = document.createElement('input');
        pwInput.type = 'password';
        pwInput.className = 'form-input-dark mb-3';
        pwInput.id = 'disableTotpPassword';
        pwInput.autocomplete = 'current-password';
        pwInput.placeholder = 'Enter your password';
        container.appendChild(pwInput);

        // Error
        const errorEl = document.createElement('div');
        errorEl.className = 'text-sm text-accent-red min-h-[1.2rem] mb-2';
        errorEl.id = 'disableTotpError';
        container.appendChild(errorEl);

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'flex gap-2';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn-danger';
        confirmBtn.type = 'button';
        confirmBtn.textContent = 'Disable 2FA';
        confirmBtn.addEventListener('click', () => this._handleDisable());

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-secondary';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            this._twoFaState = 'enabled';
            this._renderTwoFaState();
        });

        btnRow.appendChild(confirmBtn);
        btnRow.appendChild(cancelBtn);
        container.appendChild(btnRow);
    }

    // ------------------------------------------------------------------ //
    // 2FA actions
    // ------------------------------------------------------------------ //

    async _startSetup() {
        const token = window.authManager.getToken();
        if (!token) return;

        try {
            const response = await window.apiClient.twoFactorSetup(token);
            if (response.ok) {
                this._setupData = await response.json();
                this._twoFaState = 'setup';
                this._renderTwoFaState();
            } else {
                const data = await response.json().catch(() => ({}));
                // Show a temporary error in the container
                const container = document.getElementById('twoFactorContent');
                if (container) {
                    const err = document.createElement('div');
                    err.className = 'text-sm text-accent-red';
                    err.textContent = data.detail || 'Failed to start 2FA setup';
                    container.appendChild(err);
                }
            }
        } catch {
            // Network error — ignore silently, button remains clickable
        }
    }

    async _confirmSetup() {
        const code = this._collectTotpCode('setupTotp');
        const errorEl = document.getElementById('setupTotpError');
        if (!errorEl) return;
        errorEl.textContent = '';

        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            errorEl.textContent = 'Please enter a 6-digit code';
            return;
        }

        const token = window.authManager.getToken();
        if (!token) { errorEl.textContent = 'Not authenticated'; return; }

        try {
            const response = await window.apiClient.twoFactorConfirm(token, code);
            if (response.ok) {
                await response.json().catch(() => ({}));
                // Recovery codes were returned by /api/auth/2fa/setup, not /confirm.
                this._recoveryCodes = this._setupData?.recovery_codes || [];
                window.authManager.updateTotpEnabled(true);
                this._twoFaState = 'recovery';
                this._renderTwoFaState();
            } else {
                const data = await response.json().catch(() => ({}));
                errorEl.textContent = data.detail || 'Invalid code';
                this._clearTotpInputs('setupTotp');
            }
        } catch {
            errorEl.textContent = 'Network error — please try again';
        }
    }

    async _handleDisable() {
        const code = this._collectTotpCode('disableTotp');
        const password = document.getElementById('disableTotpPassword')?.value || '';
        const errorEl = document.getElementById('disableTotpError');
        if (!errorEl) return;
        errorEl.textContent = '';

        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            errorEl.textContent = 'Please enter a 6-digit code';
            return;
        }
        if (!password) {
            errorEl.textContent = 'Password is required';
            return;
        }

        const token = window.authManager.getToken();
        if (!token) { errorEl.textContent = 'Not authenticated'; return; }

        try {
            const response = await window.apiClient.twoFactorDisable(token, code, password);
            if (response.ok) {
                window.authManager.updateTotpEnabled(false);
                this._twoFaState = 'disabled';
                this._renderTwoFaState();
            } else {
                const data = await response.json().catch(() => ({}));
                errorEl.textContent = data.detail || 'Failed to disable 2FA';
                this._clearTotpInputs('disableTotp');
            }
        } catch {
            errorEl.textContent = 'Network error — please try again';
        }
    }

    // ------------------------------------------------------------------ //
    // TOTP input helpers
    // ------------------------------------------------------------------ //

    _bindTotpInputs(dataAttr) {
        const inputs = document.querySelectorAll(`[data-${this._camelToKebab(dataAttr)}]`);
        inputs.forEach((input, idx) => {
            input.addEventListener('input', () => {
                // Accept only digits
                input.value = input.value.replace(/\D/g, '').slice(0, 1);
                if (input.value.length === 1 && idx < inputs.length - 1) {
                    inputs[idx + 1].focus();
                }
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !input.value && idx > 0) {
                    inputs[idx - 1].focus();
                }
            });
            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
                for (let i = 0; i < paste.length && i + idx < inputs.length; i++) {
                    inputs[idx + i].value = paste[i];
                }
                const nextIdx = Math.min(idx + paste.length, inputs.length - 1);
                inputs[nextIdx].focus();
            });
        });
    }

    _collectTotpCode(dataAttr) {
        const inputs = document.querySelectorAll(`[data-${this._camelToKebab(dataAttr)}]`);
        return Array.from(inputs).map(i => i.value).join('');
    }

    _clearTotpInputs(dataAttr) {
        const inputs = document.querySelectorAll(`[data-${this._camelToKebab(dataAttr)}]`);
        inputs.forEach(i => { i.value = ''; });
        if (inputs.length > 0) inputs[0].focus();
    }

    _camelToKebab(str) {
        return str.replace(/([A-Z])/g, '-$1').toLowerCase();
    }

    // ------------------------------------------------------------------ //
    // App tokens (third-party app authorization) — Connected Apps card
    //
    // All DOM is built with createElement + textContent — no innerHTML —
    // so token names and metadata cannot be interpreted as HTML even if
    // a future endpoint forgets to sanitize.
    // ------------------------------------------------------------------ //

    _appTokensClear(container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }

    async _loadAppTokens() {
        const container = document.getElementById('appTokensContent');
        if (!container) return;
        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) {
            this._appTokensClear(container);
            const msg = document.createElement('div');
            msg.className = 'settings-empty';
            msg.textContent = 'Sign in to manage connected apps.';
            container.appendChild(msg);
            return;
        }
        let res = null;
        try {
            res = await window.apiClient.listAppTokens(token);
        } catch {
            res = null;
        }
        this._activeTokens = (res && Array.isArray(res.active)) ? res.active : [];
        this._revokedTokens = (res && Array.isArray(res.revoked)) ? res.revoked : [];
        if (this._appTokensView === 'minting') {
            // Preserve the in-progress mint form (and whatever the user has
            // typed into it) instead of tearing it down via a re-render —
            // mirrors the 'revealing' guard below. The refreshed token list
            // renders once minting finishes and the view returns to 'list'.
            return;
        }
        if (this._appTokensView !== 'revealing') {
            this._appTokensView = 'list';
        }
        this._renderAppTokensView();
    }

    _renderAppTokensView() {
        const container = document.getElementById('appTokensContent');
        if (!container) return;
        switch (this._appTokensView) {
            case 'minting':   this._renderMintForm(container); break;
            case 'revealing': this._renderRevealScreen(container); break;
            case 'list':
            default:          this._renderAppTokensList(container); break;
        }
    }

    _fmtDate(iso) {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        } catch {
            return String(iso);
        }
    }

    _renderAppTokensList(container) {
        this._appTokensClear(container);

        const intro = document.createElement('p');
        intro.className = 'app-tokens-intro';
        intro.textContent = 'Authorize third-party apps (e.g. GRUVAX kiosk) to read your data. Each app gets a unique token you can revoke at any time.';
        container.appendChild(intro);

        const activeWrap = document.createElement('div');
        activeWrap.className = 'app-tokens-active';
        if (!this._activeTokens.length) {
            const empty = document.createElement('div');
            empty.className = 'app-tokens-empty';
            empty.textContent = 'No connected apps yet.';
            activeWrap.appendChild(empty);
        } else {
            for (const t of this._activeTokens) {
                activeWrap.appendChild(this._buildActiveTokenRow(t));
            }
        }
        container.appendChild(activeWrap);

        if (this._revokedTokens.length) {
            const header = document.createElement('div');
            header.className = 'app-tokens-revoked-header';
            header.textContent = 'Revoked (audit trail)';
            container.appendChild(header);

            const revokedList = document.createElement('div');
            revokedList.className = 'app-tokens-revoked-list';
            for (const t of this._revokedTokens) {
                const row = document.createElement('div');
                row.className = 'app-token-revoked-row';

                const name = document.createElement('span');
                name.className = 'app-token-name app-token-name-revoked';
                name.textContent = t.name || '';
                row.appendChild(name);

                const meta = document.createElement('span');
                meta.className = 'app-token-meta';
                meta.textContent = `Revoked: ${this._fmtDate(t.revoked_at)}`;
                row.appendChild(meta);

                revokedList.appendChild(row);
            }
            container.appendChild(revokedList);
        }

        const mintBtn = document.createElement('button');
        mintBtn.id = 'appTokenMintBtn';
        mintBtn.type = 'button';
        mintBtn.className = 'btn-primary mt-3';
        const mintIcon = document.createElement('span');
        mintIcon.className = 'material-symbols-outlined mr-1';
        mintIcon.style.fontSize = '18px';
        mintIcon.textContent = 'add';
        mintBtn.appendChild(mintIcon);
        mintBtn.appendChild(document.createTextNode('Connect an app'));
        mintBtn.addEventListener('click', () => this._handleStartMint());
        container.appendChild(mintBtn);
    }

    _buildActiveTokenRow(t) {
        const row = document.createElement('div');
        row.className = 'app-token-row';
        row.setAttribute('data-token-id', t.id || '');

        const mainCol = document.createElement('div');
        mainCol.className = 'app-token-row-main';

        const name = document.createElement('div');
        name.className = 'app-token-name';
        name.textContent = t.name || '';
        mainCol.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'app-token-meta';
        const scopeSpan = document.createElement('span');
        scopeSpan.textContent = `Scope: ${(t.scopes || []).join(', ')}`;
        const createdSpan = document.createElement('span');
        createdSpan.textContent = `Created: ${this._fmtDate(t.created_at)}`;
        const usedSpan = document.createElement('span');
        usedSpan.textContent = `Last used: ${this._fmtDate(t.last_used_at)}`;
        meta.appendChild(scopeSpan);
        meta.appendChild(createdSpan);
        meta.appendChild(usedSpan);
        mainCol.appendChild(meta);

        row.appendChild(mainCol);

        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'btn-secondary app-token-revoke';
        revokeBtn.textContent = 'Revoke';
        revokeBtn.addEventListener('click', () => this._handleRevoke(t.id, t.name));
        row.appendChild(revokeBtn);

        return row;
    }

    _renderMintForm(container) {
        this._appTokensClear(container);

        const form = document.createElement('div');
        form.className = 'app-token-mint-form';

        // Name field
        const nameWrap = document.createElement('div');
        nameWrap.className = 'mb-3';
        const nameLabel = document.createElement('label');
        nameLabel.className = 'settings-label';
        nameLabel.htmlFor = 'appTokenName';
        nameLabel.textContent = 'App name';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.id = 'appTokenName';
        nameInput.className = 'form-input-dark';
        nameInput.maxLength = 255;
        nameInput.placeholder = 'e.g. GRUVAX kiosk';
        nameInput.autocomplete = 'off';
        nameWrap.appendChild(nameLabel);
        nameWrap.appendChild(nameInput);
        form.appendChild(nameWrap);

        // Scopes
        const scopesWrap = document.createElement('div');
        scopesWrap.className = 'mb-3';
        const scopesLabel = document.createElement('label');
        scopesLabel.className = 'settings-label';
        scopesLabel.textContent = 'Permissions';
        scopesWrap.appendChild(scopesLabel);

        const scopeRow = document.createElement('div');
        scopeRow.className = 'app-token-scope-row';
        const scopeChk = document.createElement('input');
        scopeChk.type = 'checkbox';
        scopeChk.id = 'appTokenScope_collectionRead';
        scopeChk.checked = true;
        const scopeChkLabel = document.createElement('label');
        scopeChkLabel.className = 'settings-label-inline';
        scopeChkLabel.htmlFor = 'appTokenScope_collectionRead';
        const scopeBold = document.createElement('strong');
        scopeBold.textContent = 'collection:read';
        const scopeDesc = document.createElement('span');
        scopeDesc.className = 'app-token-scope-desc';
        scopeDesc.textContent = 'Read your collection, stats, and timeline';
        scopeChkLabel.appendChild(scopeBold);
        scopeChkLabel.appendChild(document.createTextNode(' '));
        scopeChkLabel.appendChild(scopeDesc);
        scopeRow.appendChild(scopeChk);
        scopeRow.appendChild(scopeChkLabel);
        scopesWrap.appendChild(scopeRow);
        form.appendChild(scopesWrap);

        // Error region
        const err = document.createElement('div');
        err.id = 'appTokenMintError';
        err.className = 'mb-2 min-h-[1.2rem] text-sm text-accent-red';
        form.appendChild(err);

        // Buttons
        const actions = document.createElement('div');
        actions.className = 'app-token-mint-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'appTokenCancelMint';
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => this._handleCancelMint());
        const submitBtn = document.createElement('button');
        submitBtn.id = 'appTokenSubmitMint';
        submitBtn.type = 'button';
        submitBtn.className = 'btn-primary';
        const submitIcon = document.createElement('span');
        submitIcon.className = 'material-symbols-outlined mr-1';
        submitIcon.style.fontSize = '18px';
        submitIcon.textContent = 'vpn_key';
        submitBtn.appendChild(submitIcon);
        submitBtn.appendChild(document.createTextNode('Mint token'));
        submitBtn.addEventListener('click', () => this._handleSubmitMint());
        actions.appendChild(cancelBtn);
        actions.appendChild(submitBtn);
        form.appendChild(actions);

        container.appendChild(form);
        nameInput.focus();
    }

    _renderRevealScreen(container) {
        this._appTokensClear(container);

        const wrap = document.createElement('div');
        wrap.className = 'app-token-reveal';

        const warn = document.createElement('div');
        warn.className = 'app-token-reveal-warning';
        const warnIcon = document.createElement('span');
        warnIcon.className = 'material-symbols-outlined';
        warnIcon.style.fontSize = '20px';
        warnIcon.textContent = 'warning';
        const warnStrong = document.createElement('strong');
        warnStrong.textContent = 'This is the only time you will see this token.';
        warn.appendChild(warnIcon);
        warn.appendChild(warnStrong);
        warn.appendChild(document.createTextNode(' Copy it now and store it somewhere safe — it cannot be recovered.'));
        wrap.appendChild(warn);

        const meta = this._mintedTokenMeta || { name: '', scopes: [] };

        const metaBlock = document.createElement('div');
        metaBlock.className = 'app-token-reveal-meta';
        const appDiv = document.createElement('div');
        const appLbl = document.createElement('span');
        appLbl.className = 'settings-label';
        appLbl.textContent = 'App:';
        appDiv.appendChild(appLbl);
        appDiv.appendChild(document.createTextNode(' ' + (meta.name || '')));
        const permDiv = document.createElement('div');
        const permLbl = document.createElement('span');
        permLbl.className = 'settings-label';
        permLbl.textContent = 'Permissions:';
        permDiv.appendChild(permLbl);
        permDiv.appendChild(document.createTextNode(' ' + (meta.scopes || []).join(', ')));
        metaBlock.appendChild(appDiv);
        metaBlock.appendChild(permDiv);
        wrap.appendChild(metaBlock);

        const tokenLabel = document.createElement('label');
        tokenLabel.className = 'settings-label';
        tokenLabel.textContent = 'Token';
        wrap.appendChild(tokenLabel);

        const pre = document.createElement('pre');
        pre.id = 'appTokenPlaintext';
        pre.className = 'app-token-plaintext';
        // textContent is the only safe sink — the plaintext is opaque random data,
        // but even so, never interpolate it as HTML.
        pre.textContent = this._mintedPlaintext || '';
        wrap.appendChild(pre);

        const actions = document.createElement('div');
        actions.className = 'app-token-reveal-actions';
        const copyBtn = document.createElement('button');
        copyBtn.id = 'appTokenCopy';
        copyBtn.type = 'button';
        copyBtn.className = 'btn-secondary';
        const copyIcon = document.createElement('span');
        copyIcon.className = 'material-symbols-outlined mr-1';
        copyIcon.style.fontSize = '18px';
        copyIcon.textContent = 'content_copy';
        copyBtn.appendChild(copyIcon);
        copyBtn.appendChild(document.createTextNode('Copy'));
        copyBtn.addEventListener('click', () => this._handleCopyToken());
        const doneBtn = document.createElement('button');
        doneBtn.id = 'appTokenDoneReveal';
        doneBtn.type = 'button';
        doneBtn.className = 'btn-primary';
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', () => this._handleDoneReveal());
        actions.appendChild(copyBtn);
        actions.appendChild(doneBtn);
        wrap.appendChild(actions);

        const note = document.createElement('div');
        note.id = 'appTokenCopiedNote';
        note.className = 'mb-2 min-h-[1.2rem] text-sm text-accent-green hidden';
        note.textContent = 'Copied to clipboard';
        wrap.appendChild(note);

        container.appendChild(wrap);
    }

    _handleStartMint() {
        this._appTokensView = 'minting';
        this._renderAppTokensView();
    }

    _handleCancelMint() {
        this._appTokensView = 'list';
        this._renderAppTokensView();
    }

    async _handleSubmitMint() {
        const errorEl = document.getElementById('appTokenMintError');
        if (errorEl) errorEl.textContent = '';

        const nameEl = document.getElementById('appTokenName');
        const collectionReadEl = document.getElementById('appTokenScope_collectionRead');
        const name = nameEl ? nameEl.value.trim() : '';
        if (!name) {
            if (errorEl) errorEl.textContent = 'App name is required';
            return;
        }

        const scopes = [];
        if (collectionReadEl && collectionReadEl.checked) scopes.push('collection:read');
        if (scopes.length === 0) {
            if (errorEl) errorEl.textContent = 'Select at least one permission';
            return;
        }

        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) {
            if (errorEl) errorEl.textContent = 'You are not signed in';
            return;
        }

        let res;
        try {
            res = await window.apiClient.mintAppToken(token, name, scopes);
        } catch {
            // A network-level fetch rejection — mirror the other settings
            // handlers (_handleChangePassword, _confirmSetup, _handleDisable)
            // instead of letting the rejection propagate unhandled.
            if (errorEl) errorEl.textContent = 'Network error — please try again';
            return;
        }
        if (!res || !res.ok || !res.body || !res.body.token) {
            const detail = (res && res.body && res.body.detail) ? res.body.detail : 'Failed to mint token';
            if (errorEl) errorEl.textContent = detail;
            return;
        }

        this._mintedPlaintext = res.body.token;
        this._mintedTokenMeta = { name: res.body.name, scopes: res.body.scopes };
        this._appTokensView = 'revealing';
        this._renderAppTokensView();
    }

    async _handleCopyToken() {
        if (!this._mintedPlaintext) return;
        try {
            await navigator.clipboard.writeText(this._mintedPlaintext);
            const note = document.getElementById('appTokenCopiedNote');
            if (note) {
                note.classList.remove('hidden');
                setTimeout(() => note.classList.add('hidden'), 2000);
            }
        } catch {
            // Clipboard write may be unavailable in some browsers/contexts.
        }
    }

    _handleDoneReveal() {
        this._mintedPlaintext = null;
        this._mintedTokenMeta = null;
        const plaintextEl = document.getElementById('appTokenPlaintext');
        if (plaintextEl) plaintextEl.textContent = '';
        this._appTokensView = 'list';
        this._loadAppTokens();
    }

    async _handleRevoke(tokenId, tokenName) {
        if (!tokenId) return;
        const confirmed = window.confirm(`Revoke the token "${tokenName}"?\n\nThis cannot be undone. Any app using it will lose access immediately.`);
        if (!confirmed) return;

        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) return;

        let ok;
        try {
            ok = await window.apiClient.revokeAppToken(token, tokenId);
        } catch {
            // A network-level fetch rejection — still surface feedback and
            // refresh the list, matching the non-ok failure path below.
            window.alert('Failed to revoke token. It may have already been revoked.');
            this._loadAppTokens();
            return;
        }
        if (!ok) {
            window.alert('Failed to revoke token. It may have already been revoked.');
        }
        this._loadAppTokens();
    }

    // ------------------------------------------------------------------ //
    // Privacy card (consent purposes)
    //
    // Like the app-tokens card, every node is built with createElement +
    // textContent — the purpose strings come from the API and are never
    // interpolated as HTML.
    // ------------------------------------------------------------------ //

    _clearContainer(container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }

    async _loadConsent() {
        const container = document.getElementById('privacyContent');
        if (!container) return;

        // init() runs on EVERY pane activation. A refetch mid-toggle would
        // render the pre-toggle answer over the request that is still in
        // flight, mirroring the 'minting' guard in _loadAppTokens.
        if (this._consentPending) return;

        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) {
            this._consentPurposes = [];
            this._renderConsentCard();
            return;
        }

        let res = null;
        try {
            res = await window.apiClient.getConsent(token);
        } catch {
            res = null;
        }
        if (res && Array.isArray(res.purposes)) {
            this._consentPurposes = res.purposes;
            this._consentError = '';
        } else {
            this._consentPurposes = [];
            this._consentError = 'Could not load your privacy choices.';
        }
        this._renderConsentCard();
    }

    _consentGranted(purpose) {
        const row = (this._consentPurposes || []).find(p => p && p.purpose === purpose);
        return Boolean(row && row.granted);
    }

    _renderConsentCard() {
        const container = document.getElementById('privacyContent');
        if (!container) return;
        this._clearContainer(container);

        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) {
            const msg = document.createElement('div');
            msg.className = 'settings-empty';
            msg.textContent = 'Sign in to manage your privacy choices.';
            container.appendChild(msg);
            return;
        }

        const intro = document.createElement('p');
        intro.className = 'privacy-intro';
        intro.textContent = 'Choose what GrooveMap may do with your activity. Turning a purpose off stops it from that moment on.';
        container.appendChild(intro);

        for (const spec of CONSENT_PURPOSES) {
            container.appendChild(this._buildConsentRow(spec));
        }

        const err = document.createElement('div');
        err.id = 'consentError';
        err.className = 'mb-2 min-h-[1.2rem] text-sm text-accent-red';
        err.textContent = this._consentError || '';
        container.appendChild(err);
    }

    _buildConsentRow(spec) {
        const row = document.createElement('div');
        row.className = 'privacy-row';
        row.setAttribute('data-consent-row', spec.purpose);

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.id = `consentToggle_${spec.purpose}`;
        toggle.setAttribute('data-consent-toggle', spec.purpose);
        toggle.checked = this._consentGranted(spec.purpose);
        // One request at a time: both controls go inert until the server has
        // answered, so a second click cannot race the first.
        toggle.disabled = Boolean(this._consentPending);
        toggle.addEventListener('change', () => this._handleConsentToggle(spec.purpose, toggle.checked));

        const label = document.createElement('label');
        label.className = 'settings-label-inline';
        label.htmlFor = toggle.id;
        const strong = document.createElement('strong');
        strong.textContent = spec.label;
        const desc = document.createElement('span');
        desc.className = 'privacy-purpose-desc';
        desc.textContent = spec.description;
        label.appendChild(strong);
        label.appendChild(document.createTextNode(' '));
        label.appendChild(desc);

        row.appendChild(toggle);
        row.appendChild(label);
        return row;
    }

    _setConsentTogglesDisabled(disabled) {
        document.querySelectorAll('[data-consent-toggle]').forEach(input => { input.disabled = disabled; });
    }

    async _handleConsentToggle(purpose, granted) {
        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) return;

        this._consentPending = purpose;
        this._consentError = '';
        // Disable in place rather than re-rendering: replacing the control the
        // user just clicked detaches it mid-gesture, and the only visible
        // difference is the checkbox going inert, which this does directly.
        this._setConsentTogglesDisabled(true);
        const errEl = document.getElementById('consentError');
        if (errEl) errEl.textContent = '';

        let res = null;
        try {
            res = await window.apiClient.setConsent(token, purpose, granted);
        } catch {
            res = null;
        }
        this._consentPending = null;

        if (res && typeof res.granted === 'boolean') {
            // Render the server's answer, not the click: a refused change must
            // leave the control showing what the server actually stored.
            const next = (this._consentPurposes || []).filter(p => p && p.purpose !== res.purpose);
            next.push({ purpose: res.purpose, granted: res.granted });
            this._consentPurposes = next;
        } else {
            this._consentError = 'Could not save that choice — please try again.';
        }
        this._renderConsentCard();
    }

    // ------------------------------------------------------------------ //
    // Export card
    // ------------------------------------------------------------------ //

    _renderExportCard() {
        const container = document.getElementById('exportContent');
        if (!container) return;
        this._clearContainer(container);

        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) {
            const msg = document.createElement('div');
            msg.className = 'settings-empty';
            msg.textContent = 'Sign in to export your data.';
            container.appendChild(msg);
            return;
        }

        const intro = document.createElement('p');
        intro.className = 'export-intro';
        intro.textContent = 'Download everything keyed to your account as a JSON Lines file — collection, wantlist, recommendations, and activity.';
        container.appendChild(intro);

        const btn = document.createElement('button');
        btn.id = 'exportDataBtn';
        btn.type = 'button';
        btn.className = 'btn-primary';
        btn.disabled = this._exportState === 'working';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined mr-1';
        icon.style.fontSize = '18px';
        icon.textContent = 'download';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(this._exportState === 'working' ? 'Preparing…' : 'Download my data'));
        btn.addEventListener('click', () => this._handleExport());
        container.appendChild(btn);

        const note = document.createElement('div');
        note.id = 'exportNote';
        note.className = 'mt-2 min-h-[1.2rem] text-sm text-accent-green';
        note.textContent = this._exportState === 'done' ? 'Your export has been downloaded.' : '';
        container.appendChild(note);

        const err = document.createElement('div');
        err.id = 'exportError';
        err.className = 'mt-2 min-h-[1.2rem] text-sm text-accent-red';
        err.textContent = this._exportError || '';
        container.appendChild(err);
    }

    _downloadBlob(blob, filename) {
        const urlApi = window.URL;
        if (!urlApi || typeof urlApi.createObjectURL !== 'function') return false;
        const href = urlApi.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = filename;
        // Firefox only honours a programmatic click on a connected anchor.
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (typeof urlApi.revokeObjectURL === 'function') urlApi.revokeObjectURL(href);
        return true;
    }

    async _handleExport() {
        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) return;

        this._exportState = 'working';
        this._exportError = '';
        this._renderExportCard();

        let blob = null;
        try {
            blob = await window.apiClient.requestExport(token);
        } catch {
            blob = null;
        }

        if (!blob) {
            this._exportState = 'error';
            this._exportError = 'Export failed — please try again.';
        } else if (!this._downloadBlob(blob, 'groovemap-export.ndjson')) {
            this._exportState = 'error';
            this._exportError = 'This browser could not start the download.';
        } else {
            this._exportState = 'done';
        }
        this._renderExportCard();
    }

    // ------------------------------------------------------------------ //
    // Delete account card
    //
    // The confirm step is an in-card panel in the style of the 2FA disable
    // confirm: same credential fields, same error region, same button pair.
    // ------------------------------------------------------------------ //

    _renderDeleteAccountCard() {
        const container = document.getElementById('deleteAccountContent');
        if (!container) return;
        this._clearContainer(container);

        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token && this._deleteView !== 'done') {
            const msg = document.createElement('div');
            msg.className = 'settings-empty';
            msg.textContent = 'Sign in to delete your account.';
            container.appendChild(msg);
            return;
        }

        switch (this._deleteView) {
            case 'confirm': this._renderDeleteConfirm(container); break;
            case 'done':    this._renderDeleteReceipt(container); break;
            default:        this._renderDeleteIdle(container); break;
        }
    }

    _renderDeleteIdle(container) {
        const warning = document.createElement('p');
        warning.className = 'delete-account-intro';
        warning.textContent = 'Deleting your account erases your collection, wantlist, recommendations, and activity across every store. This cannot be undone.';
        container.appendChild(warning);

        const btn = document.createElement('button');
        btn.id = 'deleteAccountBtn';
        btn.type = 'button';
        btn.className = 'btn-danger';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined mr-1';
        icon.style.fontSize = '18px';
        icon.textContent = 'delete_forever';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode('Delete my account'));
        btn.addEventListener('click', () => {
            this._deleteView = 'confirm';
            this._renderDeleteAccountCard();
        });
        container.appendChild(btn);
    }

    _twoFaRequiredForErasure() {
        const user = window.authManager && window.authManager.getUser && window.authManager.getUser();
        return Boolean(user && user.totp_enabled);
    }

    _renderDeleteConfirm(container) {
        const instructions = document.createElement('p');
        instructions.className = 'text-sm text-text-mid mb-3';
        instructions.textContent = 'This permanently erases your account and everything keyed to it — collection, wantlist, recommendations, and activity. It cannot be undone. Confirm with your password to continue.';
        container.appendChild(instructions);

        if (this._twoFaRequiredForErasure()) {
            const codeLabel = document.createElement('label');
            codeLabel.className = 'settings-label mb-1 block';
            codeLabel.textContent = 'Authenticator Code';
            container.appendChild(codeLabel);

            const inputGroup = document.createElement('div');
            inputGroup.className = 'twofa-code-inputs';
            for (let i = 0; i < 6; i++) {
                const inp = document.createElement('input');
                inp.type = 'text';
                inp.inputMode = 'numeric';
                inp.maxLength = 1;
                inp.className = 'form-input-dark text-center';
                inp.style.width = '2.5rem';
                inp.style.fontSize = '1.25rem';
                inp.dataset.erasureTotp = String(i);
                inputGroup.appendChild(inp);
            }
            container.appendChild(inputGroup);
            this._bindTotpInputs('erasureTotp');
        }

        const pwLabel = document.createElement('label');
        pwLabel.className = 'settings-label mb-1 block';
        pwLabel.htmlFor = 'erasurePassword';
        pwLabel.textContent = 'Password';
        container.appendChild(pwLabel);

        const pwInput = document.createElement('input');
        pwInput.type = 'password';
        pwInput.className = 'form-input-dark mb-3';
        pwInput.id = 'erasurePassword';
        pwInput.autocomplete = 'current-password';
        pwInput.placeholder = 'Enter your password';
        container.appendChild(pwInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'text-sm text-accent-red min-h-[1.2rem] mb-2';
        errorEl.id = 'erasureError';
        container.appendChild(errorEl);

        const btnRow = document.createElement('div');
        btnRow.className = 'flex gap-2';

        const confirmBtn = document.createElement('button');
        confirmBtn.id = 'erasureConfirmBtn';
        confirmBtn.className = 'btn-danger';
        confirmBtn.type = 'button';
        confirmBtn.textContent = 'Delete account';
        confirmBtn.addEventListener('click', () => this._handleErasure());

        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'erasureCancelBtn';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            this._deleteView = 'idle';
            this._renderDeleteAccountCard();
        });

        btnRow.appendChild(confirmBtn);
        btnRow.appendChild(cancelBtn);
        container.appendChild(btnRow);
    }

    _renderDeleteReceipt(container) {
        const heading = document.createElement('p');
        heading.className = 'delete-account-intro';
        heading.textContent = 'Your account has been deleted. You are now signed out.';
        container.appendChild(heading);
        this._appendErasureReceiptBody(container, this._erasureResult || {}, 'card');
    }

    /**
     * Append the erasure id and any partial-failure notice to a container.
     *
     * Shared by the settings card and the signed-out banner. Element ids are
     * suffixed per surface because both can exist at once: the card is still in
     * the DOM, behind the signed-out view, while the banner is the copy the
     * user can actually read. The unsuffixed ids stay on the banner, since that
     * is the surface the receipt is now delivered on.
     *
     * @param {HTMLElement} container - Where to append
     * @param {object} result - The 202 body from requestErasure
     * @param {string} surface - 'card' or 'banner'
     */
    _appendErasureReceiptBody(container, result, surface) {
        const suffix = surface === 'card' ? 'Card' : '';

        const idRow = document.createElement('div');
        idRow.className = 'settings-field';
        const idLabel = document.createElement('span');
        idLabel.className = 'settings-label';
        idLabel.textContent = 'Erasure id';
        const idValue = document.createElement('code');
        idValue.id = `erasureId${suffix}`;
        idValue.className = 'settings-value';
        idValue.textContent = result.erasure_id || '';
        idRow.appendChild(idLabel);
        idRow.appendChild(idValue);
        container.appendChild(idRow);

        const incomplete = Array.isArray(result.incomplete) ? result.incomplete : [];
        if (!incomplete.length) return;

        const notice = document.createElement('div');
        notice.id = `erasureIncomplete${suffix}`;
        notice.className = 'recovery-warning';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.style.fontSize = '20px';
        icon.style.color = '#eab308';
        icon.textContent = 'warning';
        notice.appendChild(icon);

        const body = document.createElement('div');
        const lead = document.createElement('div');
        lead.textContent = 'Some stores did not finish. Keep this erasure id and contact support.';
        body.appendChild(lead);
        const list = document.createElement('ul');
        list.className = 'erasure-incomplete-list';
        for (const failure of incomplete) {
            const item = document.createElement('li');
            item.textContent = String(failure);
            list.appendChild(item);
        }
        body.appendChild(list);
        notice.appendChild(body);
        container.appendChild(notice);
    }

    /**
     * Render the held receipt onto the signed-out view, once.
     *
     * Called after the session clear, when the settings pane is no longer
     * reachable. Renders nothing when no receipt is held — which is the state
     * after a dismiss, and after a reload, since the receipt is memory only.
     */
    _renderErasureReceiptBanner() {
        const banner = document.getElementById('erasureReceiptBanner');
        if (!banner) return;
        this._clearContainer(banner);

        if (!pendingErasureReceipt) {
            banner.hidden = true;
            return;
        }

        const heading = document.createElement('p');
        heading.className = 'erasure-receipt-heading';
        heading.textContent = 'Your account has been deleted. You are now signed out.';
        banner.appendChild(heading);

        this._appendErasureReceiptBody(banner, pendingErasureReceipt, 'banner');

        const keep = document.createElement('p');
        keep.className = 'erasure-receipt-note';
        keep.textContent = 'Keep this id if you need to ask about the deletion. It is not stored anywhere in this browser.';
        banner.appendChild(keep);

        const dismiss = document.createElement('button');
        dismiss.id = 'erasureReceiptDismissBtn';
        dismiss.type = 'button';
        dismiss.className = 'erasure-receipt-dismiss';
        dismiss.setAttribute('aria-label', 'Dismiss the deletion receipt');
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', () => {
            // Dropping the held copy is what makes this a one-time notice:
            // nothing can render it again.
            pendingErasureReceipt = null;
            this._renderErasureReceiptBanner();
        });
        banner.appendChild(dismiss);

        banner.hidden = false;
    }

    async _handleErasure() {
        const errorEl = document.getElementById('erasureError');
        if (!errorEl) return;
        errorEl.textContent = '';

        const password = document.getElementById('erasurePassword')?.value || '';
        const needsCode = this._twoFaRequiredForErasure();
        const code = needsCode ? this._collectTotpCode('erasureTotp') : null;

        if (!password) {
            errorEl.textContent = 'Password is required';
            return;
        }
        if (needsCode && !/^\d{6}$/.test(code)) {
            errorEl.textContent = 'Please enter a 6-digit code';
            return;
        }

        const token = window.authManager && window.authManager.getToken && window.authManager.getToken();
        if (!token) { errorEl.textContent = 'Not authenticated'; return; }

        // Disable in place rather than re-rendering: a re-render would drop the
        // password the user just typed, which the retry path still needs.
        const confirmBtn = document.getElementById('erasureConfirmBtn');
        const cancelBtn = document.getElementById('erasureCancelBtn');
        if (confirmBtn) confirmBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;

        let res;
        try {
            res = await window.apiClient.requestErasure(token, password, code);
        } catch {
            res = null;
        }

        if (!res || !res.ok) {
            // The panel stays in the confirm state with the detail inline so the
            // caller can correct the credential. The API answers a wrong password
            // with 401, same as an expired session, but requestErasure declares
            // itself a credential re-check to ApiTransport, which keeps the
            // session alive for that 401 unless the response says the bearer
            // token itself is the problem. This card never clears the session
            // on a rejection of its own accord.
            const detail = (res && res.body && res.body.detail) ? res.body.detail : 'Could not delete your account — please try again.';
            errorEl.textContent = detail;
            if (confirmBtn) confirmBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
            if (needsCode) this._clearTotpInputs('erasureTotp');
            return;
        }

        // Render the receipt before the session goes away: the erasure id is the
        // only durable handle the user has on a partially completed erasure.
        this._erasureResult = res.body || {};
        this._deleteView = 'done';
        this._renderDeleteAccountCard();

        // Hold the receipt outside the pane's state before clearing the
        // session. The clear switches the browser off Settings, so the card
        // above is not the copy anyone reads.
        pendingErasureReceipt = this._erasureResult;

        window.authManager.clear();
        window.authManager.notify();

        // Now that the signed-out view is up, put the receipt where it is
        // visible, with a dismiss control.
        this._renderErasureReceiptBanner();
    }
}

window.settingsPane = new SettingsPane();
