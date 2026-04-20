/**
 * CinemaWidget - Lightweight Cinema viewer for the extension popup.
 * Shows a Ghost transaction preview before signing.
 *
 * Gap 15 §15 thirteenth-pass closure: /v4/ghost/preview is a gated
 * endpoint that REQUIRES X-Actor / X-Purpose / X-Workflow-Instance
 * request headers (Gap 12 seventh-pass disclosure gate). Constructors
 * accept a `disclosure` object carrying those three values so the
 * widget can project the wallet's ambient identity into each fetch.
 * Without the disclosure context the endpoint responds 400, so the
 * popup MUST pass it in — the widget does not synthesize defaults.
 */
class CinemaWidget {
    constructor(container, rpcUrl, disclosure) {
        this.container = container;
        this.rpcUrl = rpcUrl;
        this.disclosure = disclosure || {};
        this.canvas = null;
    }

    /** Show a Ghost preview of a transaction before signing. */
    async showPreview(contractUrl, fn, args) {
        this.container.innerHTML = '<div class="cinema-widget"><div class="widget-header">Loading preview...</div></div>';

        try {
            const preview = await this.fetchGhostPreview(contractUrl, fn, args);
            this.renderPreview(preview);
        } catch (e) {
            this.container.innerHTML = `
                <div class="cinema-widget">
                    <div class="widget-header">Preview unavailable</div>
                    <div class="widget-info"><span>${e.message}</span></div>
                </div>`;
        }
    }

    renderPreview(preview) {
        const status = preview.success !== false ? 'success' : 'failed';
        this.container.innerHTML = `
            <div class="cinema-widget">
                <div class="widget-header">Transaction Preview</div>
                <canvas id="cinema-preview-canvas" width="300" height="180"></canvas>
                <div class="widget-info">
                    <span class="widget-status ${status}">${status.toUpperCase()}</span>
                    <span class="widget-gas">Gas: ${(preview.gasUsed || 0).toLocaleString()}</span>
                    <span class="widget-changes">${(preview.stateChanges || []).length} changes</span>
                </div>
            </div>
        `;

        this.canvas = this.container.querySelector('#cinema-preview-canvas');
        if (preview.sceneGraph) {
            this.renderMiniGraph(preview.sceneGraph);
        } else {
            this.renderPlaceholder();
        }
    }

    async fetchGhostPreview(contractUrl, fn, args) {
        // Gap 15 closure: /v4/ghost/preview is the canonical
        // governance-first successor to the deleted legacy ghost-
        // preview endpoint. Wire shape: { contractUrl, function, args }
        // in, projected ghost receipt out. See pkg/ghost/api/server.go.
        //
        // Gap 12 seventh-pass gate: three disclosure headers are
        // mandatory. Without them the endpoint returns 400. The popup
        // builds this context from wallet state before construction.
        const headers = { 'Content-Type': 'application/json' };
        if (this.disclosure.actor) headers['X-Actor'] = this.disclosure.actor;
        if (this.disclosure.purpose) headers['X-Purpose'] = this.disclosure.purpose;
        if (this.disclosure.workflowInstance) headers['X-Workflow-Instance'] = this.disclosure.workflowInstance;
        const resp = await fetch(`${this.rpcUrl}/v4/ghost/preview`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ contractUrl, function: fn, args }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    renderMiniGraph(graph) {
        if (!this.canvas) return;
        const ctx = this.canvas.getContext('2d');
        const W = this.canvas.width;
        const H = this.canvas.height;

        // Background
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, W, H);

        const nodes = graph.nodes || [];
        const edges = graph.edges || [];

        // Build node map for edge lookup
        const nodeMap = {};
        nodes.forEach(n => { nodeMap[n.id] = n; });

        // Draw edges
        edges.forEach(edge => {
            const from = nodeMap[edge.fromNodeId];
            const to = nodeMap[edge.toNodeId];
            if (!from || !to || !from.position || !to.position) return;

            ctx.beginPath();
            ctx.moveTo(from.position.x * 0.25 + W/2, from.position.y * 0.25 + H/2);
            ctx.lineTo(to.position.x * 0.25 + W/2, to.position.y * 0.25 + H/2);
            ctx.strokeStyle = 'rgba(100,100,200,0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // Draw nodes
        nodes.forEach(node => {
            if (!node.position) return;
            const x = node.position.x * 0.25 + W/2;
            const y = node.position.y * 0.25 + H/2;
            const r = Math.max(3, (node.size || 10) * 0.4);
            const c = node.color || { r: 80, g: 200, b: 120, a: 255 };

            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${c.a/255})`;
            ctx.fill();
        });
    }

    renderPlaceholder() {
        if (!this.canvas) return;
        const ctx = this.canvas.getContext('2d');
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.fillStyle = '#333';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No scene graph data', this.canvas.width/2, this.canvas.height/2);
    }

    clear() {
        this.container.innerHTML = '';
    }
}

// Export for use in popup
if (typeof window !== 'undefined') window.CinemaWidget = CinemaWidget;
