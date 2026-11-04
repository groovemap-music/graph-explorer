/**
 * Shared display-name helpers for graph nodes and explore rows.
 *
 * The explore API can return a row with a null or blank name (a label with no
 * name in the catalogue, for example). Every place that shows a name reads it
 * through these helpers, so a nameless row gets one readable fallback such as
 * "Unknown label" instead of the literal text "null" or a `.length` crash.
 */
(function initGraphLabels() {
    'use strict';

    /**
     * True when a value is a non-blank string.
     * @param {*} value
     * @returns {boolean}
     */
    function hasName(value) {
        return typeof value === 'string' && value.trim() !== '';
    }

    /**
     * Readable stand-in for a missing name, built from the entity type.
     * @param {string|null|undefined} type - e.g. 'label', 'artist'
     * @returns {string} e.g. 'Unknown label'
     */
    function fallbackName(type) {
        const noun = typeof type === 'string' ? type.trim().replace(/[-_]+/g, ' ') : '';
        return noun ? `Unknown ${noun}` : 'Unknown item';
    }

    /**
     * Name for an API row (a child, centre or path step): the row's own name,
     * or the type fallback. Always returns a string.
     * @param {{name?: *, type?: string}|null|undefined} row
     * @returns {string}
     */
    function rowName(row) {
        return hasName(row?.name) ? row.name : fallbackName(row?.type);
    }

    /**
     * Label for a graph node: displayName (categories), then name, then the
     * type fallback. Always returns a string.
     * @param {{displayName?: *, name?: *, type?: string}|null|undefined} node
     * @returns {string}
     */
    function nodeName(node) {
        if (hasName(node?.displayName)) return node.displayName;
        if (hasName(node?.name)) return node.name;
        return fallbackName(node?.type);
    }

    window.GraphLabels = { hasName, fallbackName, rowName, nodeName };
})();
