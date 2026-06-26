/**
 * Infrix Cinema — self-explaining scene + zero-onboarding spotlight (Wave G / G3).
 *
 * "No onboarding because it's obvious" only holds if the scene explains itself.
 * This produces a plain-language one-liner ("1 governed transfer · 6 steps ·
 * 1 sealed value · anchored on L0 · no anomalies") and a 3-step, once-ever
 * first-run spotlight. Disclosure-safe: it only COUNTS — it never names a
 * redacted value.
 *
 * `buildSceneSummary(graph, events, proof)` is pure + unit-tested.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  const ASR_ORDER = ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness'];
  function rank(id) { const i = ASR_ORDER.indexOf(id); return i < 0 ? 0 : i; }
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /**
   * buildSceneSummary — the honest, count-only scene description.
   * @returns {{text, parts, ceiling, sealed, anomalies, steps}}
   */
  function buildSceneSummary(graph, events, proof) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    events = events || [];
    const parts = [];

    const intents = nodes.filter((n) => n.kind === 'intent').length;
    const actions = intents || (events.length ? 1 : 0);
    if (actions) parts.push(plural(actions, 'governed action', 'governed actions'));

    const steps = events.length || nodes.filter((n) => n.kind === 'plan_step' || n.kind === 'contract' || n.kind === 'account').length;
    if (steps) parts.push(plural(steps, 'step', 'steps'));

    const sealed = nodes.filter((n) => n.redacted).length;
    if (sealed) parts.push(plural(sealed, 'sealed value', 'sealed values'));

    let ceiling = 'offline';
    if (proof && ns.buildLadder) ceiling = ns.buildLadder(proof).ceilingId;
    else for (const e of events) if (rank(e.assurance) > rank(ceiling)) ceiling = e.assurance;
    if (ceiling === 'l0' || ceiling === 'witness') parts.push('anchored on L0');
    else if (ceiling === 'replay') parts.push('replay-verifiable');

    const anomalies = nodes.filter((n) => (n.anomalyScore > 0) || n.breakerState === 'frozen').length;
    parts.push(anomalies ? plural(anomalies, 'anomaly', 'anomalies') : 'no anomalies');

    return { text: parts.join(' · '), parts, ceiling, sealed, anomalies, steps };
  }

  // ---- Summary ribbon (dismissible) ----
  class SceneSummaryRibbon {
    constructor(host, opts) {
      this.opts = opts || {};
      this.storageKey = this.opts.storageKey || 'cinema.summary.dismissed';
      const el = document.createElement('div');
      el.className = 'cinema-summary-ribbon hidden';
      el.id = 'cinema-summary-ribbon';
      el.setAttribute('role', 'note');
      const txt = document.createElement('span'); txt.className = 'cinema-summary-text';
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'cinema-summary-dismiss';
      btn.textContent = '×'; btn.setAttribute('aria-label', 'Dismiss summary');
      btn.addEventListener('click', () => this.dismiss());
      el.appendChild(txt); el.appendChild(btn);
      this.el = el; this.textEl = txt;
      if (host) host.appendChild(el);
    }
    setSummary(text) {
      this.textEl.textContent = text || '';
      if (!text || this._dismissed()) { this.el.classList.add('hidden'); return; }
      this.el.classList.remove('hidden');
    }
    _dismissed() { try { return localStorage.getItem(this.storageKey) === '1'; } catch (_) { return false; } }
    dismiss() { try { localStorage.setItem(this.storageKey, '1'); } catch (_) {} this.el.classList.add('hidden'); }
    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  // ---- First-run spotlight (once ever) ----
  const DEFAULT_STEPS = [
    { title: 'This is the action', body: 'Each shape is one step of a governed action — intent, policy, approval, execution, evidence.' },
    { title: 'This is how strongly it’s proven', body: 'The trust ladder shows how far it’s backed — up to an independently verifiable L0 anchor.' },
    { title: 'Press “Play story” to watch it', body: 'Cinema flies through the whole action and narrates it. You can also press “Verify” to re-check it yourself.' },
  ];

  class Spotlight {
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.storageKey = this.opts.storageKey || 'cinema.spotlight.seen';
      this.steps = this.opts.steps || DEFAULT_STEPS;
      this.idx = 0;
      this.el = null;
    }
    _seen() { try { return localStorage.getItem(this.storageKey) === '1'; } catch (_) { return false; } }
    _markSeen() { try { localStorage.setItem(this.storageKey, '1'); } catch (_) {} }

    maybeShow() {
      if (this._seen() || this.el) return false;
      this._build();
      return true;
    }

    _build() {
      const wrap = document.createElement('div');
      wrap.className = 'cinema-spotlight';
      wrap.id = 'cinema-spotlight';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-label', 'Welcome to Cinema');
      const card = document.createElement('div'); card.className = 'cinema-spotlight-card';
      const h = document.createElement('h3'); h.className = 'cinema-spotlight-title';
      const p = document.createElement('p'); p.className = 'cinema-spotlight-body';
      const dots = document.createElement('div'); dots.className = 'cinema-spotlight-dots';
      const row = document.createElement('div'); row.className = 'cinema-spotlight-actions';
      const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'cinema-spotlight-skip'; skip.textContent = 'Skip';
      const next = document.createElement('button'); next.type = 'button'; next.className = 'cinema-spotlight-next';
      skip.addEventListener('click', () => this._finish());
      next.addEventListener('click', () => this._advance());
      row.appendChild(skip); row.appendChild(next);
      card.appendChild(h); card.appendChild(p); card.appendChild(dots); card.appendChild(row);
      wrap.appendChild(card);
      this.el = wrap; this.titleEl = h; this.bodyEl = p; this.dotsEl = dots; this.nextEl = next;
      if (this.host) this.host.appendChild(wrap);
      this._render();
    }

    _render() {
      const step = this.steps[this.idx];
      this.titleEl.textContent = step.title;
      this.bodyEl.textContent = step.body;
      this.nextEl.textContent = this.idx >= this.steps.length - 1 ? 'Got it' : 'Next';
      this.dotsEl.replaceChildren();
      for (let i = 0; i < this.steps.length; i++) {
        const d = document.createElement('span');
        d.className = 'cinema-spotlight-dot' + (i === this.idx ? ' active' : '');
        this.dotsEl.appendChild(d);
      }
    }

    _advance() { if (this.idx >= this.steps.length - 1) { this._finish(); return; } this.idx++; this._render(); }
    _finish() { this._markSeen(); if (this.el && this.el.remove) this.el.remove(); this.el = null; if (typeof this.opts.onDone === 'function') this.opts.onDone(); }
    destroy() { if (this.el && this.el.remove) this.el.remove(); this.el = null; }
  }

  const api = { buildSceneSummary, SceneSummaryRibbon, Spotlight };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
