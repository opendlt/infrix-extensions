/**
 * Infrix Cinema — export / share.
 *
 * Every export is self-describing: it carries the source mode, a disclosure
 * summary (how many nodes were redacted), the verification/assurance level,
 * a timestamp, and the build commit, so a shared artifact can never be
 * mistaken for more than it is. Cinema is non-committing: an export is a VIEW
 * of canonical artifacts, never itself canonical truth — the report says so.
 *
 * Formats: PNG (canvas frame), SVG (vector scene), JSON (scene graph),
 * replay-ref (a pointer that re-opens this exact position), and proof-report
 * (the full provenance envelope as JSON).
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  class CinemaExport {
    constructor(opts) {
      this.opts = opts || {};
      this.renderer = opts.renderer;
      this.dataSource = opts.dataSource;
      this.mode = opts.mode || 'cinema.full';
      this.commit = opts.commit || (typeof root !== 'undefined' && root.__INFRIX_COMMIT__) || 'unknown';
    }

    // ---- provenance envelope shared by every format ----
    provenance(graph) {
      const nodes = toArray(graph && (graph.nodes || graph.Nodes));
      const redacted = nodes.filter(n => n.redacted).length;
      let assurance = { id: 'offline', label: 'Offline (structural)' };
      if (this.dataSource && this.dataSource.assurance) {
        const a = this.dataSource.assurance();
        const known = (ns.ASSURANCE && Object.values(ns.ASSURANCE).find(x => x.id === (a && a.id)));
        assurance = known || a || assurance;
      } else {
        const caps = this.dataSource && this.dataSource.capabilities ? this.dataSource.capabilities() : {};
        if (caps.live) assurance = { id: 'replay', label: 'Live session (re-derivable)' };
      }
      return {
        product: 'Infrix Cinema',
        nonCommitting: true,
        note: 'Visualization of canonical artifacts. Not canonical truth.',
        sourceMode: this.mode,
        disclosure: {
          viewer: (this.opts.disclosureContext && this.opts.disclosureContext.viewerId) || 'anonymous',
          redactedNodes: redacted,
          totalNodes: nodes.length,
        },
        verification: assurance,
        timestamp: new Date().toISOString(),
        commit: this.commit,
      };
    }

    async screenshot() {
      const canvas = this.renderer && this.renderer.canvas;
      if (!canvas) return;
      const url = canvas.toDataURL('image/png');
      download(url, `cinema-${stamp()}.png`);
    }

    async exportJSON() {
      const snap = this.dataSource && this.dataSource.exportSnapshot ? await this.dataSource.exportSnapshot()
        : { graph: this.renderer && this.renderer.sceneGraph, meta: {} };
      const out = { provenance: this.provenance(snap.graph), scene: snap.graph, meta: snap.meta };
      downloadText(JSON.stringify(out, null, 2), `cinema-scene-${stamp()}.json`, 'application/json');
      return out;
    }

    async exportSVG() {
      const graph = this.renderer && this.renderer.sceneGraph;
      const svg = sceneToSVG(graph);
      downloadText(svg, `cinema-${stamp()}.svg`, 'image/svg+xml');
      return svg;
    }

    // replay-ref: a portable pointer re-opening this exact mode + position.
    replayRef() {
      const pos = this.opts.timeline ? this.opts.timeline.state.currentSeq : 0;
      const ref = { kind: 'cinema.replay-ref', mode: this.mode, position: pos, provenance: this.provenance(this.renderer && this.renderer.sceneGraph) };
      downloadText(JSON.stringify(ref, null, 2), `cinema-replay-ref-${stamp()}.json`, 'application/json');
      return ref;
    }

    async proofReport() {
      const snap = this.dataSource && this.dataSource.exportSnapshot ? await this.dataSource.exportSnapshot()
        : { graph: this.renderer && this.renderer.sceneGraph, meta: {} };
      const report = {
        provenance: this.provenance(snap.graph),
        artifacts: (this.dataSource && this.dataSource.proof) ? this.dataSource.proof.artifacts || {} : {},
        scene: snap.graph,
      };
      downloadText(JSON.stringify(report, null, 2), `cinema-proof-report-${stamp()}.json`, 'application/json');
      return report;
    }
  }

  function sceneToSVG(graph) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const edges = toArray(graph && (graph.edges || graph.Edges));
    const nodeMap = {}; nodes.forEach(n => { nodeMap[n.id] = n; });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => { if (!n.position) return; minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y); maxX = Math.max(maxX, n.position.x); maxY = Math.max(maxY, n.position.y); });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
    const pad = 60;
    const w = (maxX - minX) + pad * 2, h = (maxY - minY) + pad * 2;
    const tx = (x) => (x - minX) + pad, ty = (y) => (y - minY) + pad;
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}">`];
    parts.push(`<rect width="100%" height="100%" fill="#0b0d12"/>`);
    edges.forEach(e => {
      const a = nodeMap[e.fromNodeId], b = nodeMap[e.toNodeId];
      if (!a || !b || !a.position || !b.position) return;
      const c = e.color || { r: 100, g: 150, b: 255, a: 200 };
      parts.push(`<line x1="${tx(a.position.x)}" y1="${ty(a.position.y)}" x2="${tx(b.position.x)}" y2="${ty(b.position.y)}" stroke="${rgba(c)}" stroke-width="${e.width || 2}"/>`);
    });
    nodes.forEach(n => {
      if (!n.position) return;
      const c = n.color || { r: 80, g: 200, b: 120, a: 255 };
      const r = Math.max(6, n.size || 10);
      parts.push(`<circle cx="${tx(n.position.x)}" cy="${ty(n.position.y)}" r="${r}" fill="${rgba(c)}"/>`);
      if (n.label) parts.push(`<text x="${tx(n.position.x)}" y="${ty(n.position.y) + r + 12}" fill="#ccc" font-size="10" text-anchor="middle" font-family="monospace">${escapeXml(String(n.label).slice(0, 24))}</text>`);
    });
    parts.push('</svg>');
    return parts.join('\n');
  }

  function rgba(c) { return `rgba(${c.r},${c.g},${c.b},${(c.a != null ? c.a / 255 : 1)})`; }
  function escapeXml(s) { return s.replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch])); }
  function toArray(x) { if (!x) return []; return Array.isArray(x) ? x : Object.values(x); }
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
  function download(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function downloadText(text, name, type) { const blob = new Blob([text], { type: type || 'text/plain' }); const url = URL.createObjectURL(blob); download(url, name); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  ns.CinemaExport = CinemaExport;
  ns.sceneToSVG = sceneToSVG;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaExport, sceneToSVG };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
