/**
 * Longest-running labels timeline for the Trends pane.
 *
 * A Plotly horizontal floating-bar chart: one row per label in stored rank order, a bar from first_year to
 * last_year, and a diamond at the midpoint of the label's peak decade. A label that is still active has no
 * fixed end: its bar runs to the current year and ends in an arrow. Data comes from the same
 * /api/insights/label-longevity the Insights table uses, and the include-placeholders choice is the shared
 * one in label-longevity-state.js.
 */
class LabelTimeline {
    /** Rows listed by default, the same as the Insights table. */
    static DEFAULT_LIMIT = 20;
    /** Rows the analytics writer stores, so the most "Show all" can list. */
    static MAX_LIMIT = 50;
    static LABEL_MAX_CHARS = 24;

    /**
     * Plotly renders a small HTML subset (<a>, <b>, <br>, ...) in tick and hover text, and a label's name
     * is catalog data, so every name is escaped before it goes into either. Only our own <br> is markup.
     */
    static escapeText(text) {
        return String(text).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }

    constructor() {
        this._section = document.getElementById('labelTimelineSection');
        this._chart = document.getElementById('labelTimelineChart');
        this._status = document.getElementById('labelTimelineStatus');
        this._toggle = document.getElementById('trendsIncludePlaceholders');
        this._showAllBtn = document.getElementById('labelTimelineShowAll');

        this._showAll = false;
        this._active = false;
        this._request = 0;

        const state = window.labelLongevityState;
        if (this._toggle) {
            this._toggle.checked = state.includePlaceholders;
            this._toggle.addEventListener('change', () => state.setIncludePlaceholders(this._toggle.checked));
        }
        // The Insights checkbox changes the same state; follow it, but only fetch once the pane has been shown.
        state.subscribe((include) => {
            if (this._toggle) this._toggle.checked = include;
            return this._active ? this.load() : undefined;
        });

        if (this._showAllBtn) {
            this._showAllBtn.addEventListener('click', () => this.setShowAll(!this._showAll));
        }
        if (this._section) {
            // A closed <details> has no width, so a chart drawn while it was shut is redrawn on opening.
            this._section.addEventListener('toggle', () => {
                if (this._section.open && this._active) this.load();
            });
        }
    }

    /** The Trends pane has been shown: start listing labels. */
    activate() {
        this._active = true;
        return this.load();
    }

    async setShowAll(showAll) {
        this._showAll = Boolean(showAll);
        if (this._showAllBtn) {
            this._showAllBtn.setAttribute('aria-pressed', String(this._showAll));
            this._showAllBtn.textContent = this._showAll ? 'Show top 20' : 'Show all';
        }
        await this.load();
    }

    async load() {
        if (this._section && !this._section.open) return;
        const request = ++this._request;
        const limit = this._showAll ? LabelTimeline.MAX_LIMIT : LabelTimeline.DEFAULT_LIMIT;
        const include = window.labelLongevityState.includePlaceholders;

        this._setStatus('Loading longest-running labels...');
        let data = null;
        let failed = false;
        try {
            data = await window.apiClient.getInsightsLabelLongevity(limit, include);
            failed = data == null;
        } catch {
            failed = true;
        }
        // A slower response for an earlier choice must not overwrite the current one.
        if (request !== this._request) return;

        if (failed) {
            this._clearChart();
            this._setStatus('Could not load the longest-running labels. Try again in a moment.');
            return;
        }
        if (!data.items?.length) {
            this._clearChart();
            this._setStatus('No label data available yet');
            return;
        }
        this._setStatus('');
        this.render(data.items);
    }

    _setStatus(message) {
        if (!this._status) return;
        this._status.textContent = message;
        this._status.classList.toggle('hidden', !message);
    }

    _clearChart() {
        if (this._chart && typeof Plotly !== 'undefined') Plotly.purge(this._chart);
    }

