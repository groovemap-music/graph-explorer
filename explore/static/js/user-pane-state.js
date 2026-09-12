const USER_PANE_STATE_FIELDS = [
    '_collectionOffset', '_wantlistOffset', '_pageSize',
    '_collectionTotal', '_wantlistTotal',
    '_discogsOAuthState', '_discogsOAuthMessageHandler',
    '_tasteCache', '_tasteLoading',
    '_collectionReqId', '_wantlistReqId', '_gapReqId',
    '_gapEntityId', '_gapEntityType', '_gapExcludeWantlist',
    '_gapMedia', '_gapMediaTaxonomy', '_gapOffset', '_gapTotal',
];

class UserPaneState {
    constructor() {
        this._collectionOffset = 0;
        this._wantlistOffset = 0;
        this._pageSize = 50;
        this._collectionTotal = 0;
        this._wantlistTotal = 0;
        this._discogsOAuthState = null;
        this._discogsOAuthMessageHandler = null;
        this._tasteCache = null;
        this._tasteLoading = false;
        this._collectionReqId = 0;
        this._wantlistReqId = 0;
        this._gapReqId = 0;
        this._gapOffset = 0;
        this._gapTotal = 0;
        this._gapEntityType = null;
        this._gapEntityId = null;
        this._gapMedia = [];
        this._gapExcludeWantlist = false;
        this._gapMediaTaxonomy = null;
    }

    exposeOn(owner) {
        for (const field of USER_PANE_STATE_FIELDS) {
            Object.defineProperty(owner, field, {
                configurable: true,
                enumerable: false,
                get: () => this[field],
                set: (value) => { this[field] = value; },
            });
        }
    }

    invalidateRequests() {
        this._collectionReqId += 1;
        this._wantlistReqId += 1;
        this._gapReqId += 1;
    }
}

window.UserPaneState = UserPaneState;
