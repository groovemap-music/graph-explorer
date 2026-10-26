/**
 * Theme toggle: light or dark. The default is the OS setting (prefers-color-scheme); a user
 * choice is stored in localStorage and wins, and with no stored choice live OS changes are
 * followed. The inline bootstrap in each page's <head> applies the theme before first paint
 * and exposes `window.GrooveMapTheme`; this script wires the header button and keeps a
 * self-contained fallback so the toggle still works if the bootstrap is missing.
 */
(function initThemeToggle() {
    'use strict';

    const COLORS = { dark: '#0e0d0b', light: '#eeeae3' };
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    function stored() {
        try {
            const value = localStorage.getItem('theme');
            return value === 'dark' || value === 'light' ? value : null;
        } catch (e) {
            return null;
        }
    }

    function effective() {
        return stored() || (media.matches ? 'dark' : 'light');
    }

    function apply() {
        const theme = effective();
        const override = stored();
        const root = document.documentElement;
        root.classList.toggle('dark', theme === 'dark');
        root.style.colorScheme = theme;
        document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
            meta.setAttribute('content', override ? COLORS[theme] : COLORS[meta.dataset.themeColor] || COLORS[theme]);
        });
        return theme;
    }

    function set(theme) {
        try {
            localStorage.setItem('theme', theme);
        } catch (e) {
            /* storage blocked: the choice applies for this page only */
        }
        return apply();
    }

    const api = window.GrooveMapTheme || { effective, apply, set };

    // Apply the stored/OS preference unconditionally; it must not depend on the button existing.
    api.apply();

    // Follow live OS changes only while the user has not made a choice.
    media.addEventListener('change', () => {
        if (!stored()) api.apply();
    });

    const btn = document.getElementById('theme-toggle');
    const sunIcon = document.getElementById('theme-icon-sun');
    const moonIcon = document.getElementById('theme-icon-moon');
    if (!btn || !sunIcon || !moonIcon) return;

    // The button shows the theme it will switch to: sun while dark, moon while light.
    function updateButton() {
        const dark = api.effective() === 'dark';
        sunIcon.classList.toggle('hidden', !dark);
        moonIcon.classList.toggle('hidden', dark);
        const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', String(dark));
    }

    updateButton();
    media.addEventListener('change', updateButton);

    btn.addEventListener('click', () => {
        api.set(api.effective() === 'dark' ? 'light' : 'dark');
        updateButton();
    });
})();
