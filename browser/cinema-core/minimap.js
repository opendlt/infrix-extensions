/**
 * Infrix Cinema — minimap / overview navigator (Wave J / J2).
 *
 * A downscaled view of the whole scene with a draggable viewport rectangle, so
 * the user never gets lost on a large graph and can jump anywhere instantly.
 * Redraws only when the scene or camera actually changed (cheap; respects the
 * renderer's dirty-flag spirit).
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  // sceneBounds computes the world AABB of all positioned nodes.
  function sceneBounds(graph) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of toArray(graph && (graph.nodes || graph.Nodes))) {
      if (!n.position) continue;
      minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x); maxY = Math.max(maxY, n.position.y);
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  class Minimap {
    constructor(hostEl, opts) {
      this.renderer = (opts || {}).renderer;
      this.W = (opts && opts.width) || 168;
      this.H = (opts && opts.height) || 112;
      const el = document.createElement('canvas');
      el.className = 'cinema-minimap';
      // Off by default (J2 is opt-in navigation, not always-on chrome) — the
      // View menu toggles it. Starting hidden keeps the stage calm.
      if ((opts || {}).visible === false || (opts && opts.visible == null)) el.classList.add('hidden');
      el.id = 'cinema-minimap';
      el.width = this.W; el.height = this.H;
      el.setAttribute('aria-label', 'Minimap — click to jump');
      this.el = el; this.ctx = el.getContext('2d');
      this.visible = !el.classList.contains('hidden');
      this._dragging = false;
      this._bindInteraction();
      if (hostEl) hostEl.appendChild(el);
      this._sig = '';
      this._timer = setInterval(() => this._maybeDraw(), 160);
      this._maybeDraw();
    }

    setVisible(on) {
      this.visible = !!on;
      if (this.el) this.el.classList.toggle('hidden', !this.visible);
      if (this.visible) { this._sig = ''; this._maybeDraw(); }
    }

    _project() {
      const b = sceneBounds(this.renderer && this.renderer.sceneGraph);
      if (!b) return null;
      const pad = 16;
      const w = (b.maxX - b.minX) || 1, h = (b.maxY - b.minY) || 1;
      const s = Math.min((this.W - pad * 2) / w, (this.H - pad * 2) / h);
      const ox = (this.W - w * s) / 2 - b.minX * s;
      const oy = (this.H - h * s) / 2 - b.minY * s;
      return { s, ox, oy, b };
    }

    _maybeDraw() {
      const r = this.renderer; if (!r) return;
      if (this.el && this.el.classList.contains('hidden')) return; // skip while off

      const c = r.camera || {};
      const n = r.sceneGraph ? (r.sceneGraph.nodes ? (Array.isArray(r.sceneGraph.nodes) ? r.sceneGraph.nodes.length : Object.keys(r.sceneGraph.nodes).length) : 0) : 0;
      const sig = n + '|' + Math.round(c.x) + '|' + Math.round(c.y) + '|' + (c.zoom || 0).toFixed(2) + '|' + r.cssWidth + 'x' + r.cssHeight;
      if (sig === this._sig) return;
      this._sig = sig;
      this.draw();
    }

    draw() {
      const ctx = this.ctx; const r = this.renderer;
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.fillStyle = 'rgba(12,14,28,0.92)';
      ctx.fillRect(0, 0, this.W, this.H);
      const p = this._project();
      if (!p) return;
      // nodes
      for (const node of toArray(r.sceneGraph && (r.sceneGraph.nodes || r.sceneGraph.Nodes))) {
        if (!node.position) continue;
        const x = node.position.x * p.s + p.ox, y = node.position.y * p.s + p.oy;
        const col = node.color || { r: 120, g: 180, b: 220 };
        ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${(node.opacity != null ? node.opacity : 1)})`;
        ctx.fillRect(x - 1, y - 1, 2.2, 2.2);
      }
      // viewport rectangle: world rect currently visible
      const cam = r.camera, z = cam.zoom || 1;
      const vw = r.cssWidth / z, vh = r.cssHeight / z;
      const vx = (-r.cssWidth / 2 - cam.x) / z, vy = (-r.cssHeight / 2 - cam.y) / z;
      const rx = vx * p.s + p.ox, ry = vy * p.s + p.oy;
      ctx.strokeStyle = 'rgba(92,212,228,0.95)'; ctx.lineWidth = 1.2;
      ctx.strokeRect(rx, ry, vw * p.s, vh * p.s);
      this._p = p;
    }

    _toWorld(ev) {
      const rect = this.el.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const p = this._p; if (!p) return null;
      return { x: (mx - p.ox) / p.s, y: (my - p.oy) / p.s };
    }
    _jump(ev) {
      const w = this._toWorld(ev); if (!w || !this.renderer) return;
      const z = this.renderer.camera.zoom || 1;
      // center the camera on the clicked world point
      this.renderer.camera.x = -w.x * z;
      this.renderer.camera.y = -w.y * z;
      this.renderer._dirty = true;
      this._maybeDraw();
    }
    _bindInteraction() {
      this._onDown = (e) => { this._dragging = true; this._jump(e); };
      this._onMove = (e) => { if (this._dragging) this._jump(e); };
      this._onUp = () => { this._dragging = false; };
      this.el.addEventListener('pointerdown', this._onDown);
      this.el.addEventListener('pointermove', this._onMove);
      this.el.addEventListener('pointerup', this._onUp);
      this.el.addEventListener('pointerleave', this._onUp);
    }

    destroy() {
      if (this._timer) clearInterval(this._timer);
      if (this.el) {
        this.el.removeEventListener('pointerdown', this._onDown);
        this.el.removeEventListener('pointermove', this._onMove);
        this.el.removeEventListener('pointerup', this._onUp);
        this.el.removeEventListener('pointerleave', this._onUp);
        if (this.el.remove) this.el.remove();
      }
    }
  }

  const api = { Minimap, sceneBounds };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