    /**
     * Turn API rows into the arrays Plotly draws. Pure, so it is tested without a chart.
     * Rows keep the order they arrive in (stored rank order).
     * @param {Array} items - label-longevity items
     * @param {number} currentYear - where a still-active label's bar ends
     */
    static buildModel(items, currentYear) {
        const rows = items.map((label, index) => {
            const end = label.still_active || label.last_year == null ? currentYear : label.last_year;
            const span = Math.max(1, end - label.first_year + 1);
            const name = label.label_name;
            // A placeholder never shows its stored rank (it sits after every real label's); real labels do.
            const shown = label.is_placeholder ? `${name} (placeholder)` : `${label.rank}. ${name}`;
            // Truncate the plain text first, then escape, so an entity is never cut in half.
            const tick = LabelTimeline.escapeText(shown.length > LabelTimeline.LABEL_MAX_CHARS
                ? `${shown.slice(0, LabelTimeline.LABEL_MAX_CHARS - 1)}…`
                : shown);
            const range = `${label.first_year}–${label.still_active || label.last_year == null ? 'present' : label.last_year}`;
            const peak = label.peak_decade == null ? '' : `<br>Peak decade: ${label.peak_decade}s`;
            const hover = `${LabelTimeline.escapeText(shown)}<br>${range} (${label.years_active} years)${peak}`;
            return {
                y: index,
                tick,
                hover,
                start: label.first_year,
                span,
                end: end + 1,
                placeholder: Boolean(label.is_placeholder),
                stillActive: Boolean(label.still_active),
                // The decade's midpoint: 1960 is drawn at 1965.
                peak: label.peak_decade == null ? null : label.peak_decade + 5,
            };
        });
        return { rows, currentYear };
    }

    render(items) {
        if (!this._chart || typeof Plotly === 'undefined') return;
        const { rows, currentYear } = LabelTimeline.buildModel(items, new Date().getFullYear());
        const c = ChartTheme.colors();
        const s = ChartTheme.series();
        const barColors = (t) => rows.map((r) => (r.placeholder ? ChartTheme.alpha(t.neutral, 0.35) : t.accent));

        const active = rows.filter((r) => r.stillActive);
        const peaks = rows.filter((r) => r.peak != null);

        const traces = [
            {
                type: 'bar',
                orientation: 'h',
                name: 'Active years',
                x: rows.map((r) => r.span),
                base: rows.map((r) => r.start),
                y: rows.map((r) => r.y),
                width: 0.6,
                marker: { color: barColors(s) },
                customdata: rows.map((r) => r.hover),
                hovertemplate: '%{customdata}<extra></extra>',
            },
            {
                type: 'scatter',
                mode: 'markers',
                name: 'Still active',
                x: active.map((r) => r.end),
                y: active.map((r) => r.y),
                marker: { symbol: 'triangle-right', size: 10, color: s.accent },
                customdata: active.map((r) => r.hover),
                hovertemplate: '%{customdata}<extra></extra>',
            },
            {
                type: 'scatter',
                mode: 'markers',
                name: 'Peak decade',
                x: peaks.map((r) => r.peak),
                y: peaks.map((r) => r.y),
                marker: { symbol: 'diamond', size: 9, color: c.textHigh, line: { color: c.paper, width: 1 } },
                customdata: peaks.map((r) => r.hover),
                hovertemplate: '%{customdata}<extra></extra>',
            },
        ];

        const minYear = Math.min(...rows.map((r) => r.start));
        const layout = {
            paper_bgcolor: c.paper,
            plot_bgcolor: c.paper,
            font: { color: c.textHigh, family: 'system-ui, sans-serif', size: 11 },
            margin: { t: 10, r: 16, b: 40, l: 8 },
            height: Math.max(220, rows.length * 24 + 70),
            xaxis: {
                range: [minYear - 3, currentYear + 4],
                tickformat: 'd',
                tickfont: { color: c.textMid },
                gridcolor: c.grid,
                linecolor: c.grid,
            },
            yaxis: {
                tickmode: 'array',
                tickvals: rows.map((r) => r.y),
                ticktext: rows.map((r) => r.tick),
                tickfont: { color: c.textMid },
                autorange: 'reversed',
                automargin: true,
                fixedrange: true,
                showgrid: false,
                linecolor: c.grid,
            },
            showlegend: true,
            legend: { orientation: 'h', y: -0.12, font: { color: c.textMid } },
            hovermode: 'closest',
        };

        Plotly.purge(this._chart);
        Plotly.newPlot(this._chart, traces, layout, { responsive: true, displayModeBar: false });
        ChartTheme.track(this._chart, () => {
            const t = ChartTheme.colors();
            return {
                paper_bgcolor: t.paper,
                plot_bgcolor: t.paper,
                'font.color': t.textHigh,
                'xaxis.tickfont.color': t.textMid,
                'xaxis.gridcolor': t.grid,
                'xaxis.linecolor': t.grid,
                'yaxis.tickfont.color': t.textMid,
                'yaxis.linecolor': t.grid,
                'legend.font.color': t.textMid,
            };
        }, () => {
            const t = ChartTheme.series();
            const tc = ChartTheme.colors();
            return {
                update: { 'marker.color': [barColors(t), t.accent, tc.textHigh] },
                traces: [0, 1, 2],
            };
        });
    }
}

window.labelTimeline = new LabelTimeline();
