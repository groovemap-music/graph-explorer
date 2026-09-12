const GRAPH_STATE_FIELDS = [
    'nodes', 'links', 'simulation', 'expandedCategories',
    '_pendingExpands', '_loadingCategories', '_generation',
    '_categoryMeta', '_renderTimeout',
    'centerName', 'centerType', 'beforeYear',
    'compareMode', 'compareYearA', 'compareYearB',
];

class GraphSessionState {
    constructor() {
        this.nodes = [];
        this.links = [];
        this.simulation = null;
        this.expandedCategories = new Set();
        this._pendingExpands = 0;
        this._loadingCategories = new Set();
        this._generation = 0;
        this._categoryMeta = new Map();
        this._renderTimeout = null;
        this.centerName = null;
        this.centerType = null;
        this.beforeYear = null;
        this.compareMode = false;
        this.compareYearA = null;
        this.compareYearB = null;
    }

    exposeOn(owner) {
        for (const field of GRAPH_STATE_FIELDS) {
            Object.defineProperty(owner, field, {
                configurable: true,
                enumerable: false,
                get: () => this[field],
                set: (value) => { this[field] = value; },
            });
        }
    }

    invalidate() {
        this._generation += 1;
        this._pendingExpands = 0;
        this._loadingCategories.clear();
    }
}

window.GraphSessionState = GraphSessionState;
