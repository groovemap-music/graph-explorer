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
});
