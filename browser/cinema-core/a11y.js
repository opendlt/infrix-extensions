/**
 * Infrix Cinema — accessible graph navigation (Tier B / B5).
 *
 * The canvas is opaque to keyboard and screen-reader users. This maintains a
 * visually-hidden but focusable listbox that mirrors the scene's nodes; arrow
 * keys move a focus ring on the canvas, Enter opens details, and `f` flies to
 * the node. Disclosure-safe: option labels read only the (already redacted)
 * node label the renderer holds.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }
  function kindLabel(kind) { return String(kind || 'node').replace(/_/g, ' '); }

  class CinemaA11y {
    constructor(renderer, hostEl, opts) {
      this.renderer = renderer;
      this.opts = opts || {};
      this.items = [];          // {id, label}
      this.activeIndex = -1;
      this._build(hostEl);
    }

    _build(hostEl) {
      const box = document.createElement('div');
      box.className = 'cinema-a11y-list sr-only';
      box.id = 'cinema-a11y-list';
      box.tabIndex = 0;
      box.setAttribute('role', 'listbox');
      box.setAttribute('aria-label', 'Graph nodes — arrow keys to move, Enter for details, f to focus');
      box.addEventListener('keydown', (e) => this._onKey(e));
      box.addEventListener('blur', () => { if (this.renderer) this.renderer.setKeyboardFocus(null); });
      this.el = box;
      if (hostEl) hostEl.appendChild(box);
    }

    setScene(graph) {
      const nodes = toArray(graph && (graph.nodes || graph.Nodes)).filter((n) => n && n.position);
      this.items = nodes.map((n) => ({
        id: n.id,
        label: `${kindLabel(n.kind)}: ${n.label || n.id}` + (n.redacted ? ' (sealed)' : ''),
      }));
      this.el.replaceChildren();
      this._byId = new Map();
      for (const it of this.items) {
        const opt = document.createElement('div');
        opt.className = 'cinema-a11y-option';
        opt.id = 'cinema-a11y-opt-' + cssSafe(it.id);
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-label', it.label);
        opt.setAttribute('aria-selected', 'false');
        opt.textContent = it.label;
        this.el.appendChild(opt);
        this._byId.set(it.id, opt);
      }
      // Clamp the cursor if the scene shrank.
      if (this.activeIndex >= this.items.length) this.activeIndex = this.items.length - 1;
    }

    _onKey(e) {
      if (!this.items.length) return;
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': e.preventDefault(); this._move(1); break;
        case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); this._move(-1); break;
        case 'Home': e.preventDefault(); this._focusIndex(0); break;
        case 'End': e.preventDefault(); this._focusIndex(this.items.length - 1); break;
        case 'Enter': case ' ': case 'Spacebar': {
          e.preventDefault();
          const it = this.items[this.activeIndex];
          if (it && typeof this.opts.onActivate === 'function') this.opts.onActivate(it.id);
          break;
        }
        case 'f': case 'F': {
          const it = this.items[this.activeIndex];
          if (it && this.renderer) this.renderer.flyTo(it.id);
          break;
        }
        case 'Escape': this.el.blur(); break;
        default: break;
      }
    }

    _move(delta) {
      let i = this.activeIndex < 0 ? (delta > 0 ? 0 : this.items.length - 1) : this.activeIndex + delta;
      i = Math.max(0, Math.min(this.items.length - 1, i));
      this._focusIndex(i);
    }

    _focusIndex(i) {
      const prev = this.items[this.activeIndex];
      if (prev) { const p = this._byId.get(prev.id); if (p) p.setAttribute('aria-selected', 'false'); }
      this.activeIndex = i;
      const it = this.items[i];
      if (!it) return;
      const opt = this._byId.get(it.id);
      if (opt) { opt.setAttribute('aria-selected', 'true'); if (opt.scrollIntoView) opt.scrollIntoView({ block: 'nearest' }); }
      this.el.setAttribute('aria-activedescendant', opt ? opt.id : '');
      if (this.renderer) this.renderer.setKeyboardFocus(it.id);
    }

    /** focusNode syncs the keyboard cursor to a node selected by mouse. */
    focusNode(id) {
      const i = this.items.findIndex((it) => it.id === id);
      if (i >= 0) this._focusIndex(i);
    }

    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  function cssSafe(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

  ns.CinemaA11y = CinemaA11y;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaA11y };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
