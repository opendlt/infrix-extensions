/**
 * Infrix Cinema — causal autoplay (Wave G / G1).
 *
 * It's called Cinema; this is the movie. The director loop walks the ordered
 * narrative events and, for each, flies the camera to that stage's node(s),
 * spotlights them (dimming the rest), advances the replay head, and surfaces a
 * lower-third caption — ending on the anchor-confirmation beat. A novice presses
 * one button and watches the whole governed action explain itself, no clicks.
 *
 * The data already knows the storyline (narrative stages + causal edges), so the
 * film is auto-directed from the scene; nothing is scripted by hand.
 *
 * `buildShotList(events, graph)` is pure + unit-tested; the class is the driver.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  // What each spine stage proves — mirrors narrativePanel's C4 copy so the
  // caption and the card agree.
  const STAGE_PROVES = {
    intent: 'a governed flow was opened by a named requester.',
    policy: 'the request was checked against an explicit rule before it ran.',
    approval: 'the approval is bound to the exact plan that executed.',
    execution: 'the governed steps ran (or halted) deterministically.',
    outcome: 'the committed result is the one the plan produced.',
    evidence: 'a portable bundle binds the plan, outcome, policy, and proof.',
    anchor: 'the evidence commitment is independently verifiable on L0.',
    witness: 'independent witnesses re-derived and signed the outcome.',
    disclosure: 'only the disclosed fields are visible; the rest stay sealed.',
  };

  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  /**
   * buildShotList turns the ordered narrative events into camera shots.
   * @returns {Array<{seq,stage,nodeIds,primaryNodeId,headline,proves,dwellMs}>}
   */
  function buildShotList(events, graph) {
    if (!events || !events.length) return [];
    const nodeMap = new Map();
    for (const n of toArray(graph && (graph.nodes || graph.Nodes))) nodeMap.set(n.id, n);
    return events.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0)).map((e) => {
      const ids = e.graphNodeIds || [];
      let primary = null;
      for (const id of ids) { const n = nodeMap.get(id); if (n && n.position) { primary = id; break; } }
      if (!primary && ids.length) primary = ids[0];
      const headline = e.headline || '';
      return {
        seq: e.sequence || 0,
        stage: e.stage,
        nodeIds: ids,
        primaryNodeId: primary,
        headline,
        proves: STAGE_PROVES[e.stage] || e.summary || '',
        dwellMs: Math.max(2200, headline.length * 45),
      };
    });
  }

  class Cinematic {
    constructor(opts) {
      opts = opts || {};
      this.renderer = opts.renderer;
      this.timeline = opts.timeline;
      this.sync = opts.sync;
      this.onAnchor = opts.onAnchor;            // fired when a shot reaches the anchor stage
      this.getSpeed = opts.getSpeed || (() => 1);
      this.onChange = opts.onChange || (() => {}); // notify host (button label)
      this.shots = [];
      this.idx = -1;
      this.playing = false;
      this._timer = null;
      this._buildCaption(opts.captionHost);
    }

    _buildCaption(host) {
      const el = document.createElement('div');
      el.className = 'cinema-caption hidden';
      el.id = 'cinema-caption';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const h = document.createElement('div'); h.className = 'cinema-caption-headline';
      const p = document.createElement('div'); p.className = 'cinema-caption-proves';
      el.appendChild(h); el.appendChild(p);
      this.captionEl = el; this.captionHeadline = h; this.captionProves = p;
      if (host) host.appendChild(el);
    }

    setShots(events, graph) { this.shots = buildShotList(events, graph); }
    isPlaying() { return this.playing; }
    hasStory() { return this.shots.length > 0; }
    togglePlay() { this.playing ? this.pause() : this.play(); }

    play() {
      if (!this.shots.length) return;
      this.playing = true;
      if (this.idx < 0 || this.idx >= this.shots.length) this.idx = 0;
      this._runShot(this.idx);
      this._schedule();
      this.onChange(true);
    }

    pause() { this.playing = false; this._clearTimer(); this.onChange(false); }

    next() { this._clearTimer(); this.idx = Math.min(this.shots.length - 1, this.idx + 1); this._runShot(this.idx); if (this.playing) this._schedule(); }
    prev() { this._clearTimer(); this.idx = Math.max(0, this.idx - 1); this._runShot(this.idx); if (this.playing) this._schedule(); }

    _schedule() {
      this._clearTimer();
      const shot = this.shots[this.idx];
      if (!shot) return;
      const speed = this.getSpeed() || 1;
      this._timer = setTimeout(() => {
        if (!this.playing) return;
        if (this.idx >= this.shots.length - 1) { this.pause(); return; } // hold on the last frame
        this.idx++;
        this._runShot(this.idx);
        this._schedule();
      }, Math.max(400, shot.dwellMs / speed));
    }

    _runShot(i) {
      const shot = this.shots[i];
      if (!shot) return;
      if (this.timeline && this.timeline.seek) { try { this.timeline.seek(shot.seq); } catch (e) {} }
      if (this.sync && this.sync.highlightNodes) this.sync.highlightNodes(shot.nodeIds);
      if (this.renderer && this.renderer.flyTo && shot.primaryNodeId) this.renderer.flyTo(shot.primaryNodeId, { zoom: 1.5, duration: 520 });
      this._setCaption(shot.headline, shot.proves);
      if (shot.stage === 'anchor' && typeof this.onAnchor === 'function') this.onAnchor();
    }

    _setCaption(headline, proves) {
      this.captionHeadline.textContent = headline || '';
      this.captionProves.textContent = proves ? ('Proves: ' + proves) : '';
      this.captionEl.classList.remove('hidden');
    }

    /** exit leaves cinematic mode: stop, clear caption, restore free camera. */
    exit() {
      this.pause();
      this.idx = -1;
      if (this.captionEl) this.captionEl.classList.add('hidden');
      if (this.sync && this.sync.clearHighlight) this.sync.clearHighlight();
    }

    _clearTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
    destroy() { this._clearTimer(); if (this.captionEl && this.captionEl.remove) this.captionEl.remove(); }
  }

  const api = { Cinematic, buildShotList };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
