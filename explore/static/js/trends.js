/**
 * Plotly.js time-series chart for release trends.
 */
class TrendsChart {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.placeholder = document.getElementById('trendsPlaceholder');
        this.hasData = false;
        this.hasComparison = false;
    }

    /**
     * Render trends data.
     * @param {Object} data - Trends response { name, type, data: [{year, count}] }
     */
    render(data) {
        if (!data || !data.data || data.data.length === 0) {
            this.clear();
            return;
        }

        this.placeholder.classList.add('hidden');
        this.hasData = true;

        const years = data.data.map(d => d.year);
        const counts = data.data.map(d => d.count);

        // Pad x-axis range
        const minYear = Math.min(...years) - 3;
        const maxYear = Math.max(...years) + 3;

        const trace = {
            x: years,
            y: counts,
            type: 'scatter',
            mode: 'lines+markers',
            name: `${data.name} releases`,
            line: {
                color: '#1877f2',
                width: 2,
            },
            marker: {
                color: '#1877f2',
                size: 6,
            },
            fill: 'tozeroy',
            fillcolor: 'rgba(24, 119, 242, 0.1)',
        };

        const c = ChartTheme.colors();
        const layout = {
            title: {
                text: `Release Timeline: ${data.name}`,
                font: { color: c.textHigh, size: 18 },
            },
            xaxis: {
                title: { text: 'Year', font: { color: c.textMid } },
                range: [minYear, maxYear],
                tickfont: { color: c.textMid },
                gridcolor: c.grid,
                linecolor: c.grid,
            },
            yaxis: {
                title: { text: 'Number of Releases', font: { color: c.textMid } },
                tickfont: { color: c.textMid },
                gridcolor: c.grid,
                linecolor: c.grid,
                rangemode: 'tozero',
            },
            plot_bgcolor: c.paper,
            paper_bgcolor: c.paper,
            font: { color: c.textHigh },
            margin: { t: 60, r: 30, b: 60, l: 60 },
            hovermode: 'x unified',
        };

        const config = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        };

        Plotly.newPlot(this.container, [trace], layout, config);
        ChartTheme.track(this.container, () => {
            const t = ChartTheme.colors();
            return {
                'title.font.color': t.textHigh,
                'xaxis.title.font.color': t.textMid,
                'xaxis.tickfont.color': t.textMid,
                'xaxis.gridcolor': t.grid,
                'xaxis.linecolor': t.grid,
                'yaxis.title.font.color': t.textMid,
                'yaxis.tickfont.color': t.textMid,
                'yaxis.gridcolor': t.grid,
                'yaxis.linecolor': t.grid,
                plot_bgcolor: t.paper,
                paper_bgcolor: t.paper,
                'font.color': t.textHigh,
            };
        });
        this.hasComparison = false;
    }

    /**
     * Add a comparison trace to the existing chart.
     * @param {Object} data - Trends response { name, type, data: [{year, count}] }
     */
    addComparison(data) {
        if (!data || !data.data || data.data.length === 0 || !this.hasData) return;

        const trace = {
            x: data.data.map(d => d.year),
            y: data.data.map(d => d.count),
            type: 'scatter',
            mode: 'lines+markers',
            name: `${data.name} releases`,
            line: { color: '#42b883', width: 2 },
            marker: { color: '#42b883', size: 6 },
            fill: 'tozeroy',
            fillcolor: 'rgba(66, 184, 131, 0.1)',
        };

        Plotly.addTraces(this.container, trace);
        this.hasComparison = true;
    }

    /**
     * Remove the comparison trace, keeping the primary trace.
     */
    clearComparison() {
        if (this.hasComparison) {
            Plotly.deleteTraces(this.container, -1);
            this.hasComparison = false;
        }
    }

    clear() {
        Plotly.purge(this.container);
        this.placeholder.classList.remove('hidden');
        this.hasData = false;
        this.hasComparison = false;
    }
}
