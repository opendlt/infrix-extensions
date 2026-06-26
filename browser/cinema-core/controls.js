/**
 * Infrix Cinema — canonical control bar + transport (Tier A / A2, IA pass).
 *
 * One control vocabulary for every surface, organized so the bar reads as
 * INTENTIONAL rather than feature-stuffed:
 *
 *   TRANSPORT row  — the spine: scrubber with per-event ticks, time, speed,
 *                    loop, jump-to-failure.
 *   ACTION row     — hero actions always visible (▶ Play story, ✓ Verify, the
 *                    search box) plus three overflow menus that progressively
 *                    disclose the rest:
 *                      View ▾  — how the graph is drawn/framed: view mode,
 *                                layout engine, projection, fit/reset, minimap.
 *                      Ask ▾   — reframe for a need: role lens + question chips.
 *                      ⋯ More  — Plan vs Actual, Legend, Export.
 *
 * The set shown is still gated by mode capabilities (embed shows none; proof
 * shows replay + verify + export; nexus/full show everything) — a control
 * means the same thing wherever Cinema is mounted. The earlier bar exposed all
 * ~30 controls at once; grouping them into a hero set + menus is the
 * information-architecture pass that makes the same power feel calm.
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
      this.el = null;            // action row
      this.transportEl = null;   // transport row
      this.scrubber = null;
      this.ticksEl = null;
      this.timeEl = null;
      this.speed = 1;
      this.loop = false;
      this.position = { cur: 0, total: 0, block: 0 };
      this._menus = [];          // overflow popovers (View / Ask / More)
      this._proj = 'graph';
      this._layout = this.opts.initialLayout || 'auto';
      this._minimapOn = false;
      this._lensActive = '';
      this._chipActive = '';
      this._onKey = null;
      this._onDocClick = null;
      this._onDocKey = null;
      this.build();
    }

    build() {
      const playback = this.caps.controls && (this.caps.live || this.caps.replay);

      // ---- Transport row (scrubber + ticks + time + speed + loop) ----
      if (playback) {
        const t = document.createElement('div');
        t.className = 'cinema-transport';
        t.setAttribute('role', 'group');
        t.setAttribute('aria-label', 'Timeline transport');

        t.appendChild(this.btn('cinema-btn-playpause', '▶', 'Play / pause (Space)', () => this.fire('togglePlay')));
        t.appendChild(this.btn('cinema-btn-step-back', '⏮', 'Step back (←)', () => this.fire('stepBack')));
        t.appendChild(this.btn('cinema-btn-step-fwd', '⏭', 'Step forward (→)', () => this.fire('stepForward')));

        const scrubWrap = document.createElement('div');
        scrubWrap.className = 'cinema-scrubber-wrap';
        const ticks = document.createElement('div');
        ticks.className = 'cinema-scrubber-ticks';
        ticks.setAttribute('aria-hidden', 'true');
        const scrub = document.createElement('input');
        scrub.type = 'range';
        scrub.id = 'cinema-scrubber';
        scrub.className = 'cinema-scrubber';
        scrub.min = '0'; scrub.max = '0'; scrub.step = '1'; scrub.value = '0';
        scrub.setAttribute('aria-label', 'Timeline position');
        scrub.addEventListener('input', () => this.fire('seek', Number(scrub.value)));
        scrubWrap.appendChild(ticks);
        scrubWrap.appendChild(scrub);
        t.appendChild(scrubWrap);
        this.scrubber = scrub; this.ticksEl = ticks;

        const time = document.createElement('span');
        time.className = 'cinema-time';
        time.id = 'cinema-time';
        time.textContent = '—';
        t.appendChild(time);
        this.timeEl = time;

        // Jump to first failure — an auditor's fastest path to "what broke".
        t.appendChild(this.btn('cinema-btn-jump-fail', '⚑', 'Jump to first failure', () => this.fire('jumpFailure')));

        // Speed segmented control.
        const speeds = [0.5, 1, 2, 4];
        const speedGroup = document.createElement('div');
        speedGroup.className = 'cinema-speed';
        speedGroup.setAttribute('role', 'group');
        speedGroup.setAttribute('aria-label', 'Playback speed');
        this._speedBtns = [];
        for (const s of speeds) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'cinema-speed-btn' + (s === 1 ? ' active' : '');
          b.dataset.speed = String(s);
          b.textContent = s + '×';
          b.setAttribute('aria-pressed', s === 1 ? 'true' : 'false');
          b.addEventListener('click', () => { this.setSpeed(s); this.fire('setSpeed', s); });
          this._speedBtns.push(b);
          speedGroup.appendChild(b);
        }
        t.appendChild(speedGroup);

        const loopBtn = this.btn('cinema-btn-loop', '↻', 'Loop replay', () => { this.setLoop(!this.loop); this.fire('toggleLoop', this.loop); });
        t.appendChild(loopBtn);
        this._loopBtn = loopBtn;

        this.transportEl = t;
        if (this.host) this.host.appendChild(t);
      }

      // ---- Action row ----
      const bar = document.createElement('div');
      bar.className = 'cinema-controls';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Cinema controls');

      // --- Hero actions (always visible) ---
      // Cinematic autoplay (G1) — the headline "watch it explain itself" action.
      if (playback) {
        const story = this.btn('cinema-btn-story', '▶ Play story', 'Play the audit story (cinematic)', () => this.fire('playStory'));
        story.classList.add('cinema-btn-primary');
        this._storyBtn = story;
        bar.appendChild(story);
      }
      // "Verify it yourself" (H1) — the moat: re-check the bundle in-browser.
      if (this.opts.canVerify) {
        const verify = this.btn('cinema-btn-verify', '✓ Verify', 'Verify this bundle yourself (in your browser)', () => this.fire('verify'));
        verify.classList.add('cinema-btn-verify');
        bar.appendChild(verify);
      }

      if (this.caps.controls) {
        // --- Power search (B4): kind:/status:/gas: grammar + count + stepper. ---
        const sWrap = document.createElement('div');
        sWrap.className = 'cinema-search-wrap';
        const search = document.createElement('input');
        search.type = 'search';
        search.id = 'cinema-search';
        search.className = 'cinema-search';
        search.placeholder = 'Filter  (try kind:contract, status:frozen, gas:>1000)';
        search.setAttribute('aria-label', 'Filter nodes — supports kind:, status:, gas: and free text');
        search.addEventListener('input', () => this.fire('filter', search.value));
        search.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.fire(e.shiftKey ? 'searchPrev' : 'searchNext'); }
          else if (e.key === 'Escape') { e.preventDefault(); search.value = ''; this.fire('filter', ''); }
        });
        this.searchEl = search;
        sWrap.appendChild(search);

        const count = document.createElement('span');
        count.className = 'cinema-search-count hidden';
        count.id = 'cinema-search-count';
        count.setAttribute('aria-live', 'polite');
        sWrap.appendChild(count);
        this.searchCountEl = count;

        const nav = document.createElement('span');
        nav.className = 'cinema-search-nav hidden';
        const prev = this.btn('cinema-search-prev', '‹', 'Previous match (Shift+Enter)', () => this.fire('searchPrev'));
        const next = this.btn('cinema-search-next', '›', 'Next match (Enter)', () => this.fire('searchNext'));
        prev.classList.add('cinema-search-navbtn'); next.classList.add('cinema-search-navbtn');
        nav.appendChild(prev); nav.appendChild(next);
        sWrap.appendChild(nav);
        this.searchNavEl = nav;

        bar.appendChild(sWrap);

        // --- View ▾ — how the graph is drawn and framed. ---
        const viewMenu = this._makeMenu('cinema-menu-view', 'View', 'View — layout, projection, framing');
        bar.appendChild(viewMenu.wrap);

        // View mode (graph | narrative | split) — was a floating top-left toggle.
        if (this.opts.showViewMode !== false) {
          const sec = this._section(viewMenu.panel, 'Panels');
          const group = document.createElement('div');
          group.className = 'cinema-view-toggle';
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', 'View mode');
          this._viewBtns = [];
          const initialView = this.opts.initialView || 'split';
          for (const [m, label] of [['graph', 'Graph'], ['narrative', 'Story'], ['split', 'Split']]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cinema-view-btn' + (m === initialView ? ' active' : '');
            b.dataset.view = m;
            b.textContent = label;
            b.setAttribute('aria-pressed', m === initialView ? 'true' : 'false');
            b.addEventListener('click', () => this.fire('setView', m));
            this._viewBtns.push(b);
            group.appendChild(b);
          }
          sec.appendChild(group);
        }

        // Layout engine selector (A1) — Auto / Spine / Force.
        {
          const sec = this._section(viewMenu.panel, 'Layout');
          const layoutGroup = document.createElement('div');
          layoutGroup.className = 'cinema-layout-toggle';
          layoutGroup.setAttribute('role', 'group');
          layoutGroup.setAttribute('aria-label', 'Layout');
          const engines = [['auto', 'Auto'], ['spine', 'Spine'], ['force', 'Force']];
          this._layoutBtns = [];
          for (const [eng, label] of engines) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cinema-layout-btn' + (eng === this._layout ? ' active' : '');
            b.dataset.engine = eng;
            b.textContent = label;
            b.title = label + ' layout';
            b.setAttribute('aria-pressed', eng === this._layout ? 'true' : 'false');
            b.addEventListener('click', () => { this.setLayout(eng); this.fire('layout', eng); });
            this._layoutBtns.push(b);
            layoutGroup.appendChild(b);
          }
          sec.appendChild(layoutGroup);
        }

        // Alternative projections (J4) — Graph / Flow / Matrix.
        {
          const sec = this._section(viewMenu.panel, 'Projection');
          const projGroup = document.createElement('div');
          projGroup.className = 'cinema-proj-toggle';
          projGroup.setAttribute('role', 'group');
          projGroup.setAttribute('aria-label', 'Projection');
          this._projBtns = [];
          for (const [pmode, label] of [['graph', 'Graph'], ['sankey', 'Flow'], ['matrix', 'Matrix']]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cinema-proj-btn' + (pmode === 'graph' ? ' active' : '');
            b.dataset.proj = pmode;
            b.textContent = label;
            b.setAttribute('aria-pressed', pmode === 'graph' ? 'true' : 'false');
            b.addEventListener('click', () => { this.setProjection(pmode); this.fire('projection', pmode); });
            this._projBtns.push(b);
            projGroup.appendChild(b);
          }
          sec.appendChild(projGroup);
        }

        // Framing — fit / reset / minimap.
        {
          const sec = this._section(viewMenu.panel, 'Frame');
          const row = document.createElement('div');
          row.className = 'cinema-menu-row';
          row.appendChild(this.btn('cinema-btn-fit', 'Fit to view', 'Fit to view', () => this.fire('fit')));
          row.appendChild(this.btn('btn-zoom-reset', 'Reset zoom', 'Reset zoom', () => this.fire('resetView')));
          sec.appendChild(row);
          const mini = this.btn('cinema-btn-minimap', 'Minimap', 'Toggle the minimap navigator', () => {
            this.setMinimapActive(!this._minimapOn);
            this.fire('toggleMinimap', this._minimapOn);
          });
          mini.classList.add('cinema-toggle-btn');
          this._minimapBtn = mini;
          sec.appendChild(mini);
        }

        // --- Ask ▾ — reframe the same scene for a need (lens + question chips). ---
        const hasLens = !!ns.LENSES;
        const hasChips = !!(ns.SMART_FILTERS && ns.SMART_FILTERS.length);
        if (hasLens || hasChips) {
          const askMenu = this._makeMenu('cinema-menu-ask', 'Ask', 'Ask — reframe for your role or a question');
          bar.appendChild(askMenu.wrap);
          this._askMenu = askMenu;

          // Role lens (K1) — reframe the same scene for a role.
          if (hasLens) {
            const sec = this._section(askMenu.panel, 'View as role');
            const lensWrap = document.createElement('label');
            lensWrap.className = 'cinema-lens-wrap';
            const sel = document.createElement('select'); sel.id = 'cinema-lens'; sel.className = 'cinema-lens-select';
            const none = document.createElement('option'); none.value = ''; none.textContent = 'Everyone'; sel.appendChild(none);
            for (const role of ['auditor', 'operator', 'regulator', 'agentDev']) {
              const o = document.createElement('option'); o.value = role; o.textContent = (ns.LENSES[role] && ns.LENSES[role].label) || role; sel.appendChild(o);
            }
            sel.addEventListener('change', () => this.fire('lens', sel.value));
            this._lensSel = sel;
            lensWrap.appendChild(sel);
            sec.appendChild(lensWrap);
          }

          // Question-based smart chips (K2) — one-tap answers over the scene.
          if (hasChips) {
            const sec = this._section(askMenu.panel, 'Quick questions');
            const chips = document.createElement('div');
            chips.className = 'cinema-smart-chips';
            this._smartChips = new Map();
            for (const f of ns.SMART_FILTERS) {
              const c = document.createElement('button');
              c.type = 'button'; c.className = 'cinema-smart-chip'; c.dataset.smart = f.id; c.textContent = f.label;
              c.addEventListener('click', () => this.fire('smartFilter', f.id));
              this._smartChips.set(f.id, c);
              chips.appendChild(c);
            }
            sec.appendChild(chips);
          }
        }

        // --- ⋯ More — Plan vs Actual, Legend, Export. ---
        const moreMenu = this._makeMenu('cinema-menu-more', '⋯', 'More — compare, legend, export', { compact: true });
        bar.appendChild(moreMenu.wrap);

        // Plan vs Actual (I1) — enabled only when a captured plan is present.
        const drift = this.btn('cinema-btn-drift', '⧉ Plan vs Actual', 'Compare what was predicted with what actually happened', () => { this._closeMenus(); this.fire('toggleDrift'); });
        drift.classList.add('cinema-menu-item');
        drift.disabled = true;
        this._driftBtn = drift;
        moreMenu.panel.appendChild(drift);

        const legendBtn = this.btn('cinema-btn-legend', 'Legend', 'Toggle legend', () => { this._closeMenus(); this.fire('toggleLegend'); });
        legendBtn.classList.add('cinema-menu-item');
        moreMenu.panel.appendChild(legendBtn);

        const exportBtn = this.btn('btn-screenshot', 'Export / share', 'Export / share', () => { this._closeMenus(); this.fire('export'); });
        exportBtn.classList.add('cinema-menu-item');
        moreMenu.panel.appendChild(exportBtn);
      }

      this.el = bar;
      if (this.host) this.host.appendChild(bar);

      // Dismiss any open menu on outside click / Escape.
      if (this._menus.length) {
        this._onDocClick = () => this._closeMenus();
        this._onDocKey = (e) => { if (e.key === 'Escape') this._closeMenus(); };
        document.addEventListener('click', this._onDocClick);
        document.addEventListener('keydown', this._onDocKey);
      }

      // Keyboard transport (Space / arrows / Home / End), ignored while typing.
      if (playback) {
        this._onKey = (e) => this._handleKey(e);
        document.addEventListener('keydown', this._onKey);
      }
    }

    // ---- Overflow-menu primitive ----------------------------------------
    _makeMenu(id, label, title, opts) {
      opts = opts || {};
      const wrap = document.createElement('div');
      wrap.className = 'cinema-menu';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = id;
      btn.className = 'cinema-btn cinema-menu-btn' + (opts.compact ? ' cinema-menu-btn-compact' : '');
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      const lab = document.createElement('span'); lab.className = 'cinema-menu-label'; lab.textContent = label;
      btn.appendChild(lab);
      if (!opts.compact) {
        const car = document.createElement('span'); car.className = 'cinema-menu-caret'; car.textContent = '▾'; car.setAttribute('aria-hidden', 'true');
        btn.appendChild(car);
      }

      const panel = document.createElement('div');
      panel.className = 'cinema-menu-panel hidden';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', title);

      const menu = { wrap, btn, panel, open: false };
      btn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleMenu(menu); });
      panel.addEventListener('click', (e) => e.stopPropagation());
      wrap.appendChild(btn); wrap.appendChild(panel);
      this._menus.push(menu);
      return menu;
    }

    _toggleMenu(menu) {
      const willOpen = !menu.open;
      this._closeMenus();
      if (willOpen) {
        menu.open = true;
        menu.panel.classList.remove('hidden');
        menu.btn.setAttribute('aria-expanded', 'true');
        menu.btn.classList.add('open');
      }
    }

    _closeMenus() {
      for (const m of this._menus) {
        if (!m.open && m.panel.classList.contains('hidden')) continue;
        m.open = false;
        m.panel.classList.add('hidden');
        m.btn.setAttribute('aria-expanded', 'false');
        m.btn.classList.remove('open');
      }
    }

    _section(panel, label) {
      const s = document.createElement('div');
      s.className = 'cinema-menu-section';
      if (label) {
        const h = document.createElement('div');
        h.className = 'cinema-menu-section-label';
        h.textContent = label;
        s.appendChild(h);
      }
      panel.appendChild(s);
      return s;
    }

    // Reflect "this menu currently changes the scene" as a dot on its button,
    // so a collapsed menu still signals that a lens/chip/projection is active.
    _reflectAsk() {
      if (!this._askMenu) return;
      const on = !!(this._lensActive || this._chipActive);
      this._askMenu.btn.classList.toggle('has-active', on);
    }
    _reflectView() {
      const viewMenu = this._menus[0];
      if (!viewMenu) return;
      const on = (this._proj && this._proj !== 'graph') || this._minimapOn;
      viewMenu.btn.classList.toggle('has-active', on);
    }

    _handleKey(e) {
      const tgt = e.target;
      if (tgt && (/^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName) || tgt.isContentEditable)) return;
      switch (e.key) {
        case ' ': case 'Spacebar': e.preventDefault(); this.fire('togglePlay'); break;
        case 'ArrowLeft': e.preventDefault(); this.fire(e.shiftKey ? 'jumpEventPrev' : 'stepBack'); break;
        case 'ArrowRight': e.preventDefault(); this.fire(e.shiftKey ? 'jumpEventNext' : 'stepForward'); break;
        case 'Home': e.preventDefault(); this.fire('seek', 0); break;
        case 'End': e.preventDefault(); this.fire('seek', this.position.total || 0); break;
        default: break;
      }
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
      const b = this.transportEl && this.transportEl.querySelector('#cinema-btn-playpause');
      if (b) b.textContent = playing ? '⏸' : '▶';
    }

    setSpeed(n) {
      this.speed = n;
      for (const b of (this._speedBtns || [])) {
        const on = Number(b.dataset.speed) === n;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    setLoop(on) {
      this.loop = !!on;
      if (this._loopBtn) { this._loopBtn.classList.toggle('active', this.loop); this._loopBtn.setAttribute('aria-pressed', this.loop ? 'true' : 'false'); }
    }

    setStoryPlaying(on) {
      if (this._storyBtn) this._storyBtn.textContent = on ? '⏸ Pause story' : '▶ Play story';
    }

    setLens(role) {
      if (this._lensSel) this._lensSel.value = role || '';
      this._lensActive = role || '';
      this._reflectAsk();
    }
    setSmartActive(id) {
      this._chipActive = id || '';
      if (this._smartChips) for (const [fid, c] of this._smartChips) c.classList.toggle('active', fid === id);
      this._reflectAsk();
    }

    setProjection(pmode) {
      this._proj = pmode;
      for (const b of (this._projBtns || [])) {
        const on = b.dataset.proj === pmode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      this._reflectView();
    }

    setMinimapActive(on) {
      this._minimapOn = !!on;
      if (this._minimapBtn) {
        this._minimapBtn.classList.toggle('active', this._minimapOn);
        this._minimapBtn.setAttribute('aria-pressed', this._minimapOn ? 'true' : 'false');
      }
      this._reflectView();
    }

    setViewMode(m) {
      for (const b of (this._viewBtns || [])) {
        const on = b.dataset.view === m;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    setDriftAvailable(on) {
      if (this._driftBtn) {
        this._driftBtn.disabled = !on;
        this._driftBtn.title = on
          ? 'Compare what was predicted with what actually happened'
          : 'Plan vs Actual — no captured plan in this scene';
      }
    }
    setDriftActive(on) {
      if (!this._driftBtn) return;
      this._driftBtn.classList.toggle('cinema-menu-item-active', on);
      this._driftBtn.textContent = on ? '⧉ Exit compare' : '⧉ Plan vs Actual';
    }

    setLayout(engine) {
      this._layout = engine;
      for (const b of (this._layoutBtns || [])) {
        const on = b.dataset.engine === engine;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    /** setPosition updates the scrubber + readout. */
    setPosition(cur, total, block) {
      this.position = { cur: cur || 0, total: total || 0, block: block || 0 };
      if (this.scrubber) {
        this.scrubber.max = String(total || 0);
        if (document.activeElement !== this.scrubber) this.scrubber.value = String(cur || 0);
        this.scrubber.disabled = !total;
      }
      if (this.timeEl) {
        this.timeEl.textContent = total
          ? `seq ${cur || 0} / ${total}` + (block ? ` · block ${block.toLocaleString()}` : '')
          : (block ? `block ${block.toLocaleString()}` : '—');
      }
    }

    /** setTicks renders one marker per narrative event, colored by status. */
    setTicks(events) {
      if (!this.ticksEl) return;
      this.ticksEl.replaceChildren();
      const evs = events || [];
      const total = evs.reduce((m, e) => Math.max(m, e.sequence || 0), 0) || 1;
      for (const e of evs) {
        const tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'cinema-tick';
        tick.dataset.status = e.status || '';
        tick.style.left = ((e.sequence || 0) / total * 100) + '%';
        tick.title = (e.stage || '') + (e.status ? ' — ' + e.status : '');
        tick.setAttribute('aria-label', 'Jump to ' + (e.stage || 'event'));
        tick.addEventListener('click', () => this.fire('seek', e.sequence || 0));
        this.ticksEl.appendChild(tick);
      }
    }

    /** setSearchCount shows the result tally + stepper while a query is active. */
    setSearchCount(matched, hasQuery) {
      if (!this.searchCountEl) return;
      if (!hasQuery) {
        this.searchCountEl.classList.add('hidden');
        if (this.searchNavEl) this.searchNavEl.classList.add('hidden');
        return;
      }
      this.searchCountEl.textContent = matched + (matched === 1 ? ' match' : ' matches');
      this.searchCountEl.classList.remove('hidden');
      if (this.searchNavEl) this.searchNavEl.classList.toggle('hidden', !matched);
    }

    /** setSearchValue restores a persisted query into the box (no event fired). */
    setSearchValue(v) { if (this.searchEl) this.searchEl.value = v || ''; }

    fire(name, arg) { const h = this.handlers[name]; if (h) h(arg); }

    destroy() {
      if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
      if (this._onDocClick) { document.removeEventListener('click', this._onDocClick); this._onDocClick = null; }
      if (this._onDocKey) { document.removeEventListener('keydown', this._onDocKey); this._onDocKey = null; }
    }
  }

  ns.CinemaControls = CinemaControls;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaControls };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
