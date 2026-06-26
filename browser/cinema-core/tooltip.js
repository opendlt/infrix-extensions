/**
 * Infrix Cinema — hover tooltip (Tier B / B1).
 *
 * A lightweight "peek" card that follows the cursor on hover, so a viewer can
 * read a node/edge without opening the heavy details panel (which is now
 * reserved for a click = pin). Disclosure-safe: a redacted node shows only its
 * sealed placeholder + status, never a hidden value or magnitude.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  function kindLabel(kind) { return String(kind || 'node').replace(/_/g, ' '); }

  class CinemaTooltip {
    constructor(hostEl) {
      this.host = hostEl;
      const el = document.createElement('div');
      el.className = 'cinema-tooltip hidden';
      el.id = 'cinema-tooltip';
      el.setAttribute('role', 'tooltip');
      el.setAttribute('aria-hidden', 'true');
      this.el = el;
      if (hostEl) hostEl.appendChild(el);
    }

    _rows(rows) {
      this.el.replaceChildren();
      for (const r of rows) {
        if (r == null) continue;
        const d = document.createElement('div');
        d.className = 'cinema-tooltip-' + r.cls;
        d.textContent = r.text;
        if (r.status) d.dataset.status = r.status;
        this.el.appendChild(d);
      }
    }

    showNode(node, x, y, opts) {
      if (!node) return;
      opts = opts || {};
      const stats = opts.stats || null;
      const assurance = opts.assurance || null;
      const status = ns.nodeStatus ? ns.nodeStatus(node) : '';
      const rows = [
        { cls: 'title', text: node.label || '[node]' },
        { cls: 'kind', text: kindLabel(node.kind) },
        status && status !== 'normal' ? { cls: 'chip', text: status, status } : null,
        assurance && assurance.id ? { cls: 'asr', text: 'backed to ' + (assurance.label || assurance.id), status: assurance.id } : null,
      ];
      if (node.redacted) {
        rows.push({ cls: 'note', text: '🔒 Provably sealed — value hidden' });
      } else if (stats && stats.activity > 0) {
        rows.push({ cls: 'stat', text: `${stats.inbound} in · ${stats.outbound} out · ${stats.totalGas.toLocaleString()} gas` });
      }
      this._rows(rows);
      this._place(x, y);
    }

    showEdge(edge, x, y) {
      if (!edge) return;
      const rows = [
        { cls: 'title', text: edge.label || 'call' },
        { cls: 'kind', text: `${edge.fromId || '?'} → ${edge.toId || '?'}` },
      ];
      if (edge.count) rows.push({ cls: 'stat', text: `×${edge.count}` + (edge.totalGas ? ` · ${edge.totalGas.toLocaleString()} gas` : '') });
      this._rows(rows);
      this._place(x, y);
    }

    _place(x, y) {
      const el = this.el;
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
      // Measure, then flip if we'd overflow the viewport.
      const pad = 14;
      const w = el.offsetWidth || 160, h = el.offsetHeight || 60;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1920;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 1080;
      let left = x + pad, top = y + pad;
      if (left + w > vw - 8) left = x - w - pad;
      if (top + h > vh - 8) top = y - h - pad;
      el.style.left = Math.max(8, left) + 'px';
      el.style.top = Math.max(8, top) + 'px';
    }

    hide() {
      this.el.classList.add('hidden');
      this.el.setAttribute('aria-hidden', 'true');
    }

    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  ns.CinemaTooltip = CinemaTooltip;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaTooltip };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
