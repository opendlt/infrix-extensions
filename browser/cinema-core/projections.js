/**
 * Infrix Cinema — alternative projections (Wave J / J4).
 *
 * Node-link is the wrong encoding for flow-heavy or very dense scenes. This adds
 * a Sankey (value/gas flow between accounts/contracts, band width = magnitude)
 * and an adjacency matrix (rows/cols = nodes, cells = traffic) — both from the
 * same SceneGraph. Disclosure-safe: a sealed magnitude is shown as a fixed band
 * labelled "[sealed]", never a number.
 *
 * `sankeyModel` / `matrixModel` are pure + unit-tested; `ProjectionView` draws.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }
  const SEALED = -1; // sentinel value for a redacted magnitude

  /**
   * sankeyModel lays out a column-by-stage Sankey.
   * @returns {{boxes:[{id,x,y,w,h,label,color}], flows:[{fromId,toId,value,sealed}], W, H}}
   */
  function sankeyModel(graph, opts) {
    opts = opts || {};
    const W = opts.width || 800, H = opts.height || 480, pad = 28;
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const edges = toArray(graph && (graph.edges || graph.Edges));

    const flowMap = new Map();
    for (const e of edges) {
      const k = (e.fromNodeId || '') + '→' + (e.toNodeId || '');
      const sealed = !!e.redacted || e.gasCost == null && e.amount == null && e.value == null && e.redacted;
      const val = e.redacted ? SEALED : ((e.gasCost || e.amount || e.value || 1));
      const prev = flowMap.get(k);
      if (!prev) flowMap.set(k, { value: val === SEALED ? SEALED : val, sealed: val === SEALED });
      else if (val === SEALED || prev.sealed) flowMap.set(k, { value: SEALED, sealed: true });
      else flowMap.set(k, { value: prev.value + val, sealed: false });
    }
    const flows = [...flowMap].map(([k, v]) => { const i = k.indexOf('→'); return { fromId: k.slice(0, i), toId: k.slice(i + 1), value: v.value, sealed: v.sealed }; });

    const STAGE_ORDER = ns.LAYOUT_STAGE_ORDER || { intent: 0, policy: 1, approval: 2, execution: 3, outcome: 4, evidence: 5, anchor: 6, witness: 7, disclosure: 8 };
    const colOf = (n) => { const s = ns.layoutStageOf && ns.layoutStageOf(n); return (s != null && STAGE_ORDER[s] != null) ? STAGE_ORDER[s] : 0; };

    const value = new Map();
    for (const f of flows) { const v = f.sealed ? 1 : f.value; value.set(f.fromId, (value.get(f.fromId) || 0) + v); value.set(f.toId, (value.get(f.toId) || 0) + v); }

    const cols = new Map();
    for (const n of nodes) { const c = colOf(n); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(n); }
    const colKeys = [...cols.keys()].sort((a, b) => a - b);
    const colCount = colKeys.length || 1;
    const colW = (W - pad * 2) / Math.max(1, colCount);

    const boxById = new Map();
    colKeys.forEach((ck, ci) => {
      const members = cols.get(ck);
      const totalVal = members.reduce((s, n) => s + (value.get(n.id) || 1), 0) || 1;
      const avail = H - pad * 2 - (members.length - 1) * 6;
      let y = pad;
      const x = pad + ci * colW + colW * 0.25;
      for (const n of members) {
        const v = value.get(n.id) || 1;
        const h = Math.max(6, (v / totalVal) * avail);
        boxById.set(n.id, { id: n.id, x, y, w: colW * 0.5, h, label: n.label || n.id, color: n.color || { r: 120, g: 150, b: 220 } });
        y += h + 6;
      }
    });
    return { boxes: [...boxById.values()], boxById, flows, W, H };
  }

  /** matrixModel → ordered ids/labels + a traffic map keyed "from→to". */
  function matrixModel(graph) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const ids = nodes.map((n) => n.id);
    const labels = nodes.map((n) => n.label || n.id);
    const traffic = new Map();
    for (const e of toArray(graph && (graph.edges || graph.Edges))) {
      const k = (e.fromNodeId || '') + '→' + (e.toNodeId || '');
      traffic.set(k, (traffic.get(k) || 0) + 1);
    }
    return { ids, labels, traffic };
  }

  class ProjectionView {
    constructor(hostEl, opts) {
      this.renderer = (opts || {}).renderer;
      this.mode = null;
      const el = document.createElement('canvas');
      el.className = 'cinema-projection hidden';
      el.id = 'cinema-projection';
      this.el = el; this.ctx = el.getContext('2d');
      if (hostEl) hostEl.appendChild(el);
    }
    _size() {
      const r = this.renderer; const dpr = (r && r.dpr) || 1;
      const w = (r && r.cssWidth) || 800, h = (r && r.cssHeight) || 480;
      this.el.width = Math.round(w * dpr); this.el.height = Math.round(h * dpr);
      this.el.style.width = w + 'px'; this.el.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }
    setMode(mode, graph) {
      this.mode = mode;
      if (!mode) { this.el.classList.add('hidden'); return; }
      this.el.classList.remove('hidden');
      this.render(graph);
    }
    render(graph) {
      if (!this.mode) return;
      const { w, h } = this._size();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0a0a1a'; ctx.fillRect(0, 0, w, h);
      if (this.mode === 'sankey') this._drawSankey(graph, w, h);
      else if (this.mode === 'matrix') this._drawMatrix(graph, w, h);
    }
    _drawSankey(graph, w, h) {
      const ctx = this.ctx;
      const m = sankeyModel(graph, { width: w, height: h });
      const maxV = Math.max(1, ...m.flows.filter((f) => !f.sealed).map((f) => f.value));
      for (const f of m.flows) {
        const a = m.boxById.get(f.fromId), b = m.boxById.get(f.toId);
        if (!a || !b) continue;
        const wgt = f.sealed ? 3 : Math.max(1.5, (f.value / maxV) * 18);
        ctx.beginPath();
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
        ctx.moveTo(x1, y1); ctx.bezierCurveTo(mx, y1, mx, y2, x2, y2);
        ctx.strokeStyle = f.sealed ? 'rgba(158,158,158,0.7)' : 'rgba(92,150,228,0.45)';
        ctx.lineWidth = wgt; ctx.stroke();
      }
      for (const box of m.boxes) {
        const c = box.color;
        ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.95)`;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = '#cdd2e6'; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(String(box.label).slice(0, 16), box.x + box.w + 4, box.y + Math.min(box.h, 12));
      }
    }
    _drawMatrix(graph, w, h) {
      const ctx = this.ctx;
      const m = matrixModel(graph);
      const n = m.ids.length || 1;
      const grid = Math.min(w, h) - 40;
      const cell = grid / n;
      const ox = (w - grid) / 2, oy = (h - grid) / 2;
      let maxC = 1; for (const v of m.traffic.values()) maxC = Math.max(maxC, v);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const t = m.traffic.get(m.ids[i] + '→' + m.ids[j]) || 0;
        if (!t) continue;
        ctx.fillStyle = `rgba(92,150,228,${0.2 + 0.8 * (t / maxC)})`;
        ctx.fillRect(ox + j * cell, oy + i * cell, Math.max(1, cell - 1), Math.max(1, cell - 1));
      }
      ctx.strokeStyle = 'rgba(140,148,189,0.15)'; ctx.lineWidth = 1;
      ctx.strokeRect(ox, oy, grid, grid);
    }
    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  const api = { sankeyModel, matrixModel, ProjectionView };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
