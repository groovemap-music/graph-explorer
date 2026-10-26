import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exploreDir = resolve(here, '..');
const staticDir = join(exploreDir, 'static');
const read = (...parts) => readFileSync(join(...parts), 'utf8');

const SOURCES = [
    join(staticDir, 'index.html'),
    join(staticDir, 'oauth-discogs-callback.html'),
    ...readdirSync(join(staticDir, 'css')).map((f) => join(staticDir, 'css', f)),
    ...readdirSync(join(staticDir, 'js')).map((f) => join(staticDir, 'js', f)),
    join(exploreDir, 'tailwind.input.css'),
];

describe('Label web brand adoption', () => {
    it('self-hosts Jura from @fontsource/jura and no longer ships Space Grotesk', () => {
        const pkg = JSON.parse(read(exploreDir, 'package.json'));
        expect(pkg.dependencies['@fontsource/jura']).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pkg.dependencies['@fontsource/space-grotesk']).toBeUndefined();

        const manifest = JSON.parse(read(exploreDir, 'vendor-assets.json'));
        const jura = manifest.assets.find((asset) => asset.id === 'jura');
        expect(jura.selected_license).toBe('OFL-1.1');
        expect(jura.license_destination).toBe('licenses/jura-5.3.0-OFL-1.1.txt');
        expect(jura.outputs).toContain('fonts/jura/latin-300.css');
        expect(manifest.assets.some((asset) => asset.id === 'space-grotesk')).toBe(false);

        const build = read(exploreDir, '..', 'scripts', 'build-web-assets.sh');
        expect(build).toContain('@fontsource/jura/latin-{300,400}.css');
        expect(build).not.toMatch(/space-grotesk/i);
        for (const file of SOURCES.concat(join(exploreDir, 'scripts', 'vendor-licenses.mjs'))) {
            expect(read(file), file).not.toMatch(/space[ -]grotesk/i);
        }
    });

    it('shows the theme-swapped mark, the Jura wordmark and the brand tagline in the header', () => {
        const html = read(staticDir, 'index.html');
        expect(html).toContain('src="/brand/icon-dark.svg"');
        expect(html).toContain('src="/brand/icon-light.svg"');
        expect(html).toContain('<span class="navbar-wordmark">groovemap</span>');
        expect(html).toContain('<span class="navbar-tagline">explore the connections behind music</span>');
        expect(html).not.toContain('the choon network');
        expect(html).toContain('vendor/fonts/jura/latin-300.css');

        const css = read(staticDir, 'css', 'styles.css');
        expect(css).toMatch(/\.navbar-wordmark\s*\{[^}]*font-weight:\s*300;[^}]*letter-spacing:\s*0\.12em/);
        expect(css).toMatch(/\.navbar-tagline\s*\{[^}]*font-weight:\s*400/);
        expect(css).toMatch(/::selection\s*\{[^}]*var\(--groovemap-brass\)[^}]*var\(--groovemap-void\)/);
        expect(css).toMatch(/--font-body:/);
        expect(css).toMatch(/--font-mono:/);
    });

    it('takes the legend colors from the entity tokens', () => {
        const html = read(staticDir, 'index.html');
        for (const name of ['artist', 'release', 'label', 'genre', 'category']) {
            expect(html).toContain(`style="background:var(--node-${name})"`);
        }
    });

    it('uses the shared secondary data colors', () => {
        const css = read(staticDir, 'css', 'styles.css');
        expect(css).toContain('--accent-secondary: #96c0a7;');
        expect(css).toContain('--accent-secondary: #14361e;');
        expect(css).not.toMatch(/#e8ffb3|#1f2bd6/i);
    });

    it('leaves none of the audited off-brand literals or Tailwind palette utilities behind', () => {
        const literals = [
            '#1DB954', '#FF6B6B', '#6c757d', '#ffc107', '#4A90D9', '#9b8dff', '#6b5ddf', '#141420', '#0a0a14',
            '#1a1a24', '#2a2a3a', '#1877f2', '#42b883', '#6b46c1', '#7c3aed', '#818cf8', '#a78bfa', '#34d399',
            '#facc15', '#eab308', '#ef4444', '#10b981', '#6c5ce7', '#a855f7', '#1565c0', '#38bdf8', '#f43f5e',
            '#6366f1', '#4f46e5', '#059669', '#2563eb', '#3b82f6', '#fbbf24', '#f5a623', '#22c55e',
        ];
        const palette = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|accent|shadow)-(?:gray|blue|indigo|violet|purple|amber|green|yellow|red|slate|zinc|neutral|stone|emerald|teal|sky|orange|rose|pink|fuchsia|lime)-\d{2,3}\b/;
        const rgbs = /rgba?\(\s*(?:59,\s*130,\s*246|124,\s*58,\s*237|107,\s*70,\s*193|155,\s*141,\s*255|108,\s*92,\s*231|74,\s*144,\s*217)/;
        for (const file of SOURCES) {
            const text = read(file);
            for (const literal of literals) {
                expect(text.toLowerCase().includes(literal.toLowerCase()), `${file} still has ${literal}`).toBe(false);
            }
            expect(text, file).not.toMatch(palette);
            expect(text, file).not.toMatch(rgbs);
        }
    });

    it('re-skins the OAuth callback with the shared tokens and a favicon', () => {
        const html = read(staticDir, 'oauth-discogs-callback.html');
        expect(html).toContain('/brand/tokens.css');
        expect(html).toContain('css/styles.css');
        expect(html).toContain('rel="icon"');
        expect(html).toContain('bg-bg-deep');
        expect(html).not.toContain('bg-bg-base');
        expect(html).not.toMatch(/<html[^>]*class="dark"/);
    });

    it('defines every custom property the stylesheets read from the token layer', () => {
        const defined = new Set();
        for (const file of readdirSync(join(staticDir, 'css'))) {
            for (const m of read(staticDir, 'css', file).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
        }
        const tokens = read(staticDir, 'brand', 'tokens.css');
        for (const m of tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
        for (const file of ['strata.css', 'strata-atlas.css', 'nlq-pill.css']) {
            const sheet = read(staticDir, 'css', file);
            for (const m of sheet.matchAll(/var\((--[a-z0-9-]+)/g)) {
                expect(defined.has(m[1]), `${file} reads undefined ${m[1]}`).toBe(true);
            }
        }
        expect(existsSync(join(staticDir, 'brand', 'icon-light.svg'))).toBe(true);
    });
});
