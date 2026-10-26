import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScript } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Set up the DOM elements required by theme.js.
 */
function setupThemeDOM() {
    document.body.textContent = '';
    document.documentElement.className = '';

    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    document.body.appendChild(btn);

    const auto = document.createElement('span');
    auto.id = 'theme-icon-auto';
    document.body.appendChild(auto);

    const sun = document.createElement('span');
    sun.id = 'theme-icon-sun';
    document.body.appendChild(sun);

    const moon = document.createElement('span');
    moon.id = 'theme-icon-moon';
    document.body.appendChild(moon);
}

function mockMedia({ dark = false } = {}) {
    const listeners = [];
    const state = { dark };
    globalThis.window.matchMedia = vi.fn((query) => ({
        get matches() { return state.dark && query.includes('dark'); },
        addEventListener: (event, cb) => { listeners.push(cb); },
        removeEventListener: vi.fn(),
    }));
    // Like the real MediaQueryList: `matches` flips, then the listeners run.
    listeners.setDark = (value) => {
        state.dark = value;
        listeners.forEach((cb) => cb({ matches: value }));
    };
    return listeners;
}

function addThemeMetas() {
    for (const [name, color] of [['dark', '#0e0d0b'], ['light', '#eeeae3']]) {
        const meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        meta.setAttribute('content', color);
        meta.dataset.themeColor = name;
        document.head.appendChild(meta);
    }
}

const metaColors = () =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute('content'));

