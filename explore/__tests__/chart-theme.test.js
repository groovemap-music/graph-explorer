import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { loadScript } from './helpers.js';

describe('ChartTheme', () => {
    beforeAll(() => {
        delete globalThis.window;
        globalThis.window = globalThis;
        loadScript('chart-theme.js');
    });

    beforeEach(() => {
        document.documentElement.className = '';
        document.documentElement.style.cssText =
            '--card-bg: #12110e; --border-color: #2e2a24; --text-high: #f2ede4; --text-mid: #cfc6b8;';
    });

    it('reads the palette from the theme CSS variables', () => {
        expect(window.ChartTheme.colors()).toEqual({
            paper: '#12110e',
            grid: '#2e2a24',
            textHigh: '#f2ede4',
            textMid: '#cfc6b8',
        });
    });

    it('re-applies the layout patch when the theme class changes', async () => {
        const el = document.createElement('div');
        el.data = [{}];
        document.body.appendChild(el);
        globalThis.Plotly = { relayout: vi.fn() };
        const patch = { paper_bgcolor: '#fbf9f5' };
        window.ChartTheme.track(el, () => patch);
        document.documentElement.classList.add('dark');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(globalThis.Plotly.relayout).toHaveBeenCalledWith(el, patch);
    });

    it('reads the data series colors from the theme tokens', () => {
        document.documentElement.style.cssText +=
            '--cyan-500: #b8962a; --accent-secondary: #96c0a7; --accent-tertiary: #af829b; --text-mid: #cfc6b8;';
        expect(window.ChartTheme.series()).toEqual({
            accent: '#b8962a',
            secondary: '#96c0a7',
            tertiary: '#af829b',
            neutral: '#cfc6b8',
        });
    });

    it('turns a hex color into rgba and leaves other color strings alone', () => {
        expect(window.ChartTheme.alpha('#b8962a', 0.1)).toBe('rgba(184, 150, 42, 0.1)');
        expect(window.ChartTheme.alpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
        expect(window.ChartTheme.alpha('', 0.5)).toBe('');
    });

    it('restyles the traces when the theme class changes', async () => {
        const el = document.createElement('div');
        el.data = [{}];
        document.body.appendChild(el);
        globalThis.Plotly = { relayout: vi.fn(), restyle: vi.fn() };
        const next = { update: { 'line.color': ['#14361e'] }, traces: [0] };
        window.ChartTheme.track(el, () => ({}), () => next);
        document.documentElement.classList.add('dark');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(globalThis.Plotly.restyle).toHaveBeenCalledWith(el, next.update, next.traces);
    });
});
