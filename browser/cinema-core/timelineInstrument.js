/**
 * Infrix Cinema — timeline as an instrument (Wave J / J3).
 *
 * The scrubber stops being a dumb slider: it shows WHEN things happened (event
 * density), WHEN trust became real (the climb to L0), WHERE the trouble was
 * (failures), chapter markers at stage boundaries, and "moments that matter"
 * auto-bookmarks. Pure builders + a thin overlay drawn into the scrubber wrap.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  const ASR_ORDER = ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness'];
  function rank(id) { const i = ASR_ORDER.indexOf(id); return i < 0 ? 0 : i; }

  const STAGE_LABEL = { intent: 'Intent', policy: 'Policy', approval: 'Approval', execution: 'Execution', outcome: 'Outcome', evidence: 'Evidence', anchor: 'Anchor', witness: 'Witness', disclosure: 'Disclosure' };

  function lastSeq(events) { return events.reduce((m, e) => Math.max(m, e.sequence || 0), 0); }

  /** buildEventDensity → counts per bin across [0, total]. */
  function buildEventDensity(events, total, bins) {
    bins = bins || 24;
    total = total || lastSeq(events) || 1;
    const out = new Array(bins).fill(0);
    for (const e of events) {
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((e.sequence || 0) / total) * bins)));
      out[b]++;
    }
    return out;
  }

  /** buildTrustTrack → the assurance ceiling AT each event sequence (it climbs). */
  function buildTrustTrack(events) {
    const sorted = events.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    let cur = 'offline';
    return sorted.map((e) => {
      if (rank(e.assurance) > rank(cur)) cur = e.assurance;
      return { seq: e.sequence || 0, ceiling: cur };
    });
  }

  /** buildAnomalyTrack → "trouble" markers: failed/anomalous events. */
  function buildAnomalyTrack(events) {
    return events.filter((e) => e.status === 'failed' || e.anomaly).map((e) => ({ seq: e.sequence || 0, status: e.status || 'anomaly' }));
  }

  /** buildChapters → stage-boundary markers. */
  function buildChapters(events) {
    const sorted = events.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    const out = []; let last = null;
    for (const e of sorted) { if (e.stage !== last) { out.push({ seq: e.sequence || 0, stage: e.stage, label: STAGE_LABEL[e.stage] || e.stage }); last = e.stage; } }
    return out;
  }

  /** momentsThatMatter → the few sequences worth jumping to. */
  function momentsThatMatter(events) {
    const firstFailure = events.find((e) => e.status === 'failed');
    const anchor = events.find((e) => e.stage === 'anchor');
    return {
      firstFailure: firstFailure ? (firstFailure.sequence || 0) : null,
      anchor: anchor ? (anchor.sequence || 0) : null,
    };
  }

  const RUNG_COLOR = { offline: 'var(--cinema-aura-offline,#6b7088)', replay: 'var(--cinema-aura-replay,#5cd4e4)', l0: 'var(--cinema-aura-l0,#ffd700)', witness: 'var(--cinema-aura-witness,#00c853)' };

  /** TimelineInstrument renders the tracks above a scrubber wrap element. */
  class TimelineInstrument {
    constructor(hostEl) {
      const el = document.createElement('div');
      el.className = 'cinema-tl-instrument';
      el.setAttribute('aria-hidden', 'true');
      const density = document.createElement('div'); density.className = 'cinema-tl-density';
      const trust = document.createElement('div'); trust.className = 'cinema-tl-trust';
      el.appendChild(density); el.appendChild(trust);
      this.el = el; this.densityEl = density; this.trustEl = trust;
      if (hostEl) hostEl.insertBefore(el, hostEl.firstChild);
    }
    render(events, total) {
      total = total || lastSeq(events) || 1;
      // density bars
      const dens = buildEventDensity(events, total, 24);
      const max = Math.max(1, ...dens);
      this.densityEl.replaceChildren();
      for (const d of dens) {
        const bar = document.createElement('span');
        bar.className = 'cinema-tl-bar';
        bar.style.height = Math.round((d / max) * 100) + '%';
        this.densityEl.appendChild(bar);
      }
      // trust track segments
      const track = buildTrustTrack(events);
      this.trustEl.replaceChildren();
      for (let i = 0; i < track.length; i++) {
        const seg = document.createElement('span');
        seg.className = 'cinema-tl-seg';
        const start = (track[i].seq / total) * 100;
        const end = i < track.length - 1 ? (track[i + 1].seq / total) * 100 : 100;
        seg.style.left = start + '%';
        seg.style.width = Math.max(0, end - start) + '%';
        seg.style.background = RUNG_COLOR[track[i].ceiling] || RUNG_COLOR.offline;
        this.trustEl.appendChild(seg);
      }
    }
    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  const api = { buildEventDensity, buildTrustTrack, buildAnomalyTrack, buildChapters, momentsThatMatter, TimelineInstrument };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
