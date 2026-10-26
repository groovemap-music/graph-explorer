/**
 * Theme colors for Plotly charts, read from the CSS variables at call time so a
 * chart always matches the active theme (see theme.js, which toggles `.dark`).
 *
 * `ChartTheme.colors()` returns the current palette. `ChartTheme.series()` returns the data
 * series colors (primary accent, secondary, tertiary, neutral), which differ per theme.
 * `ChartTheme.track(el, build, restyle)` re-applies `build()` (a Plotly layout patch) to `el`
 * whenever the theme class changes, the same MutationObserver pattern the Strata renderers
 * use. The optional `restyle(el)` returns `{ update, traces }` for `Plotly.restyle`, so trace
 * colors follow the theme too.
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

    function series() {
        const style = getComputedStyle(document.documentElement);
        return {
            accent: readVar(style, '--cyan-500'),
            secondary: readVar(style, '--accent-secondary'),
            tertiary: readVar(style, '--accent-tertiary'),
            neutral: readVar(style, '--text-mid'),
        };
    }

    /** `#rrggbb` plus an alpha as `rgba(...)`; any other color string is returned unchanged. */
    function alpha(color, opacity) {
        const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color || '');
        if (!match) return color;
        const [r, g, b] = match.slice(1).map((hex) => parseInt(hex, 16));
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    function track(el, build, restyle) {
        if (!el || typeof MutationObserver === 'undefined') return;
        const previous = observers.get(el);
        if (previous) previous.disconnect();
        const observer = new MutationObserver(() => {
            if (!el.isConnected || !el.data || typeof Plotly === 'undefined') return;
            Plotly.relayout(el, build());
            if (restyle) {
                const next = restyle(el);
                if (next) Plotly.restyle(el, next.update, next.traces);
            }
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        observers.set(el, observer);
    }

    return { colors, series, alpha, track };
})();
