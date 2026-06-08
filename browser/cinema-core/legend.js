/**
 * Infrix Cinema — legend.
 *
 * Renders the canonical visual vocabulary (node kinds, edge kinds, status /
 * disclosure / anchor / approval / trust / replay / anomaly states) so a
 * viewer can read the scene. The same legend renders on every surface; it is
 * the human-facing twin of visualVocabulary.js.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  // Curated legend rows: [label, colorKey, shape, note]. We surface the
  // semantically important states rather than all ~40 kinds, grouped by family.
  const LEGEND_ROWS = [
    ['Contract / account', 'Normal', 'circle', 'Healthy execution node'],
    ['Throttled', 'Throttled', 'circle', 'Circuit breaker throttling'],
    ['Paused', 'Paused', 'circle', 'Circuit breaker paused'],
    ['Frozen', 'Frozen', 'circle', 'Circuit breaker frozen'],
    ['Anomaly', 'Anomaly', 'circle', 'Anomalous activity'],
    ['Private (redacted)', 'Encrypted', 'circle', '🔒 hidden by disclosure policy'],
    ['Intent', 'Intent', 'arrow', 'Lifecycle: submitted intent'],
    ['Outcome', 'Outcome', 'circle', 'Lifecycle: produced outcome'],
    ['Approval pending', 'ApprovalPending', 'gate', 'Awaiting approvals'],
    ['Approval granted', 'ApprovalGranted', 'gate', 'Approval satisfied'],
    ['Policy allow', 'PolicyAllow', 'octagon', 'Policy permitted'],
    ['Policy deny', 'PolicyDeny', 'octagon', 'Policy denied'],
    ['Evidence', 'Evidence', 'document', 'Evidence bundle'],
    ['Evidence anchored', 'EvidenceAnchored', 'document', 'Anchored evidence'],
    ['Anchor (L0)', 'Anchor', 'diamond', 'Accumulate L0 anchor'],
    ['L0 bridge', 'L0Bridge', 'hexagon', 'Connection to Accumulate'],
    ['Disclosure grant', 'DisclosureGrant', 'diamond', 'Active disclosure grant'],
    ['Trust healthy', 'TrustHealthy', 'pentagon', 'Trust profile healthy'],
    ['Trust degraded', 'TrustDegraded', 'pentagon', 'Trust degraded'],
    ['Settlement', 'Settlement', 'circle', 'Settlement leg'],
    ['Escrow', 'Escrow', 'circle', 'Escrow account'],
  ];

  class CinemaLegend {
    constructor(hostEl) { this.host = hostEl; this.el = null; this.build(); this.hide(); }
    build() {
      const wrap = document.createElement('aside');
      wrap.className = 'cinema-legend hidden';
      wrap.id = 'cinema-legend';
      wrap.setAttribute('aria-label', 'Cinema legend');
      const h = document.createElement('h4'); h.textContent = 'Legend'; wrap.appendChild(h);
      const note = document.createElement('p');
      note.className = 'cinema-legend-note';
      note.textContent = 'Cinema visualizes canonical artifacts. It is not canonical truth.';
      wrap.appendChild(note);
      for (const [label, colorKey, shape, hint] of LEGEND_ROWS) {
        const row = document.createElement('div');
        row.className = 'cinema-legend-row';
        const sw = document.createElement('span');
        sw.className = 'cinema-legend-swatch cinema-shape-' + shape;
        const c = (ns.COLORS && ns.COLORS[colorKey]) || { r: 120, g: 140, b: 170, a: 255 };
        sw.style.background = ns.colorCss ? ns.colorCss(c) : `rgb(${c.r},${c.g},${c.b})`;
        const lab = document.createElement('span'); lab.className = 'cinema-legend-label'; lab.textContent = label;
        const hi = document.createElement('span'); hi.className = 'cinema-legend-hint'; hi.textContent = hint;
        row.appendChild(sw); row.appendChild(lab); row.appendChild(hi);
        wrap.appendChild(row);
      }
      this.el = wrap;
      if (this.host) this.host.appendChild(wrap);
    }
    toggle() { if (this.el) this.el.classList.toggle('hidden'); }
    show() { if (this.el) this.el.classList.remove('hidden'); }
    hide() { if (this.el) this.el.classList.add('hidden'); }
  }

  ns.CinemaLegend = CinemaLegend;
  ns.LEGEND_ROWS = LEGEND_ROWS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaLegend, LEGEND_ROWS };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