describe('theme toggle (light or dark)', () => {
    beforeEach(() => {
        setupThemeDOM();
        document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
        localStorage.clear();
        document.documentElement.classList.remove('dark');
        delete globalThis.GrooveMapTheme;
        delete globalThis.window;
        globalThis.window = globalThis;
        mockMedia();
    });

    it('follows the OS setting by default and shows the icon for the theme it switches to', () => {
        mockMedia({ dark: true });
        loadScript('theme.js');

        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.getElementById('theme-icon-sun').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('theme-icon-moon').classList.contains('hidden')).toBe(true);
        expect(localStorage.getItem('theme')).toBeNull();
    });

    it('is light with a light OS and no stored choice', () => {
        loadScript('theme.js');

        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(document.getElementById('theme-icon-sun').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('theme-icon-moon').classList.contains('hidden')).toBe(false);
    });

    it('toggles, persists the choice and keeps native controls in step', () => {
        loadScript('theme.js');
        const btn = document.getElementById('theme-toggle');

        btn.click();
        expect(localStorage.getItem('theme')).toBe('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.documentElement.style.colorScheme).toBe('dark');
        expect(btn.getAttribute('aria-label')).toBe('Switch to light theme');

        btn.click();
        expect(localStorage.getItem('theme')).toBe('light');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(document.documentElement.style.colorScheme).toBe('light');
        expect(btn.getAttribute('aria-label')).toBe('Switch to dark theme');
    });

    it('lets a stored choice win over the OS setting', () => {
        localStorage.setItem('theme', 'light');
        mockMedia({ dark: true });
        loadScript('theme.js');

        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('ignores an unrecognised stored value and falls back to the OS setting', () => {
        localStorage.setItem('theme', 'auto');
        mockMedia({ dark: true });
        loadScript('theme.js');

        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('follows live OS changes only while no choice is stored', () => {
        const listeners = mockMedia({ dark: true });
        loadScript('theme.js');
        expect(document.documentElement.classList.contains('dark')).toBe(true);

        listeners.setDark(false);
        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('does not follow OS changes once the user has chosen', () => {
        localStorage.setItem('theme', 'light');
        const listeners = mockMedia();
        loadScript('theme.js');

        listeners.setDark(true);
        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('keeps both theme-color metas in sync with a stored choice', () => {
        addThemeMetas();
        localStorage.setItem('theme', 'light');
        mockMedia({ dark: true });
        loadScript('theme.js');
        expect(metaColors()).toEqual(['#eeeae3', '#eeeae3']);

        document.getElementById('theme-toggle').click();
        expect(metaColors()).toEqual(['#0e0d0b', '#0e0d0b']);
    });

    it('leaves each theme-color meta on its own color when following the OS', () => {
        addThemeMetas();
        loadScript('theme.js');
        expect(metaColors()).toEqual(['#0e0d0b', '#eeeae3']);
    });

    it('should not crash when required DOM elements are missing', () => {
        document.body.textContent = '';
        expect(() => loadScript('theme.js')).not.toThrow();
    });

    it('should apply a persisted preference even when the toggle button markup is absent', () => {
        // Regression: a stored preference must not depend on the toggle markup existing.
        document.body.textContent = '';
        localStorage.setItem('theme', 'dark');

        loadScript('theme.js');

        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('should apply the OS dark preference even when the toggle button markup is absent', () => {
        document.body.textContent = '';
        mockMedia({ dark: true });

        loadScript('theme.js');

        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
});

describe('head bootstrap (no flash)', () => {
    const bootstrapOf = (file) => {
        const html = readFileSync(resolve(__dirname, '..', 'static', file), 'utf-8');
        const head = html.slice(0, html.indexOf('</head>'));
        const match = head.match(/<script>([\s\S]*?)<\/script>/);
        expect(match, `${file} needs an inline <head> theme script`).toBeTruthy();
        return { html, head, script: match[1] };
    };

    beforeEach(() => {
        localStorage.clear();
        document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
        document.documentElement.className = '';
        delete globalThis.window;
        globalThis.window = globalThis;
        mockMedia();
    });

    for (const file of ['index.html', 'oauth-discogs-callback.html']) {
        it(`${file} applies the OS theme before any stylesheet or script loads`, () => {
            const { head, script } = bootstrapOf(file);
            expect(head.indexOf('<script>')).toBeLessThan(head.indexOf('rel="stylesheet"'));
            expect(head).not.toMatch(/<html[^>]*class="dark"/);
            expect(head).toContain('name="color-scheme"');
            expect(head).toContain('content="#0e0d0b" media="(prefers-color-scheme: dark)"');
            expect(head).toContain('content="#eeeae3" media="(prefers-color-scheme: light)"');

            mockMedia({ dark: true });
            globalThis.eval(script);
            expect(document.documentElement.classList.contains('dark')).toBe(true);
        });

        it(`${file} lets a stored light choice beat a dark OS`, () => {
            const { script } = bootstrapOf(file);
            localStorage.setItem('theme', 'light');
            mockMedia({ dark: true });
            globalThis.eval(script);
            expect(document.documentElement.classList.contains('dark')).toBe(false);
            expect(document.documentElement.style.colorScheme).toBe('light');
        });
    }
});

describe('theme toggle markup', () => {
    it('index.html wires up the #theme-toggle button and icon spans theme.js requires', () => {
        const html = readFileSync(resolve(__dirname, '..', 'static', 'index.html'), 'utf-8');

        expect(html).toContain('id="theme-toggle"');
        expect(html).toContain('id="theme-icon-sun"');
        expect(html).toContain('id="theme-icon-moon"');
        // The toggle must be included as a real page script for it to run.
        expect(html).toContain('js/theme.js');
    });
});

describe('light palette (regression migration-regression-68oe)', () => {
    /**
     * Extract `--name: value;` custom-property declarations out of the FIRST
     * top-level block matching `selector`, e.g. the bare `:root { ... }`
     * dark-default block or the `:root:not(.dark) { ... }` light override.
     */
    function extractCustomProps(css, selectorPattern) {
        const blockMatch = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
        expect(blockMatch, `expected a ${selectorPattern} block to exist in styles.css`).toBeTruthy();
        const body = blockMatch[1];
        const props = {};
        for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
            props[m[1]] = m[2].trim();
        }
        return props;
    }

    it('defines a :root:not(.dark) light override block in styles.css', () => {
        const css = readFileSync(resolve(__dirname, '..', 'static', 'css', 'styles.css'), 'utf-8');
        expect(css).toMatch(/:root:not\(\.dark\)\s*\{/);
    });

    it('overrides every dark-default background/text/border token with a distinct light value', () => {
        const css = readFileSync(resolve(__dirname, '..', 'static', 'css', 'styles.css'), 'utf-8');
        const darkDefaults = extractCustomProps(css, ':root');
        const lightOverrides = extractCustomProps(css, ':root:not\\(\\.dark\\)');

        const criticalTokens = [
            '--bg-void', '--bg-deep', '--card-bg', '--inner-bg',
            '--border-color', '--inner-border', '--bg-hover',
            '--text-high', '--text-mid', '--text-dim', '--text-muted',
        ];

        for (const token of criticalTokens) {
            expect(darkDefaults[token], `${token} missing from base :root`).toBeTruthy();
            expect(lightOverrides[token], `${token} missing from :root:not(.dark) override`).toBeTruthy();
            expect(lightOverrides[token]).not.toBe(darkDefaults[token]);
        }
    });

    it('does not hardcode a dark background on <body> via inline style (would defeat any CSS-variable light palette)', () => {
        const html = readFileSync(resolve(__dirname, '..', 'static', 'index.html'), 'utf-8');
        const bodyTagMatch = html.match(/<body\b[^>]*>/);
        expect(bodyTagMatch).toBeTruthy();
        expect(bodyTagMatch[0]).not.toMatch(/style=/);
    });
});
