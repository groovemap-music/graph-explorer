const USER_PANE_STATE_FIELDS = [
    '_collectionOffset', '_wantlistOffset', '_pageSize',
    '_collectionTotal', '_wantlistTotal',
    '_discogsOAuthState', '_discogsOAuthMessageHandler',
    '_tasteCache', '_tasteLoading',
    '_collectionReqId', '_wantlistReqId', '_gapReqId',
    '_recommendationsReqId', '_statsReqId', '_tasteReqId', '_ownerGeneration', '_previewReqId',
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
        this._recommendationsReqId = 0;
        this._statsReqId = 0;
        this._tasteReqId = 0;
        this._ownerGeneration = 0;
        this._previewReqId = 0;
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
        this._previewReqId += 1;
        this._recommendationsReqId += 1;
        this._statsReqId += 1;
        this._tasteReqId += 1;
    }

    resetForAccountChange() {
        this.invalidateRequests();
        this._ownerGeneration += 1;
        this._collectionOffset = 0;
        this._wantlistOffset = 0;
        this._collectionTotal = 0;
        this._wantlistTotal = 0;
        this._tasteCache = null;
        this._tasteLoading = false;
        this._gapEntityId = null;
        this._gapEntityType = null;
        this._gapExcludeWantlist = false;
        this._gapMedia = [];
        this._gapMediaTaxonomy = null;
        this._gapOffset = 0;
        this._gapTotal = 0;
        this._discogsOAuthState = null;
    }
}

window.UserPaneState = UserPaneState;
