/**
 * Theme colors for Plotly charts, read from the CSS variables at call time so a
 * chart always matches the active theme (see theme.js, which toggles `.dark`).
 *
 * `ChartTheme.colors()` returns the current palette. `ChartTheme.track(el, build)`
 * re-applies `build()` (a Plotly layout patch) to `el` whenever the theme class
 * changes, the same MutationObserver pattern the Strata renderers use.
 */
window.ChartTheme = (function () {
    'use strict';

    const observers = new WeakMap();

    function readVar(style, name) {
        return style.getPropertyValue(name).trim();
    }

    function colors() {
        const style = getComputedStyle(document.documentElement);
        return {
            paper: readVar(style, '--card-bg'),
            grid: readVar(style, '--border-color'),
            textHigh: readVar(style, '--text-high'),
            textMid: readVar(style, '--text-mid'),
        };
    }

    function track(el, build) {
        if (!el || typeof MutationObserver === 'undefined') return;
        const previous = observers.get(el);
        if (previous) previous.disconnect();
        const observer = new MutationObserver(() => {
            if (!el.isConnected || !el.data || typeof Plotly === 'undefined') return;
            Plotly.relayout(el, build());
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        observers.set(el, observer);
    }

    return { colors, track };
})();
