/**
 * Infrix Cinema — canonical app core.
 *
 * mountCinema(options) is the ONE entry point every Cinema surface uses. It
 * builds the canonical product UI inside `options.root`, drives the single
 * CinemaRenderer from a CinemaDataSource, and gates controls by mode so the
 * standalone product, the Nexus-mounted view, the embeddable widget, and the
 * portable proof viewer all render the same scene with the same vocabulary and
 * the same disclosure guarantees.
 *
 *   options = {
 *     mode: 'cinema.full' | 'cinema.nexus' | 'cinema.embed' | 'cinema.proof',
 *     root: HTMLElement,
 *     dataSource?: CinemaDataSource,      // if omitted, built from the options below
 *     disclosureContext?: {viewerId,purpose,workflowInstance,grants?},
 *     initialSessionId?, initialIntentId?, initialProof?,
 *     capabilities?: partial override of the mode defaults,
 *     rpc?, wsUrl?, scene?, proof?, commit?, autoConnect?, header?
 *   }
 *
 * Returns a controller: { mode, renderer, dataSource, destroy, setScene,
 * timeline, controls, legend, export }.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  const MODES = {
    'cinema.full':  { live: true,  replay: true,  controls: true,  disclosureAware: true, connect: true  },
    'cinema.nexus': { live: true,  replay: true,  controls: true,  disclosureAware: true, sharedHeader: true },
    'cinema.embed': { live: false, replay: false, controls: false, disclosureAware: true, readOnly: true },
    'cinema.proof': { live: false, replay: true,  controls: true,  disclosureAware: true, proof: true },
  };

  function mountCinema(options) {
    options = options || {};
    const mode = MODES[options.mode] ? options.mode : 'cinema.full';
    const caps = Object.assign({}, MODES[mode], options.capabilities || {});
    const rootEl = options.root;
    if (!rootEl) throw new Error('mountCinema: options.root is required');
    const disclosureContext = options.disclosureContext || {};

    // ---- DOM skeleton (canonical IDs/classes, shared across surfaces) ----
    rootEl.classList.add('cinema-root', 'cinema-mode-' + mode.split('.')[1]);
    rootEl.replaceChildren();

    const stage = el('div', 'cinema-stage');
    const canvas = document.createElement('canvas');
    canvas.id = 'cinema-canvas';
    canvas.className = 'cinema-canvas';
    stage.appendChild(canvas);

    // Details panel (right).
    const detailsPanelEl = el('div', 'cinema-panel panel hidden');
    detailsPanelEl.id = 'details-panel';
    const detailsHead = el('div', 'cinema-panel-header panel-header');
    const detailTitle = el('span'); detailTitle.id = 'detail-title'; detailTitle.textContent = 'Details';
    const detailClose = document.createElement('button'); detailClose.id = 'detail-close'; detailClose.textContent = '×'; detailClose.setAttribute('aria-label', 'Close details');
    detailsHead.appendChild(detailTitle); detailsHead.appendChild(detailClose);
    const detailContent = el('div'); detailContent.id = 'detail-content';
    detailsPanelEl.appendChild(detailsHead); detailsPanelEl.appendChild(detailContent);
    stage.appendChild(detailsPanelEl);

    // Body holds the canvas stage and, in split/narrative view, the audit story.
    const body = el('div', 'cinema-body');
    body.appendChild(stage);
    rootEl.appendChild(body);

    // Controls bar (skipped entirely in embed mode).
    const controlsHost = el('div', 'cinema-controls-host');
    if (!caps.readOnly) rootEl.appendChild(controlsHost);

    // Status bar.
    const status = el('footer', 'cinema-status');
    status.id = 'status-bar';
    status.append(
      span('status-block', 'Block: 0'), span('status-gas', 'Gas: 0'),
      span('status-nodes', 'Nodes: 0'), span('status-edges', 'Edges: 0'),
      span('status-fps', 'FPS: 0'),
    );
    if (!caps.readOnly) rootEl.appendChild(status);

    // ---- Renderer ----
    const renderer = new ns.CinemaRenderer(canvas);

    // ---- Details ----
    const details = new ns.DetailsPanel(detailsPanelEl, detailContent, detailClose);
    details.renderer = renderer;
    renderer.on('nodeSelected', (n) => details.showNode(n));
    renderer.on('edgeHovered', (t) => details.showTraffic(t));

    // ---- Legend ----
    const legend = new ns.CinemaLegend(stage);

    // ---- Data source resolution ----
    let dataSource = options.dataSource || buildDataSource(mode, options, disclosureContext);

    // ---- Narrative (audit story) + sync (adoption-05) ----
    const proofForNarrative = options.proof || (dataSource && dataSource.proof) || null;
    let sync = null;
    const narrative = ns.NarrativePanel
      ? new ns.NarrativePanel(body, {
          proof: proofForNarrative,
          onCardFocus: (ids) => { if (sync) sync.highlightNodes(ids); },
        })
      : null;
    if (narrative && ns.createNarrativeSync) sync = ns.createNarrativeSync({ renderer, panel: narrative });

    // View mode: graph | narrative | split (orthogonal to the host mode). The
    // toggle is shown wherever there are controls; embed stays canvas-only.
    let viewMode = resolveViewMode(mode, options);
    applyViewMode(rootEl, viewMode);
    if (caps.controls && !caps.readOnly) {
      buildViewToggle(rootEl, viewMode, (m) => { viewMode = m; applyViewMode(rootEl, m); persistViewMode(mode, m); });
    }

    // ---- Timeline + export ----
    const timeline = new ns.TimelineAdapter({
      dataSource, renderer,
      onPosition: (pos) => { if (sync) sync.onPosition(pos); },
    });
    const exporter = new ns.CinemaExport({ renderer, dataSource, mode, commit: options.commit, disclosureContext, timeline });

    // ---- Proof panel ----
    let proofPanel = null;
    if (caps.proof) {
      const proof = options.proof || (dataSource && dataSource.proof) || {};
      proofPanel = new ns.ProofPanel(rootEl, proof, { disclosureContext });
    }

    // ---- Controls ----
    let controls = null;
    if (!caps.readOnly) {
      controls = new ns.CinemaControls(controlsHost, {
        capabilities: caps,
        handlers: {
          togglePlay: () => { timeline.togglePlay(); controls.setPlaying(timeline.state.playing); },
          stepForward: () => timeline.stepForward(),
          stepBack: () => timeline.stepBackward(),
          fit: () => renderer.fitToView(),
          resetView: () => renderer.resetView(),
          filter: (q) => applyFilter(renderer, q),
          toggleLegend: () => legend.toggle(),
          export: () => openExportMenu(exporter, rootEl),
        },
      });
    }

    // ---- Scene wiring ----
    let unsubscribe = () => {};
    function onScene(g) {
      if (g && g.__update) { renderer.applyUpdate(g.__update); return; }
      renderer.setSceneGraph(g || {});
      if (narrative) {
        try { narrative.setScene(g || {}, { proof: options.proof || (dataSource && dataSource.proof) || null }); } catch (e) {}
      }
    }

    function bind(ds) {
      dataSource = ds;
      timeline.dataSource = ds;
      exporter.dataSource = ds;
      // Initial paint.
      if (ds.getScene) ds.getScene().then((g) => { if (g && (countNodes(g) > 0)) onScene(g); }).catch(() => {});
      if (ds.subscribeScene) unsubscribe = ds.subscribeScene(onScene);
      timeline.refresh().catch(() => {});
    }

    // Full mode connect dialog (preserves the standalone product UX + IDs).
    if (caps.connect) {
      const dialog = buildConnectDialog(options);
      rootEl.appendChild(dialog.el);
      dialog.onConnect((wsUrl, sessionId) => {
        const ds = new ns.StandaloneCinemaDataSource({ wsUrl, sessionId, disclosureContext });
        dialog.el.classList.add('hidden');
        bind(ds);
      });
      if (options.autoConnect && options.wsUrl) dialog.connect(options.wsUrl, options.initialSessionId);
    } else {
      bind(dataSource);
    }

    // Seed the renderer + narrative from an inline scene (the nexus host and the
    // embed widget both pass options.scene rather than an async source). Apply
    // the SAME disclosure filter the data sources use so nothing private leaks
    // into the canvas or the story.
    if (options.scene && countNodes(options.scene) > 0) {
      const safe = ns.applyDisclosure ? ns.applyDisclosure(options.scene, disclosureContext) : options.scene;
      onScene(safe);
    }

    // Status loop.
    const statusTimer = setInterval(() => updateStatus(renderer, status), 500);

    return {
      mode, caps, renderer, get dataSource() { return dataSource; }, timeline, controls, legend, exporter, details, proofPanel,
      narrative, sync, get viewMode() { return viewMode; },
      setViewMode(m) { viewMode = m; applyViewMode(rootEl, m); persistViewMode(mode, m); },
      setScene: onScene,
      destroy() {
        try { unsubscribe(); } catch (e) {}
        clearInterval(statusTimer);
        timeline.destroy();
        if (sync) sync.destroy();
        if (narrative) narrative.destroy();
        renderer.destroy();
      },
    };
  }

  // ---- View mode (graph | narrative | split) ----
  const VIEW_MODES = ['graph', 'narrative', 'split'];
  const VIEW_KEY = 'cinema.mode';

  function resolveViewMode(mode, options) {
    if (options.narrativeMode && VIEW_MODES.indexOf(options.narrativeMode) >= 0) return options.narrativeMode;
    if (mode === 'cinema.embed') return 'graph'; // embed is canvas-first; story is opt-in
    if (mode === 'cinema.proof') return 'split';
    // full + nexus: remember the operator's last choice, default to split.
    const saved = readViewMode();
    return (saved && VIEW_MODES.indexOf(saved) >= 0) ? saved : 'split';
  }
  function readViewMode() { try { return localStorage.getItem(VIEW_KEY); } catch (_) { return null; } }
  function persistViewMode(mode, m) {
    if (mode === 'cinema.full' || mode === 'cinema.nexus') { try { localStorage.setItem(VIEW_KEY, m); } catch (_) {} }
  }
  function applyViewMode(rootEl, m) {
    if (VIEW_MODES.indexOf(m) < 0) m = 'split';
    rootEl.dataset.view = m;
    for (const x of VIEW_MODES) rootEl.classList.remove('cinema-view-' + x);
    rootEl.classList.add('cinema-view-' + m);
  }
  function buildViewToggle(rootEl, current, onChange) {
    const wrap = el('div', 'cinema-view-toggle');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'View mode');
    const labels = [['graph', 'Graph'], ['narrative', 'Narrative'], ['split', 'Split']];
    const btns = [];
    for (const [m, label] of labels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cinema-view-btn' + (m === current ? ' active' : '');
      b.dataset.view = m;
      b.textContent = label;
      b.setAttribute('aria-pressed', m === current ? 'true' : 'false');
      b.addEventListener('click', () => {
        for (const x of btns) { const on = x.dataset.view === m; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        onChange(m);
      });
      btns.push(b);
      wrap.appendChild(b);
    }
    rootEl.appendChild(wrap);
    return wrap;
  }

  function buildDataSource(mode, options, disclosureContext) {
    const o = Object.assign({}, options, { disclosureContext });
    switch (mode) {
      case 'cinema.proof':
        return new ns.ProofCinemaDataSource(Object.assign(o, { proof: options.proof || {} }));
      case 'cinema.embed':
        return new ns.EmbedCinemaDataSource(Object.assign(o, { scene: options.scene || {} }));
      case 'cinema.nexus':
        return new ns.NexusCinemaDataSource(Object.assign(o, { rpc: options.rpc, method: options.method, params: options.params }));
      case 'cinema.full':
      default:
        // Full mode resolves its source from the connect dialog; provide an
        // empty embed source until then so the renderer has something.
        return new ns.EmbedCinemaDataSource(Object.assign(o, { scene: options.scene || {} }));
    }
  }

  function buildConnectDialog(options) {
    const el0 = el('div', 'cinema-dialog dialog');
    el0.id = 'connect-dialog';
    const box = el('div', 'cinema-dialog-content dialog-content');
    const h = el('h2'); h.textContent = 'Connect to Cinema session'; box.appendChild(h);
    const l1 = document.createElement('label'); l1.textContent = 'WebSocket URL: ';
    const wsInput = document.createElement('input'); wsInput.type = 'text'; wsInput.id = 'input-ws-url';
    wsInput.value = options.wsUrl || 'ws://localhost:8080/cinema/ws';
    wsInput.placeholder = 'ws://host:port/cinema/ws'; l1.appendChild(wsInput); box.appendChild(l1);
    const l2 = document.createElement('label'); l2.textContent = 'Session ID: ';
    const sidInput = document.createElement('input'); sidInput.type = 'text'; sidInput.id = 'input-session-id';
    sidInput.placeholder = 'Session ID (optional — auto-discovers)';
    if (options.initialSessionId) sidInput.value = options.initialSessionId;
    l2.appendChild(sidInput); box.appendChild(l2);
    const btn = document.createElement('button'); btn.id = 'btn-connect'; btn.textContent = 'Connect'; box.appendChild(btn);
    el0.appendChild(box);
    let cb = null;
    btn.addEventListener('click', () => { if (cb) cb(wsInput.value, sidInput.value || null); });
    return {
      el: el0,
      onConnect(fn) { cb = fn; },
      connect(wsUrl, sid) { wsInput.value = wsUrl || wsInput.value; if (sid) sidInput.value = sid; if (cb) cb(wsInput.value, sidInput.value || null); },
    };
  }

  function applyFilter(renderer, q) {
    const g = renderer.sceneGraph;
    if (!g) return;
    const query = String(q || '').trim().toLowerCase();
    const nodes = Array.isArray(g.nodes) ? g.nodes : Object.values(g.nodes || {});
    nodes.forEach(n => {
      const hit = !query || (String(n.label || '').toLowerCase().includes(query) || String(n.kind || '').toLowerCase().includes(query));
      n.opacity = hit ? (n._origOpacity != null ? n._origOpacity : 1) : 0.12;
      if (n._origOpacity == null) n._origOpacity = 1;
    });
  }

  function openExportMenu(exporter, rootEl) {
    // Minimal, dependency-free chooser. Each option is self-describing.
    const existing = rootEl.querySelector('.cinema-export-menu');
    if (existing) { existing.remove(); return; }
    const menu = el('div', 'cinema-export-menu');
    const items = [
      ['PNG', () => exporter.screenshot()],
      ['SVG', () => exporter.exportSVG()],
      ['JSON', () => exporter.exportJSON()],
      ['Replay ref', () => exporter.replayRef()],
      ['Proof report', () => exporter.proofReport()],
    ];
    for (const [label, fn] of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'cinema-export-item'; b.textContent = label;
      b.addEventListener('click', () => { fn(); menu.remove(); });
      menu.appendChild(b);
    }
    rootEl.appendChild(menu);
  }

  function updateStatus(renderer, status) {
    if (!renderer || !status) return;
    const s = renderer.getStats();
    const g = renderer.sceneGraph;
    setText(status, 'status-nodes', `Nodes: ${s.nodes}`);
    setText(status, 'status-edges', `Edges: ${s.edges}`);
    setText(status, 'status-fps', `FPS: ${s.fps}`);
    if (g) {
      setText(status, 'status-block', `Block: ${g.blockHeight || 0}`);
      setText(status, 'status-gas', `Gas: ${(g.totalGasUsed || 0).toLocaleString()}`);
    }
  }

  function countNodes(g) { const n = g.nodes || g.Nodes; return n ? (Array.isArray(n) ? n.length : Object.keys(n).length) : 0; }
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function span(id, text) { const s = document.createElement('span'); s.id = id; s.textContent = text; return s; }
  function setText(rootEl, id, text) { const e = rootEl.querySelector('#' + id); if (e) e.textContent = text; }

  ns.mountCinema = mountCinema;
  ns.MODES = MODES;
  if (typeof module !== 'undefined' && module.exports) module.exports = { mountCinema, MODES };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
