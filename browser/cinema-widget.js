/**
 * CinemaWidget — the embed-mode host of the canonical Cinema core.
 *
 * Priority 05 ("one canonical Cinema product surface"): this widget no longer
 * ships its own renderer. It mounts the shared core (extension/cinema-core, a
 * byte-identical mirror of pkg/nexus/web/cinema-core synced by
 * scripts/sync-cinema-core.mjs) in `cinema.embed` mode: read-only, no operator
 * controls, no raw mutation, disclosure-aware. The Ghost preview is rendered by
 * the SAME renderer/vocabulary/disclosure code as Nexus and the standalone
 * product.
 *
 * Gap 15 §15 disclosure gate (preserved): /v4/ghost/preview REQUIRES
 * X-Actor / X-Purpose / X-Workflow-Instance headers, so the constructor still
 * fails loud on an incomplete disclosure context — the widget never synthesizes
 * defaults, and the wallet's mistake is surfaced immediately rather than hidden
 * behind a generic "preview unavailable".
 */
class CinemaWidget {
    constructor(container, rpcUrl, disclosure) {
        // Fail-loud on incomplete disclosure (the Gap 12 gate rejects partial
        // submissions with 400; refusing to construct makes the caller's
        // mistake visible immediately).
        if (!disclosure || !disclosure.actor || !disclosure.purpose || !disclosure.workflowInstance) {
            throw new Error('CinemaWidget requires a complete disclosure context {actor, purpose, workflowInstance} — the Gap 12 gate on /v4/ghost/preview rejects partial submissions with 400.');
        }
        this.container = container;
        this.rpcUrl = rpcUrl;
        this.disclosure = disclosure;
        this.cinema = null; // mounted core controller (embed mode)
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
                <div id="cinema-embed-mount" style="width:300px;height:180px;position:relative;"></div>
                <div class="widget-info">
                    <span class="widget-status ${status}">${status.toUpperCase()}</span>
                    <span class="widget-gas">Gas: ${(preview.gasUsed || 0).toLocaleString()}</span>
                    <span class="widget-changes">${(preview.stateChanges || []).length} changes</span>
                </div>
            </div>
        `;

        const mount = this.container.querySelector('#cinema-embed-mount');
        const core = (typeof window !== 'undefined') && window.InfrixCinema;
        if (mount && core && typeof core.mountCinema === 'function' && preview.sceneGraph) {
            // Embed mode: read-only, disclosure-aware. The disclosure context
            // projects the wallet's identity so any private node the preview
            // carries is redacted exactly as in Nexus.
            this.cinema = core.mountCinema({
                mode: 'cinema.embed',
                root: mount,
                scene: preview.sceneGraph,
                disclosureContext: {
                    viewerId: this.disclosure.actor,
                    purpose: this.disclosure.purpose,
                    workflowInstance: this.disclosure.workflowInstance,
                },
            });
        } else if (mount) {
            mount.innerHTML = '<div class="widget-info" style="padding:8px">No scene graph in preview.</div>';
        }
    }

    async fetchGhostPreview(contractUrl, fn, args) {
        // Gap 12 seventh-pass gate: three disclosure headers are mandatory.
        // Unconditional assignment — the constructor already rejected any
        // incomplete disclosure context, so every field is present.
        const headers = {
            'Content-Type': 'application/json',
            'X-Actor': this.disclosure.actor,
            'X-Purpose': this.disclosure.purpose,
            'X-Workflow-Instance': this.disclosure.workflowInstance,
        };
        const resp = await fetch(`${this.rpcUrl}/v4/ghost/preview`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ contractUrl, function: fn, args }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    clear() {
        if (this.cinema && typeof this.cinema.destroy === 'function') {
            try { this.cinema.destroy(); } catch (e) { /* idempotent */ }
            this.cinema = null;
        }
        this.container.innerHTML = '';
    }
}

// Export for use in popup
if (typeof window !== 'undefined') window.CinemaWidget = CinemaWidget;
