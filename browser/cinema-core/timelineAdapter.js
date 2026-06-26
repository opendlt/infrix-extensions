/**
 * Infrix Cinema — timeline adapter.
 *
 * Bridges the canonical controls to whatever a data source can offer:
 *  - live WS sources drive the backend (play/pause/seek over the socket);
 *  - replay/proof sources re-derive a scene at a block/seq via getStateAt.
 * Keeps a single notion of "current position / total / speed / playing" so the
 * scrubber behaves identically in every mode.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  class TimelineAdapter {
    constructor(opts) {
      this.opts = opts || {};
      this.dataSource = opts.dataSource;
      this.renderer = opts.renderer;
      this.state = { currentSeq: 0, totalSeq: 0, speed: 1, playing: false };
      this.loop = false;
      this._timer = null;
    }

    async refresh() {
      if (!this.dataSource || !this.dataSource.getTimeline) return;
      const tl = await this.dataSource.getTimeline();
      if (tl) Object.assign(this.state, tl);
    }

    // setTotal lets the host raise the scrubber range to the narrative length
    // when the data source reports no timeline of its own (static proof scenes).
    setTotal(n) { if (n != null && n > (this.state.totalSeq || 0)) this.state.totalSeq = n; }

    setSpeed(n) {
      this.state.speed = n || 1;
      const caps = this.dataSource && this.dataSource.capabilities ? this.dataSource.capabilities() : {};
      if (caps.live && this.dataSource.client && this.dataSource.client.setSpeed) this.dataSource.client.setSpeed(this.state.speed);
      if (this._timer) { clearInterval(this._timer); this._timer = setInterval(() => this.stepForward(), Math.max(120, 600 / (this.state.speed || 1))); }
    }

    setLoop(on) { this.loop = !!on; }

    togglePlay() { this.state.playing ? this.pause() : this.play(); }

    play() {
      this.state.playing = true;
      const caps = this.dataSource.capabilities ? this.dataSource.capabilities() : {};
      if (caps.live && this.dataSource.client) { this.dataSource.client.play(); return; }
      // Local replay stepping for proof/replay sources.
      this._timer = setInterval(() => this.stepForward(), Math.max(150, 600 / (this.state.speed || 1)));
    }
    pause() {
      this.state.playing = false;
      const caps = this.dataSource.capabilities ? this.dataSource.capabilities() : {};
      if (caps.live && this.dataSource.client) { this.dataSource.client.pause(); }
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    async stepForward() { await this.seek((this.state.currentSeq || 0) + 1); }
    async stepBackward() { await this.seek(Math.max(0, (this.state.currentSeq || 0) - 1)); }

    async seek(pos) {
      this.state.currentSeq = pos;
      // Notify subscribers (e.g. the narrative panel) of the new replay head so
      // the audit story dims future events in lockstep with the canvas.
      if (typeof this.opts.onPosition === 'function') {
        try { this.opts.onPosition(pos, this.state); } catch (e) {}
      }
      const caps = this.dataSource.capabilities ? this.dataSource.capabilities() : {};
      if (caps.live && this.dataSource.client) { this.dataSource.client.seek(pos, pos); return; }
      if (this.dataSource.getStateAt) {
        const g = await this.dataSource.getStateAt(pos);
        if (g && this.renderer) this.renderer.setSceneGraph(g);
      }
      // At the end: loop back to the start, or stop the local replay timer.
      if (pos >= (this.state.totalSeq || 0) && this._timer) {
        if (this.loop) this.seek(0);
        else this.pause();
      }
    }

    destroy() { if (this._timer) clearInterval(this._timer); }
  }

  ns.TimelineAdapter = TimelineAdapter;
  if (typeof module !== 'undefined' && module.exports) module.exports = { TimelineAdapter };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
