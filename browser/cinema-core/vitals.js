/**
 * Infrix Cinema — vitals strip (Wave J / J1).
 *
 * Replaces the raw "Block / Gas / Nodes / Edges" telemetry footer with POSTURE:
 * throughput, breaker health, anomaly count, trust ceiling, and sealed/disclosable
 * — each click-jumps to the nodes it's about. An operator reads the system's
 * health in one glance instead of parsing numbers.
 *
 * `computeVitals(graph, history)` is pure + unit-tested; the class is the strip.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  /**
   * computeVitals derives operator posture from the scene + a small sample
   * history ([{t, gas, edges}], oldest first) for rates.
   */
  function computeVitals(graph, history) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const edges = toArray(graph && (graph.edges || graph.Edges));
    let throttled = 0, paused = 0, frozen = 0, anomalies = 0, sealed = 0, disclosable = 0, totalGas = 0;
    for (const n of nodes) {
      if (n.breakerState === 'throttled') throttled++;
      else if (n.breakerState === 'paused') paused++;
      else if (n.breakerState === 'frozen') frozen++;
      if (n.anomalyScore > 0 || n.breakerState === 'frozen') anomalies++;
      if (n.redacted) { sealed++; if (n.grantId) disclosable++; }
    }
    for (const e of edges) totalGas += (e.gasCost || 0);
    const block = graph ? (graph.blockHeight || graph.BlockHeight || 0) : 0;

    let gasRate = 0, opsRate = 0;
    if (history && history.length >= 2) {
      const a = history[0], b = history[history.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0) { gasRate = Math.max(0, (b.gas - a.gas) / dt); opsRate = Math.max(0, (b.edges - a.edges) / dt); }
    }
    return { block, breakers: { throttled, paused, frozen }, anomalies, sealed, disclosable, totalGas, gasRate, opsRate, nodes: nodes.length, edges: edges.length };
  }

  function fmtRate(n) { if (n >= 1000) return (n / 1000).toFixed(1) + 'k'; return Math.round(n).toString(); }

  class VitalsStrip {
    constructor(hostEl, opts) {
      this.host = hostEl;
      this.opts = opts || {};
      this._build();
    }
    _build() {
      const el = document.createElement('div');
      el.className = 'cinema-vitals';
      el.id = 'cinema-vitals';
      el.setAttribute('role', 'status');
      this.el = el;
      if (this.host) this.host.appendChild(el);
    }
    _pill(cls, text, title, onClick) {
      const b = document.createElement(onClick ? 'button' : 'span');
      b.className = 'cinema-vital ' + cls;
      if (onClick) { b.type = 'button'; b.addEventListener('click', onClick); }
      if (title) b.title = title;
      b.textContent = text;
      return b;
    }
    setVitals(v, ceiling) {
      if (!this.el) return;
      const jump = this.opts.onJump || (() => {});
      const el = this.el;
      el.replaceChildren();
      // block + throughput
      el.appendChild(this._pill('v-block', 'block ' + (v.block || 0)));
      el.appendChild(this._pill('v-rate', fmtRate(v.gasRate) + ' gas/s'));
      el.appendChild(this._pill('v-rate', fmtRate(v.opsRate) + ' ops/s'));
      // breaker pips
      const bk = v.breakers || {};
      if (bk.throttled) el.appendChild(this._pill('v-breaker v-throttled', bk.throttled + ' throttled', 'Throttled circuit breakers', () => jump('breaker:throttled')));
      if (bk.paused) el.appendChild(this._pill('v-breaker v-paused', bk.paused + ' paused', 'Paused circuit breakers', () => jump('breaker:paused')));
      if (bk.frozen) el.appendChild(this._pill('v-breaker v-frozen', bk.frozen + ' frozen', 'Frozen circuit breakers', () => jump('breaker:frozen')));
      // anomalies
      el.appendChild(this._pill('v-anom' + (v.anomalies ? ' v-alert' : ''), (v.anomalies || 0) + ' anomal' + (v.anomalies === 1 ? 'y' : 'ies'), 'Anomalous nodes', v.anomalies ? () => jump('anomaly') : null));
      // sealed / disclosable
      if (v.sealed) el.appendChild(this._pill('v-sealed', '🔒 ' + v.sealed + (v.disclosable ? ' · ' + v.disclosable + ' open' : ''), 'Sealed values' + (v.disclosable ? ' (some disclosable to you)' : ''), () => jump('sealed')));
      // trust ceiling chip
      const c = ceiling || 'offline';
      const trust = this._pill('v-trust', '⛓ ' + (RUNG_LABEL[c] || c), 'Trust ceiling', () => jump('trust'));
      trust.dataset.assurance = c;
      el.appendChild(trust);
    }
    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }
  const RUNG_LABEL = { offline: 'Offline', replay: 'Replay', l0: 'L0', witness: 'Witness' };

  const api = { computeVitals, VitalsStrip };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
