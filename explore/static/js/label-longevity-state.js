/**
 * Shared state for the longest-running labels views.
 *
 * The Insights table and the Trends timeline both list /api/insights/label-longevity and both offer an
 * "include placeholder labels" checkbox. The choice lives here, once, so the two checkboxes and the two
 * views can never disagree. Views subscribe to be told when it changes.
 */
window.labelLongevityState = (function () {
    'use strict';

    let includePlaceholders = false;
    const subscribers = new Set();

    return {
        get includePlaceholders() {
            return includePlaceholders;
        },

        /**
         * Call `listener(include)` whenever the choice changes. A listener may return a promise.
         * @returns {Function} unsubscribe
         */
        subscribe(listener) {
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        },

        /**
         * Set the choice and wait for every subscriber to finish reacting to it.
         * One failing subscriber never stops the others.
         */
        async setIncludePlaceholders(include) {
            includePlaceholders = Boolean(include);
            await Promise.all([...subscribers].map(async (listener) => {
                try {
                    await listener(includePlaceholders);
                } catch {
                    // A view that cannot refresh shows its own error state.
                }
            }));
        },
    };
})();
