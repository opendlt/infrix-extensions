/**
 * DebugPanel - Shows Debug explanation of potential transaction failures
 * within the extension popup's approval dialog.
 */
class DebugPanel {
    constructor(container, rpcUrl) {
        this.container = container;
        this.rpcUrl = rpcUrl;
    }

    /** Show debug info for a pending transaction. */
    async showForTransaction(contractUrl, fn, args) {
        this.container.innerHTML = '<div class="debug-panel"><h4>Analyzing...</h4></div>';

        try {
            const analysis = await this.fetchDebugAnalysis(contractUrl, fn, args);
            this.render(analysis);
        } catch (e) {
            this.container.innerHTML = `
                <div class="debug-panel">
                    <h4>Debug Info</h4>
                    <div>Analysis unavailable: ${e.message}</div>
                </div>`;
        }
    }

    render(analysis) {
        const riskColor = analysis.riskLevel === 'high' ? '#f87171' :
                          analysis.riskLevel === 'medium' ? '#f0a030' : '#4ade80';

        let warningsHtml = '';
        if (analysis.warnings && analysis.warnings.length > 0) {
            warningsHtml = analysis.warnings.map(w =>
                `<div class="debug-suggestion">${w}</div>`
            ).join('');
        }

        let suggestionsHtml = '';
        if (analysis.suggestions && analysis.suggestions.length > 0) {
            suggestionsHtml = '<div style="margin-top:6px;color:#888;font-size:10px;">Suggestions:</div>' +
                analysis.suggestions.map(s =>
                    `<div class="debug-suggestion">${s}</div>`
                ).join('');
        }

        this.container.innerHTML = `
            <div class="debug-panel">
                <h4>Debug Analysis</h4>
                <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                    <span>Risk: <span style="color:${riskColor};font-weight:600;">${analysis.riskLevel || 'low'}</span></span>
                    <span>Gas estimate: ${(analysis.gasEstimate || 0).toLocaleString()}</span>
                </div>
                ${analysis.willRevert ?
                    '<div style="color:#f87171;font-weight:600;">This transaction will likely REVERT</div>' :
                    '<div style="color:#4ade80;">Transaction appears safe</div>'
                }
                ${warningsHtml}
                ${suggestionsHtml}
            </div>
        `;
    }

    async fetchDebugAnalysis(contractUrl, fn, args) {
        // Gap 15 closure: the legacy debug-analyze endpoint was deleted;
        // the canonical governance-first successor is /v4/debug/analyze. Wire shape
        // unchanged — {contractUrl, function, args} in; {riskLevel,
        // gasEstimate, willRevert, warnings, suggestions} out.
        // See pkg/debug/api.go::HandleAnalyze.
        const resp = await fetch(`${this.rpcUrl}/v4/debug/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contractUrl, function: fn, args }),
        });
        if (!resp.ok) {
            return {
                riskLevel: 'unknown',
                gasEstimate: 0,
                willRevert: false,
                warnings: ['Could not reach debug endpoint'],
                suggestions: [],
            };
        }
        return resp.json();
    }

    clear() {
        this.container.innerHTML = '';
    }
}

if (typeof window !== 'undefined') window.DebugPanel = DebugPanel;
