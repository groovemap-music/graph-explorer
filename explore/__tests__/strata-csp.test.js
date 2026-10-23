/**
 * The Strata renderer must run under a strict Content-Security-Policy (gm-design-on0x
 * Recommendation 4): `script-src 'self'` with no 'unsafe-eval', and `style-src 'self'` with no
 * 'unsafe-inline'. So no eval, no new Function, no string timers, no style attribute written as
 * markup or through setAttribute, and no HTML parsing that could carry one. Positioning goes
 * through CSSOM (`element.style.transform`), which a policy does not block.
 *
 * The static scan covers the strata modules and the three.js files the importmap loads. The
 * browser smoke test (tests/perf/test_strata_renderer_perf.py) runs the renderer under that policy
 * and fails on any securitypolicyviolation event.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrataRenderer, STRATA_TOKENS } from '../static/js/strata-renderer.js';
import { COLLECTOR_STATES, stateTokenName } from '../static/js/strata-collector.js';
import { syntheticLayout } from './strata-synthetic.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRATA_MODULES = ['strata-renderer.js', 'strata-scene.js', 'strata-layout.js', 'strata-collector.js'].map((name) => resolve(ROOT, 'static', 'js', name));
const THREE_FILES = ['three.module.js', 'three.core.js'].map((name) => resolve(ROOT, 'node_modules', 'three', 'build', name));

const FORBIDDEN = [
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\s*\(/],
    ['Function constructor', /(?<![\w.])Function\s*\(/],
    ['string timer', /\bset(?:Timeout|Interval)\s*\(\s*['"`]/],
    ['style attribute', /setAttribute(?:NS)?\s*\(\s*(?:[^,]+,\s*)?['"`]style['"`]/],
    ['style markup', /\bstyle\s*=\s*\\?['"]/],
    ['HTML parsing', /\b(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment)\b/],
    ['cssText', /\bcssText\b/],
    ['document.write', /\bdocument\.write/],
];

// Comments may name what they forbid; only code counts.
function code(path) {
    return readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('CSP: no eval, no new Function, no inline style', () => {
    for (const path of [...STRATA_MODULES, ...THREE_FILES]) {
        it(`${path.slice(ROOT.length + 1)} holds none of the forbidden constructs`, () => {
            const source = code(path);
            const found = FORBIDDEN.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
            expect(found).toEqual([]);
        });
    }

    it('catches each construct it forbids', () => {
        const samples = [
            'eval("1")',
            'new Function("a", "b")',
            'const f = Function("x")',
            "setTimeout('go()', 1)",
            "el.setAttribute('style', 'color: red')",
            '<div style="color: red">',
            'el.innerHTML = s',
            'el.style.cssText = s',
            'document.write(s)',
        ];
        for (const [i, sample] of samples.entries()) expect(FORBIDDEN[i][1].test(sample)).toBe(true);
        expect(FORBIDDEN.some(([, pattern]) => pattern.test('el.style.transform = `translate(1px, 2px)`; el.hidden = true;'))).toBe(false);
    });
});

describe('CSP: the renderer at run time', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.textContent = '';
    });

    it('builds, renders, labels, and picks without writing a style attribute or parsing HTML', () => {
        const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
        const innerHTML = vi.spyOn(Element.prototype, 'innerHTML', 'set');
        const tokens = new Map([
            ...[STRATA_TOKENS.canvas, STRATA_TOKENS.planeFill, STRATA_TOKENS.planeLine, STRATA_TOKENS.link, STRATA_TOKENS.accent, STRATA_TOKENS.hover, STRATA_TOKENS.stateless, STRATA_TOKENS.blocked, ...STRATA_TOKENS.hull, ...Object.values(STRATA_TOKENS.edge)].map((name) => [name, '#336699']),
            ...COLLECTOR_STATES.map((state) => [stateTokenName(state, 'dark'), '#996633']),
        ]);
        const stage = document.createElement('div');
        document.body.append(stage);
        const renderer = new StrataRenderer(stage, {
            createRenderer: () => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} }),
            readToken: (name) => tokens.get(name) || '',
            theme: () => 'dark',
            matchMedia: null,
            measure: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        });
        renderer.setLayout(syntheticLayout({ nodes: 2000 }));
        renderer.render();
        renderer.select(renderer.layout.nodes[5].id);
        renderer.solo(1);
        renderer.render();
        renderer.pick(400, 300);
        expect(stage.querySelectorAll('.strata-label').length).toBeGreaterThan(0);
        expect(setAttribute.mock.calls.filter(([name]) => String(name).toLowerCase() === 'style')).toEqual([]);
        expect(innerHTML).not.toHaveBeenCalled();
        renderer.dispose();
    });
});
