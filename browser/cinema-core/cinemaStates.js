/**
 * Infrix Cinema — stage state overlay (Tier A / A4).
 *
 * Before this module, a Cinema surface with no data yet was a black rectangle
 * with "0 FPS" and "Block: 0" — indistinguishable from broken. This renders a
 * deliberate, on-brand state on top of the stage:
 *
 *   loading       resolving / connecting
 *   empty         connected but no events yet (optional primary action)
 *   empty-filter  a filter hid everything (offer to clear it)
 *   error         a live connection failed (offer to retry)
 *   hidden        data present — overlay gone
 *
 * The state DECISION is a pure function (resolveState) so it is unit-testable;
 * the class is only the DOM shell. No canvas, no renderer coupling.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node tests.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  const STATES = {
    loading: { icon: '◴', title: 'Resolving scene…', message: 'Waiting for the first governed event.' },
    empty: { icon: '◇', title: 'No activity yet', message: 'Cinema will draw the action as soon as the first governed event arrives.' },
    'empty-filter': { icon: '⌕', title: 'No nodes match', message: 'The current filter hides every node in this scene.', action: 'Clear filter' },
    error: { icon: '⚠', title: 'Connection lost', message: 'Cinema could not reach the live session.', action: 'Retry' },
  };

  /**
   * resolveState — the single source of truth for which overlay (if any) shows.
   * Pure: same inputs → same output. Order of precedence:
   *   connection error wins (the user must act) →
   *   still connecting → loading →
   *   have nodes → hidden →
   *   no nodes + active filter → empty-filter →
   *   no nodes → empty.
   * @param {{nodeCount:number, filterActive:boolean, connection:string}} s
   *   connection ∈ 'idle' | 'connecting' | 'connected' | 'error'
   * @returns {'loading'|'empty'|'empty-filter'|'error'|'hidden'}
   */
  function resolveState(s) {
    s = s || {};
    const nodeCount = s.nodeCount || 0;
    if (s.connection === 'error') return 'error';
    if (nodeCount > 0) return 'hidden';
    if (s.connection === 'connecting') return 'loading';
    if (s.filterActive) return 'empty-filter';
    if (s.connection === 'idle' && s.everConnected === false && s.expectsConnection) return 'loading';
    return 'empty';
  }

  class CinemaStateOverlay {
    constructor(stageEl, opts) {
      this.stage = stageEl;
      this.opts = opts || {};
      this.state = 'hidden';
      this._build();
    }

    _build() {
      const el = document.createElement('div');
      el.className = 'cinema-state-overlay hidden';
      el.id = 'cinema-state-overlay';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');

      const card = document.createElement('div');
      card.className = 'cinema-state-card';
      const icon = document.createElement('div'); icon.className = 'cinema-state-icon';
      const title = document.createElement('h3'); title.className = 'cinema-state-title';
      const msg = document.createElement('p'); msg.className = 'cinema-state-msg';
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'cinema-state-action hidden';
      btn.addEventListener('click', () => { if (this._onAction) this._onAction(); });

      card.append(icon, title, msg, btn);
      el.appendChild(card);
      this.el = el; this.iconEl = icon; this.titleEl = title; this.msgEl = msg; this.btnEl = btn;
      if (this.stage) this.stage.appendChild(el);
    }

    /** set renders a state. opts.onAction wires the action button; opts.message
     *  / opts.title override the defaults (e.g. an error detail string). */
    set(state, opts) {
      opts = opts || {};
      this.state = state;
      if (state === 'hidden' || !STATES[state]) {
        this.el.classList.add('hidden');
        this._onAction = null;
        return;
      }
      const def = STATES[state];
      this.el.classList.remove('hidden');
      this.el.dataset.state = state;
      this.iconEl.textContent = def.icon;
      this.titleEl.textContent = opts.title || def.title;
      this.msgEl.textContent = opts.message || def.message;
      const actionLabel = opts.actionLabel || def.action;
      if (actionLabel) {
        this.btnEl.textContent = actionLabel;
        this.btnEl.classList.remove('hidden');
        this._onAction = typeof opts.onAction === 'function' ? opts.onAction : null;
      } else {
        this.btnEl.classList.add('hidden');
        this._onAction = null;
      }
    }

    current() { return this.state; }
    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  const api = { CinemaStateOverlay, resolveState, STATE_DEFS: STATES };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
