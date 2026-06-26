/**
 * Infrix Cinema — Trust Ladder (Tier C / C1).
 *
 * THE single, shared assurance display. Before this, the proof rail had one
 * badge treatment and the narrative receipt had another; both are replaced by
 * this component so every surface tells the SAME capped-assurance story:
 *
 *   Offline (structural) → Replay-verified → L0-anchored → Witness-quorum
 *
 * Rendered as a horizontal 4-stop connected meter, filled up to the level the
 * bundle actually backs (the "ceiling"), with the ceiling rung haloed and
 * un-backed rungs dashed/dim. Cardinal rule (mirrors proofPanel/narrative):
 * NEVER mark a rung backed without its evidence present.
 *
 * `buildLadder(proof)` is pure + unit-tested; the class is the DOM shell.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  const ORDER = ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness'];
  const LABEL = { offline: 'Offline', replay: 'Replay', l0: 'L0 anchor', witness: 'Witness' };

  function assuranceDef(id) {
    const A = ns.ASSURANCE || {};
    return Object.values(A).find((a) => a.id === id) || { id, label: id, note: '' };
  }
  function rank(id) { const i = ORDER.indexOf(id); return i < 0 ? 0 : i; }

  // proofFacts — the assurance-bearing facts a bundle carries (mirror of
  // narrativeTemplates.proofFacts / proofPanel.capAssurance, kept honest).
  function proofFacts(proof) {
    proof = proof || {};
    const has = (k) => proof[k] && (Array.isArray(proof[k]) ? proof[k].length : true);
    const anchored = !!(proof.anchor && (proof.anchor.block || proof.anchor.txHash || proof.anchor.confirmed))
      || !!(proof.assurance && rank(proof.assurance.id) >= rank('l0'));
    const witnessed = !!has('witness') || !!(proof.assurance && rank(proof.assurance.id) >= rank('witness'));
    const hasReplay = !!(proof.replay || proof.frames);
    return { anchored, witnessed, hasReplay };
  }

  /**
   * buildLadder derives the ceiling + per-rung backing from a proof bundle.
   * @returns {{ceilingId, ceilingRank, rungs:[{id,label,note,backed,isCeiling}]}}
   */
  function buildLadder(proof) {
    const f = proofFacts(proof);
    let ceilingId = 'offline';        // a bundle is always at least structurally consistent
    if (f.hasReplay) ceilingId = 'replay';
    if (f.anchored) ceilingId = 'l0';
    if (f.anchored && f.witnessed) ceilingId = 'witness';
    const ceilingRank = rank(ceilingId);
    const rungs = ORDER.map((id) => ({
      id,
      label: LABEL[id] || id,
      note: assuranceDef(id).note || '',
      backed: rank(id) <= ceilingRank,
      isCeiling: id === ceilingId,
    }));
    return { ceilingId, ceilingRank, rungs };
  }

  class TrustLadder {
    constructor(hostEl, opts) {
      this.host = hostEl;
      this.opts = opts || {};
      this.model = buildLadder(this.opts.proof || {});
      this._rungEls = new Map();
      this._build();
    }

    _build() {
      const wrap = document.createElement('div');
      wrap.className = 'cinema-trust-ladder' + (this.opts.compact ? ' compact' : '');
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Trust ladder — how strongly this is backed');
      this.el = wrap;
      this._render();
      if (this.host) this.host.appendChild(wrap);
    }

    _render() {
      this.el.replaceChildren();
      this._rungEls.clear();
      const cap = assuranceDef(this.model.ceilingId);
      const head = document.createElement('div');
      head.className = 'cinema-trust-head';
      head.textContent = 'Verified to: ' + (cap.label || this.model.ceilingId);
      head.dataset.assurance = this.model.ceilingId;
      this.el.appendChild(head);

      const track = document.createElement('div');
      track.className = 'cinema-trust-track';
      this.model.rungs.forEach((r, i) => {
        if (i > 0) {
          const link = document.createElement('span');
          link.className = 'cinema-trust-link' + (r.backed ? ' backed' : '');
          track.appendChild(link);
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cinema-trust-rung' + (r.backed ? ' backed' : '') + (r.isCeiling ? ' ceiling' : '');
        b.dataset.assurance = r.id;
        b.title = (r.label + (r.backed ? '' : ' — not in this bundle') + (r.note ? '\n' + r.note : ''));
        b.setAttribute('aria-label', r.label + (r.backed ? ' (backed)' : ' (not backed)') + (r.note ? '. ' + r.note : ''));
        b.setAttribute('aria-pressed', r.isCeiling ? 'true' : 'false');
        const dot = document.createElement('span'); dot.className = 'cinema-trust-dot';
        const lab = document.createElement('span'); lab.className = 'cinema-trust-label'; lab.textContent = r.label;
        b.appendChild(dot); b.appendChild(lab);
        b.addEventListener('click', () => { if (typeof this.opts.onRungClick === 'function') this.opts.onRungClick(r.id, r); });
        track.appendChild(b);
        this._rungEls.set(r.id, b);
      });
      this.el.appendChild(track);
    }

    setProof(proof) { this.model = buildLadder(proof || {}); this._render(); }

    /** pulse flashes a rung (the anchor-confirmation moment lights 'l0'). */
    pulse(rungId) {
      const b = this._rungEls.get(rungId);
      if (!b) return;
      b.classList.remove('pulse');
      // force reflow so re-adding the class restarts the animation
      void b.offsetWidth;
      b.classList.add('pulse');
    }

    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  const api = { TrustLadder, buildLadder, ladderProofFacts: proofFacts };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
