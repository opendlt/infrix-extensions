/**
 * Infrix Cinema — canonical control bar.
 *
 * One control vocabulary for every surface: play/pause, step, scrubber, zoom
 * reset, fit, details, filter/search, legend, export. The set actually shown
 * is gated by mode capabilities (embed shows none; proof shows replay + export
 * + legend; nexus/full show the full bar). This guarantees a control means the
 * same thing wherever Cinema is mounted.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  class CinemaControls {
    constructor(hostEl, opts) {
      this.host = hostEl;
      this.opts = opts || {};
      this.caps = this.opts.capabilities || {};
      this.handlers = this.opts.handlers || {};
      this.el = null;
      this.build();
    }

    build() {
      const bar = document.createElement('div');
      bar.className = 'cinema-controls';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Cinema controls');

      // Playback (live or replay only).
      if (this.caps.controls && (this.caps.live || this.caps.replay)) {
        bar.appendChild(this.btn('cinema-btn-playpause', '▶', 'Play / pause', () => this.fire('togglePlay')));
        bar.appendChild(this.btn('cinema-btn-step-back', '⏮', 'Step back', () => this.fire('stepBack')));
        bar.appendChild(this.btn('cinema-btn-step-fwd', '⏭', 'Step forward', () => this.fire('stepForward')));
      }

      // View controls (always except embed).
      if (this.caps.controls) {
        bar.appendChild(this.btn('cinema-btn-fit', '⤢', 'Fit to view', () => this.fire('fit')));
        bar.appendChild(this.btn('btn-zoom-reset', '⊙', 'Reset zoom', () => this.fire('resetView')));
      }

      // Search / filter.
      if (this.caps.controls) {
        const search = document.createElement('input');
        search.type = 'search';
        search.id = 'cinema-search';
        search.className = 'cinema-search';
        search.placeholder = 'Filter nodes…';
        search.setAttribute('aria-label', 'Filter nodes by label or kind');
        search.addEventListener('input', () => this.fire('filter', search.value));
        bar.appendChild(search);
      }

      // Legend toggle (always — explains the symbols).
      bar.appendChild(this.btn('cinema-btn-legend', 'Legend', 'Toggle legend', () => this.fire('toggleLegend')));

      // Export / share (everything except embed).
      if (this.caps.controls || this.caps.replay) {
        bar.appendChild(this.btn('btn-screenshot', 'Export', 'Export / share', () => this.fire('export')));
      }

      this.el = bar;
      if (this.host) this.host.appendChild(bar);
    }

    btn(id, label, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.className = 'cinema-btn';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    }

    setPlaying(playing) {
      const b = this.el && this.el.querySelector('#cinema-btn-playpause');
      if (b) b.textContent = playing ? '⏸' : '▶';
    }

    fire(name, arg) { const h = this.handlers[name]; if (h) h(arg); }
  }

  ns.CinemaControls = CinemaControls;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaControls };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
