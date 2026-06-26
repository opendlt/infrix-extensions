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
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-roledescription', 'interactive scene graph');
    canvas.setAttribute('aria-label', 'Infrix Cinema scene graph — hover to peek, click to pin, drag to pan');
    stage.appendChild(canvas);

    // One calm top strip (IA pass): the trust posture, the self-explaining
    // scene summary, and the disclosure status all live here in a single
    // centered row instead of floating in three separate corners.
    const topbar = el('div', 'cinema-topbar');
    topbar.id = 'cinema-topbar';
    stage.appendChild(topbar);

    // Details panel (right).
    const detailsPanelEl = el('div', 'cinema-panel panel hidden');
    detailsPanelEl.id = 'details-panel';
    const detailsHead = el('div', 'cinema-panel-header panel-header');
    const detailTitle = el('span'); detailTitle.id = 'detail-title'; detailTitle.textContent = 'Details';
    const detailClose = document.createElement('button'); detailClose.id = 'detail-close'; detailClose.textContent = '×'; detailClose.setAttribute('aria-label', 'Close details');
    detailsHead.appendChild(detailTitle); detailsHead.appendChild(detailClose);
    const detailContent = el('div'); detailContent.id = 'detail-content';
    detailsPanelEl.appendChild(detailsHead); detailsPanelEl.appendChild(detailContent);

    // Body holds the canvas stage, the docked details panel (F3), and — in
    // split/narrative view — the audit story.
    const body = el('div', 'cinema-body');
    body.appendChild(stage);
    body.appendChild(detailsPanelEl);
    rootEl.appendChild(body);

    // Controls bar (skipped entirely in embed mode).
    const controlsHost = el('div', 'cinema-controls-host');
    if (!caps.readOnly) rootEl.appendChild(controlsHost);

    // Status bar — the vitals strip (J1) replaces raw telemetry with posture.
    const status = el('footer', 'cinema-status');
    status.id = 'status-bar';
    let vitalsStrip = null;
    if (ns.VitalsStrip) {
      vitalsStrip = new ns.VitalsStrip(status, { onJump: (t) => vitalsJump(t) });
    } else {
      status.append(
        span('status-block', 'Block: 0'), span('status-gas', 'Gas: 0'),
        span('status-nodes', 'Nodes: 0'), span('status-edges', 'Edges: 0'),
      );
    }
    if (!caps.readOnly) rootEl.appendChild(status);

    // ---- Renderer ----
    const renderer = new ns.CinemaRenderer(canvas);

    // ---- Details ----
    const details = new ns.DetailsPanel(detailsPanelEl, detailContent, detailClose);
    details.renderer = renderer;
    details.assuranceProvider = (id) => nodeAssurance[id] || null;
    details.onTrace = (id) => doTrace(id); // H2 — Trace / Why?

    // Hover tooltip (B1) + accessible node list (B5).
    const tooltip = ns.CinemaTooltip ? new ns.CinemaTooltip(stage) : null;
    const a11y = ns.CinemaA11y ? new ns.CinemaA11y(renderer, rootEl, {
      onActivate: (id) => { const n = renderer._findNode ? renderer._findNode(id) : null; if (n) { renderer.selectedNode = id; details.showNode(n); } },
    }) : null;

    // Interaction model (B1): click pins details, hover peeks via tooltip, empty
    // click clears. Edge hover no longer throws open the heavy panel.
    renderer.on('nodeSelected', (n) => { details.showNode(n); if (tooltip) tooltip.hide(); if (a11y) a11y.focusNode(n.id); });
    renderer.on('edgeSelected', (t) => { details.showTraffic(t); if (tooltip) tooltip.hide(); });
    renderer.on('backgroundClicked', () => { details.hide(); renderer.setKeyboardFocus(null); clearTrace(); });
    renderer.on('nodeHovered', (p) => { if (tooltip) tooltip.showNode(p.node, p.x, p.y, { stats: renderer.getNodeStats ? renderer.getNodeStats(p.node.id) : null, assurance: nodeAssurance[p.node.id] || null }); });
    renderer.on('edgeHovered', (p) => { if (tooltip) tooltip.showEdge(p.edge, p.x, p.y); });
    renderer.on('hoverEnd', () => { if (tooltip) tooltip.hide(); });

    // ---- Legend ----
    const legend = new ns.CinemaLegend(stage);

    // ---- Stage state overlay (A4): loading / empty / empty-filter / error ----
    const overlay = ns.CinemaStateOverlay ? new ns.CinemaStateOverlay(stage) : null;
    let connectionState = caps.connect ? 'idle' : (caps.live ? 'connecting' : 'idle');
    let everConnected = false;
    let connError = '';
    let filterActive = false;

    // ---- Layout engine (A1) ----
    const layoutController = ns.LayoutController ? new ns.LayoutController(renderer) : null;
    let layoutEngine = readLayout() || 'auto';
    let firstScene = true;

    function nodeCountNow() { const g = renderer.sceneGraph; return g ? countNodes(g) : 0; }
    function getEvents() { return (narrative && narrative.events) || []; }

    function refreshOverlay() {
      if (!overlay || !ns.resolveState) return;
      const state = ns.resolveState({
        nodeCount: nodeCountNow(), filterActive, connection: connectionState,
        everConnected, expectsConnection: !!(caps.connect || caps.live),
      });
      if (state === 'error') {
        overlay.set('error', { message: connError || undefined, actionLabel: 'Retry', onAction: retryConnect });
      } else if (state === 'empty-filter') {
        overlay.set('empty-filter', { onAction: clearFilter });
      } else if (state === 'empty') {
        if (caps.connect) overlay.set('empty', { actionLabel: 'Connect', onAction: openConnect });
        else overlay.set('empty');
      } else {
        overlay.set(state); // 'loading' or 'hidden'
      }
    }

    function onConnectionState(state, info) {
      connectionState = state;
      if (state === 'connected') everConnected = true;
      if (state === 'error') connError = (info && info.fatal)
        ? 'The session could not be reached after several attempts.'
        : 'The live connection dropped — Cinema is trying to reconnect.';
      refreshOverlay();
    }
    options.onConnectionState = onConnectionState;

    function retryConnect() {
      const ds = dataSource;
      if (ds && ds.client && ds.client.connect) { connectionState = 'connecting'; refreshOverlay(); ds.client.connect(); }
    }
    function clearFilter() {
      const search = rootEl.querySelector('#cinema-search');
      if (search) search.value = '';
      runSearch('');
    }
    function openConnect() {
      const dlg = rootEl.querySelector('#connect-dialog');
      if (dlg) dlg.classList.remove('hidden');
    }

    // applyLayout decides the engine: 'auto' respects server positions when every
    // node already has one, and computes a layout when any is missing; an explicit
    // Spine/Force choice always (re)lays out, even over server coordinates.
    function applyLayout(graph, o) {
      if (!graph || !layoutController) return;
      let eng = layoutEngine;
      if (eng === 'auto') eng = ns.needsLayout(graph) ? 'auto' : 'none';
      layoutController.apply(graph, eng, o || {});
    }

    function refreshTransport() {
      if (!controls) return;
      const evs = getEvents();
      const lastSeq = evs.length ? (evs[evs.length - 1].sequence != null ? evs[evs.length - 1].sequence : evs.length - 1) : 0;
      timeline.setTotal(lastSeq);
      const g = renderer.sceneGraph;
      const block = g ? (g.blockHeight || g.BlockHeight || 0) : 0;
      controls.setTicks(evs);
      controls.setPosition(timeline.state.currentSeq || 0, timeline.state.totalSeq || 0, block);
      if (tlInstrument) tlInstrument.render(evs, Math.max(timeline.state.totalSeq || 0, lastSeqOf(evs)));
    }
    function lastSeqOf(evs) { return evs.length ? (evs[evs.length - 1].sequence != null ? evs[evs.length - 1].sequence : evs.length - 1) : 1; }

    function stepEvent(dir) {
      const evs = getEvents().map((e) => e.sequence || 0).sort((a, b) => a - b);
      const cur = timeline.state.currentSeq || 0;
      let target = cur;
      if (dir > 0) { for (const s of evs) if (s > cur) { target = s; break; } }
      else { for (let i = evs.length - 1; i >= 0; i--) if (evs[i] < cur) { target = evs[i]; break; } }
      timeline.seek(target);
    }
    function jumpFailure() {
      const evs = getEvents();
      const f = evs.find((e) => e.status === 'failed') || evs[evs.length - 1];
      if (f) timeline.seek(f.sequence || 0);
    }

    // ---- Power search (B4) ----
    let matchedIds = [];
    let matchIndex = -1;
    let currentQuery = '';
    function gasOf(n) { try { return renderer.getNodeStats(n.id).totalGas || 0; } catch (_) { return 0; } }
    function runSearch(q) {
      currentQuery = q || '';
      // A typed query takes over the dim channel from any lens/smart chip (K).
      if (currentQuery.trim() && (activeChip || activeLens)) {
        activeChip = null; activeLens = '';
        if (controls) { controls.setSmartActive(null); controls.setLens(''); }
      }
      const parsed = ns.parseSearchQuery ? ns.parseSearchQuery(currentQuery) : { isEmpty: !currentQuery.trim() };
      filterActive = !parsed.isEmpty;
      matchedIds = [];
      const g = renderer.sceneGraph;
      if (g) {
        let nodes = g.nodes; if (!Array.isArray(nodes)) nodes = Object.values(nodes || {});
        nodes.forEach((n) => {
          if (n._origOpacity == null) n._origOpacity = (n.opacity != null ? n.opacity : 1);
          const hit = parsed.isEmpty || (ns.matchSearch ? ns.matchSearch(n, parsed, { gasOf }) : true);
          n.opacity = hit ? n._origOpacity : 0.12;
          if (!parsed.isEmpty && hit) matchedIds.push(n.id);
        });
      }
      matchIndex = -1;
      if (controls) controls.setSearchCount(matchedIds.length, !parsed.isEmpty);
      persistSearch(currentQuery);
      refreshOverlay();
    }
    function stepMatch(dir) {
      if (!matchedIds.length) return;
      matchIndex = (matchIndex + dir + matchedIds.length) % matchedIds.length;
      renderer.flyTo(matchedIds[matchIndex]);
    }
    function persistSearch(q) {
      if (mode === 'cinema.full' || mode === 'cinema.nexus') { try { localStorage.setItem('cinema.search', q || ''); } catch (_) {} }
    }
    function readSearch() { try { return localStorage.getItem('cinema.search') || ''; } catch (_) { return ''; } }

    // ---- Tier C: trust ladder + disclosure + agent ribbon + anchor moment ----
    const ASR_ORDER = ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness'];
    function rankAsr(id) { const i = ASR_ORDER.indexOf(id); return i < 0 ? 0 : i; }
    function asrLabel(id) { const A = ns.ASSURANCE || {}; const a = Object.values(A).find((x) => x.id === id); return (a && a.label) || id; }

    let nodeAssurance = {};
    function buildNodeAssurance() {
      nodeAssurance = {};
      for (const e of getEvents()) {
        for (const id of (e.graphNodeIds || [])) {
          const cur = nodeAssurance[id];
          if (!cur || rankAsr(e.assurance) > rankAsr(cur.id)) nodeAssurance[id] = { id: e.assurance, label: asrLabel(e.assurance) };
        }
      }
    }

    // Rung click → highlight the nodes that rung is about (reuses sync highlight).
    function nodesForRung(rungId) {
      const g = renderer.sceneGraph; if (!g) return [];
      let nodes = g.nodes; if (!Array.isArray(nodes)) nodes = Object.values(nodes || {});
      if (rungId === 'l0') return nodes.filter((n) => n.kind === 'anchor' || n.kind === 'l0_bridge').map((n) => n.id);
      if (rungId === 'witness') return nodes.filter((n) => n.kind === 'evidence' || n.kind === 'evidence_link').map((n) => n.id);
      if (rungId === 'replay') return nodes.map((n) => n.id);
      return [];
    }
    function highlightRung(rungId) {
      if (!sync || !sync.highlightNodes) return;
      const ids = nodesForRung(rungId);
      if (ids.length) sync.highlightNodes(ids); else sync.clearHighlight();
    }

    // Scene-level disclosure summary chip (C2). Lives in the top strip; when the
    // scene carries disclosable sealed values it becomes a button that opens the
    // grant-preview dial (I2) on demand instead of the dial always being shown.
    const discChip = document.createElement('button');
    discChip.type = 'button';
    discChip.className = 'cinema-disclosure-chip hidden';
    discChip.id = 'cinema-disclosure-chip';
    discChip.addEventListener('click', () => { if (discChip.classList.contains('actionable')) toggleDisclosureDial(); });
    topbar.appendChild(discChip);
    function updateDisclosureChip() {
      const g = renderer.sceneGraph;
      let nodes = g ? (Array.isArray(g.nodes) ? g.nodes : Object.values(g.nodes || {})) : [];
      const sealed = nodes.filter((n) => n.redacted).length;
      const disclosable = nodes.filter((n) => n.redacted && n.grantId).length;
      if (sealed > 0) {
        const canDial = !!(rawScene && grantsInRaw().length);
        discChip.textContent = `🔒 ${sealed} sealed` + (disclosable ? ` · ${disclosable} disclosable to you` : '') + (canDial ? ' ▾' : '');
        discChip.classList.toggle('actionable', canDial);
        discChip.setAttribute('aria-label', canDial
          ? 'Sealed values — open the grant-preview dial'
          : `${sealed} sealed value${sealed === 1 ? '' : 's'} in this scene`);
        discChip.classList.remove('hidden');
      } else { discChip.classList.add('hidden'); if (typeof closeDisclosureDial === 'function') closeDisclosureDial(); }
    }

    // Agent-stop ribbon (C3) — shown only for agent-receipt scenes.
    const agentRibbon = ns.AgentRibbon ? new ns.AgentRibbon(stage, { onExport: () => { try { exporter.exportJSON(); } catch (_) {} } }) : null;

    // Anchor-confirmation moment (D3).
    let anchorFired = false;
    function pulseLadders(rung) {
      if (proofPanel && proofPanel.ladder && proofPanel.ladder.pulse) proofPanel.ladder.pulse(rung);
      if (narrative && narrative.ladder && narrative.ladder.pulse) narrative.ladder.pulse(rung);
    }
    function maybeAnchorMoment(seq) {
      if (anchorFired) return;
      const proof = options.proof || (dataSource && dataSource.proof) || null;
      const anchored = ns.ladderProofFacts ? ns.ladderProofFacts(proof || {}).anchored : false;
      if (!anchored) return;
      const anchorEv = getEvents().find((e) => e.stage === 'anchor');
      if (!anchorEv || seq < (anchorEv.sequence || 0)) return;
      const g = renderer.sceneGraph;
      let nodes = g ? (Array.isArray(g.nodes) ? g.nodes : Object.values(g.nodes || {})) : [];
      const ev = nodes.find((n) => n.kind === 'evidence' || n.kind === 'evidence_link');
      const an = nodes.find((n) => n.kind === 'anchor' || n.kind === 'l0_bridge');
      if (ev && an) { renderer.playAnchorConfirmation(ev.id, an.id); pulseLadders('l0'); bloomAura(); anchorFired = true; }
    }

    // ---- Wave G: trust-posture aura + chip (G2), scene summary + spotlight (G3) ----
    const trustAura = el('div', 'cinema-trust-aura');
    trustAura.id = 'cinema-trust-aura';
    trustAura.setAttribute('aria-hidden', 'true');
    stage.appendChild(trustAura);

    const postureChip = document.createElement('button');
    postureChip.type = 'button';
    postureChip.className = 'cinema-posture-chip hidden';
    postureChip.id = 'cinema-posture-chip';
    postureChip.setAttribute('aria-label', 'Trust posture — open the trust ladder');
    postureChip.addEventListener('click', () => {
      const c = sceneCeiling();
      pulseLadders(c === 'offline' ? 'replay' : c);
      if (proofPanel && proofPanel.el && proofPanel.el.scrollIntoView) proofPanel.el.scrollIntoView({ block: 'nearest' });
    });
    topbar.appendChild(postureChip);

    const summaryRibbon = ns.SceneSummaryRibbon ? new ns.SceneSummaryRibbon(topbar, { storageKey: 'cinema.summary.' + mode }) : null;
    const spotlight = ns.Spotlight ? new ns.Spotlight(stage, { storageKey: 'cinema.spotlight.seen' }) : null;
    let bloomTimer = null;

    function sceneCeiling() {
      const proof = options.proof || (dataSource && dataSource.proof) || null;
      if (proof && ns.buildLadder) return ns.buildLadder(proof).ceilingId;
      let id = 'offline';
      for (const e of getEvents()) if (rankAsr(e.assurance) > rankAsr(id)) id = e.assurance;
      return id;
    }
    function updateTrustAura() {
      const c = sceneCeiling();
      trustAura.dataset.assurance = c;
      postureChip.dataset.assurance = c;
      postureChip.textContent = '⛓ ' + asrLabel(c);
      postureChip.classList.toggle('hidden', nodeCountNow() === 0);
    }
    function bloomAura() {
      trustAura.classList.add('bloom');
      if (bloomTimer) clearTimeout(bloomTimer);
      bloomTimer = setTimeout(() => trustAura.classList.remove('bloom'), 820);
    }
    function updateSummary() {
      if (!summaryRibbon || !ns.buildSceneSummary) return;
      const proof = options.proof || (dataSource && dataSource.proof) || null;
      const s = ns.buildSceneSummary(renderer.sceneGraph || {}, getEvents(), proof);
      summaryRibbon.setSummary(s.text);
    }

    // ---- Wave H: verify theatre (H1) + causal trace (H2) ----
    let verifyTheatre = null;
    function openVerifyTheatre() {
      if (!ns.VerifyTheatre) return;
      if (verifyTheatre) { verifyTheatre.close(); verifyTheatre = null; }
      const proof = options.proof || (dataSource && dataSource.proof) || {};
      verifyTheatre = new ns.VerifyTheatre(stage, {
        proof,
        verifier: options.verifier,
        onRungPass: (rung) => { pulseLadders(rung); if (rung === 'l0') bloomAura(); },
        onClose: () => { verifyTheatre = null; },
      });
      verifyTheatre.run();
    }
    function doTrace(id) {
      if (!ns.traceCausalChain) return;
      const chain = ns.traceCausalChain(renderer.sceneGraph, id);
      const node = renderer._findNode ? renderer._findNode(id) : null;
      if (sync && sync.highlightNodes && chain.nodes.length) sync.highlightNodes(chain.nodes);
      if (renderer.setTracePath) renderer.setTracePath(ns.edgeKeysOf(chain));
      if (node) { details.showNode(node); details.appendProvenance(chain.hops); }
    }
    function clearTrace() {
      if (renderer.clearTracePath) renderer.clearTracePath();
      if (sync && sync.clearHighlight) sync.clearHighlight();
    }

    // ---- Wave I: Predicted-vs-Actual / drift (I1) ----
    const driftView = ns.DriftView ? new ns.DriftView({ renderer }) : null;
    let driftActive = false;
    let driftOnlyActive = false;
    let lastScene = null;
    const driftChip = el('div', 'cinema-drift-chip hidden');
    driftChip.id = 'cinema-drift-chip';
    const driftText = el('span', 'cinema-drift-text'); driftChip.appendChild(driftText);
    const driftOnlyBtn = document.createElement('button');
    driftOnlyBtn.type = 'button'; driftOnlyBtn.className = 'cinema-drift-only'; driftOnlyBtn.textContent = 'Drift only';
    driftOnlyBtn.addEventListener('click', () => applyDriftOnly(!driftOnlyActive));
    driftChip.appendChild(driftOnlyBtn);
    stage.appendChild(driftChip);

    function planOf() { return options.plan || (options.proof && options.proof.plan) || (dataSource && dataSource.proof && dataSource.proof.plan) || null; }
    function updateDriftAvailability() {
      const avail = !!(driftView && ns.hasPlan && ns.hasPlan(renderer.sceneGraph, planOf()));
      if (controls) controls.setDriftAvailable(avail);
    }
    function exitDrift() {
      if (!driftActive) return;
      if (driftOnlyActive) applyDriftOnly(false);
      driftView.clear();
      driftActive = false;
      driftChip.classList.add('hidden');
      if (controls) controls.setDriftActive(false);
    }
    function toggleDrift() {
      if (!driftView) return;
      if (driftActive) {
        exitDrift();
        if (lastScene) { renderer.setSceneGraph(lastScene); applyLayout(renderer.sceneGraph, { animate: false }); }
      } else {
        driftView.apply(renderer.sceneGraph, planOf());
        driftActive = true;
        driftText.textContent = driftView.summary || 'Plan vs actual';
        driftOnlyBtn.classList.remove('active');
        driftChip.classList.remove('hidden');
        if (controls) controls.setDriftActive(true);
      }
    }
    function applyDriftOnly(on) {
      driftOnlyActive = on;
      driftOnlyBtn.classList.toggle('active', on);
      const ids = new Set(ns.driftedNodeIds ? ns.driftedNodeIds((driftView && driftView.drift) || { driftEdges: [] }) : []);
      let nodes = renderer.sceneGraph ? (Array.isArray(renderer.sceneGraph.nodes) ? renderer.sceneGraph.nodes : Object.values(renderer.sceneGraph.nodes || {})) : [];
      nodes.forEach((n) => {
        if (n._origOpacity == null) n._origOpacity = (n.opacity != null ? n.opacity : 1);
        n.opacity = on ? (ids.has(n.id) ? n._origOpacity : 0.12) : n._origOpacity;
      });
      renderer.requestRender();
    }

    // ---- Wave I: Disclosure-as-a-dial (I2) — only when a pre-disclosure scene
    // is available (a host that ships the sealed payloads the viewer is entitled
    // to under a grant). The preview never exceeds what the grant authorizes —
    // it re-runs the SAME fail-closed applyDisclosure with a hypothetical grant set.
    const rawScene = options.rawScene || (options.proof && options.proof.rawScene) || null;
    let dialGrants = new Set();
    const disclosureDial = el('div', 'cinema-disclosure-dial hidden');
    disclosureDial.id = 'cinema-disclosure-dial';
    stage.appendChild(disclosureDial);
    let dialReady = false;
    function toggleDisclosureDial() {
      if (!dialReady) return;
      disclosureDial.classList.toggle('hidden');
    }
    function closeDisclosureDial() { disclosureDial.classList.add('hidden'); }
    function grantsInRaw() {
      if (!rawScene) return [];
      const nodes = Array.isArray(rawScene.nodes) ? rawScene.nodes : Object.values(rawScene.nodes || {});
      const grants = new Set();
      for (const n of nodes) { if (n.grantId) grants.add(n.grantId); if (n.kind === 'disclosure_grant') grants.add(n.id); }
      return [...grants];
    }
    function previewDisclosure() {
      if (!rawScene || !ns.applyDisclosure) return;
      // Translate the selected grant ids into the grant KEYS applyDisclosure
      // checks (owner / "url::label") for the nodes each grant covers — so the
      // preview reveals exactly (and only) what the grant authorizes.
      const granted = new Set();
      const nodes = Array.isArray(rawScene.nodes) ? rawScene.nodes : Object.values(rawScene.nodes || {});
      for (const n of nodes) {
        if (n.grantId && dialGrants.has(n.grantId)) {
          const owner = n.owner || n.url || '';
          if (owner) granted.add(owner);
          granted.add((n.url || '') + '::' + (n.label || n.id));
        }
      }
      onScene(ns.applyDisclosure(rawScene, Object.assign({}, disclosureContext, { grants: granted })));
    }
    function buildDisclosureDial() {
      const grants = grantsInRaw();
      if (!grants.length) { dialReady = false; disclosureDial.classList.add('hidden'); return; }
      disclosureDial.replaceChildren();
      const lab = el('span', 'cinema-dial-label'); lab.textContent = 'Preview as grant:'; disclosureDial.appendChild(lab);
      for (const gid of grants) {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'cinema-dial-chip'; chip.textContent = gid;
        chip.addEventListener('click', () => {
          if (dialGrants.has(gid)) dialGrants.delete(gid); else dialGrants.add(gid);
          chip.classList.toggle('active', dialGrants.has(gid));
          previewDisclosure();
        });
        disclosureDial.appendChild(chip);
      }
      const reset = document.createElement('button');
      reset.type = 'button'; reset.className = 'cinema-dial-reset'; reset.textContent = 'Reset';
      reset.addEventListener('click', () => {
        dialGrants = new Set();
        for (const c of disclosureDial.querySelectorAll('.cinema-dial-chip')) c.classList.remove('active');
        previewDisclosure();
      });
      disclosureDial.appendChild(reset);
      // Built but kept closed — it opens on demand from the disclosure chip,
      // so a sealed scene isn't cluttered by an always-open grant dial.
      dialReady = true;
      disclosureDial.classList.add('hidden');
    }

    // ---- Wave J: vitals (J1), clustering (J2), timeline instrument (J3), projections (J4) ----
    const vitalsHistory = [];
    function updateVitals() {
      if (!vitalsStrip || !ns.computeVitals) return;
      const g = renderer.sceneGraph || {};
      const base = ns.computeVitals(g, []);
      vitalsHistory.push({ t: Date.now(), gas: base.totalGas, edges: base.edges });
      if (vitalsHistory.length > 30) vitalsHistory.shift();
      vitalsStrip.setVitals(ns.computeVitals(g, vitalsHistory), sceneCeiling());
    }
    function vitalsJump(target) {
      let nodes = renderer.sceneGraph ? (Array.isArray(renderer.sceneGraph.nodes) ? renderer.sceneGraph.nodes : Object.values(renderer.sceneGraph.nodes || {})) : [];
      let ids = [];
      const t = String(target);
      if (t.indexOf('breaker:') === 0) { const st = t.split(':')[1]; ids = nodes.filter((n) => n.breakerState === st).map((n) => n.id); }
      else if (t === 'anomaly') ids = nodes.filter((n) => n.anomalyScore > 0 || n.breakerState === 'frozen').map((n) => n.id);
      else if (t === 'sealed') ids = nodes.filter((n) => n.redacted).map((n) => n.id);
      else if (t === 'trust') { const c = sceneCeiling(); pulseLadders(c === 'offline' ? 'replay' : c); return; }
      if (ids.length && renderer.fitToNodes) renderer.fitToNodes(ids);
    }
    function updateClusters() {
      if (ns.clusterScene && renderer.setClusters) renderer.setClusters(ns.clusterScene(renderer.sceneGraph, { by: 'family' }));
    }
    let projMode = 'graph';
    function setProjection(m) {
      projMode = m;
      if (projectionView) projectionView.setMode(m === 'graph' ? null : m, renderer.sceneGraph);
    }

    // ---- Wave K: role lens (K1) + question-based smart chips (K2) ----
    let activeLens = '';
    let activeChip = null;
    function smartCtx() {
      const c = sceneCeiling();
      const drifted = (driftView && driftView.drift) ? new Set(ns.driftedNodeIds(driftView.drift)) : new Set();
      return { anchored: c === 'l0' || c === 'witness', driftedIds: drifted };
    }
    function sceneNodes() {
      const g = renderer.sceneGraph; if (!g) return [];
      return Array.isArray(g.nodes) ? g.nodes : Object.values(g.nodes || {});
    }
    // recomputeDim is the single authority over the lens/chip opacity channel.
    function recomputeDim() {
      const nodes = sceneNodes();
      for (const n of nodes) if (n._origOpacity == null) n._origOpacity = (n.opacity != null ? n.opacity : 1);
      if (activeChip && ns.runSmartFilter) {
        const ids = new Set(ns.runSmartFilter(renderer.sceneGraph, activeChip, smartCtx()));
        matchedIds = [...ids];
        for (const n of nodes) n.opacity = ids.has(n.id) ? n._origOpacity : 0.12;
        if (controls) controls.setSearchCount(matchedIds.length, true);
        filterActive = true;
      } else if (activeLens && ns.lensEmphasis) {
        const ids = new Set(ns.lensEmphasis(renderer.sceneGraph, activeLens));
        for (const n of nodes) n.opacity = (ids.size === 0 || ids.has(n.id)) ? n._origOpacity : 0.4;
        if (controls) controls.setSearchCount(0, false);
        filterActive = false;
      } else {
        for (const n of nodes) n.opacity = n._origOpacity;
        if (controls) controls.setSearchCount(0, false);
        filterActive = false;
      }
      renderer.requestRender();
      refreshOverlay();
    }
    // reapplyDim restores the active dim source (search ▸ chip ▸ lens) for a new scene.
    function reapplyDim() {
      if (currentQuery && currentQuery.trim()) runSearch(currentQuery);
      else if (activeChip || activeLens) recomputeDim();
    }
    function applyRole(role, opts) {
      opts = opts || {};
      activeLens = role || '';
      activeChip = null;
      currentQuery = ''; if (controls) controls.setSearchValue('');
      if (controls) { controls.setSmartActive(null); controls.setLens(activeLens); }
      persistLens(activeLens);
      recomputeDim();
      if (!role || opts.silent) return;
      const L = ns.applyLens(role);
      if (L.view) ctrlSetView(L.view);
      if (L.primaryAction === 'verify') openVerifyTheatre();
      else if (L.primaryAction === 'playStory') { if (cinematic && cinematic.hasStory()) cinematic.play(); }
      else if (L.primaryAction === 'jumpAnomaly') vitalsJump('anomaly');
    }
    function applySmartFilter(id) {
      activeChip = (activeChip === id) ? null : id;
      currentQuery = ''; if (controls) controls.setSearchValue('');
      if (activeChip) { activeLens = ''; if (controls) controls.setLens(''); }
      if (controls) controls.setSmartActive(activeChip);
      recomputeDim();
      if (activeChip && matchedIds.length && renderer.fitToNodes) renderer.fitToNodes(matchedIds);
    }
    function ctrlSetView(m) {
      viewMode = m; applyViewMode(rootEl, m); persistViewMode(mode, m);
      for (const b of rootEl.querySelectorAll('.cinema-view-btn')) { const on = b.dataset.view === m; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    }
    function persistLens(role) { if (mode === 'cinema.full' || mode === 'cinema.nexus') { try { localStorage.setItem('cinema.lens', role || ''); } catch (_) {} } }
    function readLens() { try { return localStorage.getItem('cinema.lens') || ''; } catch (_) { return ''; } }

    // ---- Wave L: shareable moment links (L1) ----
    function numL(v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); }
    function buildMoment() {
      return {
        mode,
        position: (timeline && timeline.state) ? (timeline.state.currentSeq || 0) : 0,
        camera: { x: renderer.camera.x, y: renderer.camera.y, zoom: renderer.camera.zoom },
        view: viewMode,
        lens: activeLens || '',
        query: currentQuery || '',
      };
    }
    function baseUrl() {
      if (options.baseUrl) return options.baseUrl;
      try { if (typeof location !== 'undefined' && location.href) return location.href.split('#')[0]; } catch (_) {}
      return '';
    }
    function applyMoment(m) {
      if (!m) return;
      if (m.view) ctrlSetView(m.view);
      if (m.lens) { activeLens = m.lens; activeChip = null; if (controls) { controls.setLens(m.lens); controls.setSmartActive(null); } }
      // Always set the query to the moment's value — an empty query clears any
      // stale/persisted one so it can't steal the dim channel from the lens.
      currentQuery = m.query || '';
      if (controls) controls.setSearchValue(currentQuery);
      reapplyDim();
      if (m.camera && renderer.camera) { renderer.camera.x = numL(m.camera.x); renderer.camera.y = numL(m.camera.y); renderer.camera.zoom = numL(m.camera.zoom, 1) || 1; renderer._dirty = true; }
      if (typeof m.position === 'number' && timeline && timeline.seek) timeline.seek(m.position);
    }
    function copyText(text) {
      try { if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch (_) {}
      try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); if (ta.select) ta.select(); if (document.execCommand) document.execCommand('copy'); ta.remove(); return true; } catch (_) {}
      return false;
    }
    const toastEl = el('div', 'cinema-toast hidden'); toastEl.id = 'cinema-toast'; stage.appendChild(toastEl);
    let toastTimer = null;
    function toast(msg) { toastEl.textContent = msg; toastEl.classList.remove('hidden'); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1800); }
    function copyMomentLink() { const url = ns.momentToUrl ? ns.momentToUrl(baseUrl(), buildMoment()) : ''; if (url) { copyText(url); toast('Link to this moment copied'); } return url; }
    function copyEmbedSnippet() { const s = ns.embedSnippet ? ns.embedSnippet(baseUrl(), buildMoment()) : ''; if (s) { copyText(s); toast('Embed snippet copied'); } return s; }
    let pendingMoment = (ns.momentFromLocation ? ns.momentFromLocation(typeof location !== 'undefined' ? location.hash : '') : null) || options.moment || null;

    function readLayout() { try { return localStorage.getItem('cinema.layout'); } catch (_) { return null; } }
    function persistLayout(m) {
      if (mode === 'cinema.full' || mode === 'cinema.nexus') { try { localStorage.setItem('cinema.layout', m); } catch (_) {} }
    }

    // ---- Data source resolution ----
    let dataSource = options.dataSource || buildDataSource(mode, options, disclosureContext);

    // ---- Narrative (audit story) + sync (adoption-05) ----
    const proofForNarrative = options.proof || (dataSource && dataSource.proof) || null;
    let sync = null;
    const narrative = ns.NarrativePanel
      ? new ns.NarrativePanel(body, {
          proof: proofForNarrative,
          headlines: options.narrativeHeadlines,
          onCardFocus: (ids) => { if (sync) sync.highlightNodes(ids); },
          onRungClick: (rungId) => highlightRung(rungId),
        })
      : null;
    if (narrative && ns.createNarrativeSync) sync = ns.createNarrativeSync({ renderer, panel: narrative });

    // View mode: graph | narrative | split (orthogonal to the host mode). The
    // toggle is shown wherever there are controls; embed stays canvas-only.
    let viewMode = resolveViewMode(mode, options);
    applyViewMode(rootEl, viewMode);
    // The Graph/Story/Split toggle now lives inside the controls' "View" menu
    // (built below) rather than floating over the top-left of the stage.

    // ---- Timeline + export ----
    const timeline = new ns.TimelineAdapter({
      dataSource, renderer,
      onPosition: (pos) => {
        if (sync) sync.onPosition(pos);
        if (controls) {
          const g = renderer.sceneGraph;
          controls.setPosition(pos, timeline.state.totalSeq || 0, (g && (g.blockHeight || g.BlockHeight)) || 0);
        }
        maybeAnchorMoment(pos); // D3 — fire when the head reaches the anchor stage
      },
    });
    const exporter = new ns.CinemaExport({ renderer, dataSource, mode, commit: options.commit, disclosureContext, timeline });

    // ---- Proof panel ----
    let proofPanel = null;
    if (caps.proof) {
      const proof = options.proof || (dataSource && dataSource.proof) || {};
      proofPanel = new ns.ProofPanel(rootEl, proof, { disclosureContext, onRungClick: (rungId) => highlightRung(rungId) });
      // adoption-06 — mount the SAME proof-receipt component Nexus uses, so
      // Cinema proof mode answers the trust question identically. The receipt
      // is offline (the viewer did not confirm L0 live), so it caps at L3.
      mountCinemaProofReceipt(proofPanel, proof);
    }

    // ---- Controls ----
    let controls = null;
    if (!caps.readOnly) {
      controls = new ns.CinemaControls(controlsHost, {
        capabilities: caps,
        initialLayout: layoutEngine,
        initialView: viewMode,
        canVerify: !!(options.proof || caps.proof || (dataSource && dataSource.proof)),
        handlers: {
          togglePlay: () => { timeline.togglePlay(); controls.setPlaying(timeline.state.playing); },
          stepForward: () => timeline.stepForward(),
          stepBack: () => timeline.stepBackward(),
          seek: (pos) => timeline.seek(pos),
          setSpeed: (s) => timeline.setSpeed(s),
          toggleLoop: (on) => timeline.setLoop(on),
          jumpFailure: jumpFailure,
          jumpEventNext: () => stepEvent(1),
          jumpEventPrev: () => stepEvent(-1),
          fit: () => renderer.fitToView(),
          resetView: () => renderer.resetView(),
          layout: (eng) => { layoutEngine = eng; persistLayout(eng); applyLayout(renderer.sceneGraph, { animate: true, fit: true }); },
          filter: (q) => runSearch(q),
          searchNext: () => stepMatch(1),
          searchPrev: () => stepMatch(-1),
          toggleLegend: () => legend.toggle(),
          export: () => openExportMenu(exporter, rootEl, { copyLink: copyMomentLink, copyEmbed: copyEmbedSnippet }),
          playStory: () => { if (cinematic) cinematic.togglePlay(); },
          verify: () => openVerifyTheatre(),
          toggleDrift: () => toggleDrift(),
          projection: (m) => setProjection(m),
          lens: (role) => applyRole(role),
          smartFilter: (id) => applySmartFilter(id),
          setView: (m) => ctrlSetView(m),
          toggleMinimap: (on) => { if (minimap) minimap.setVisible(on); },
        },
      });
      // Restore a persisted query so a returning operator keeps their filter.
      const q0 = readSearch();
      if (q0) { controls.setSearchValue(q0); runSearch(q0); }
      // Restore a persisted lens (emphasis only — no primary action on restore).
      const lr0 = readLens();
      if (lr0 && !q0) { controls.setLens(lr0); applyRole(lr0, { silent: true }); }
    }

    // ---- Cinematic autoplay (G1) ----
    const cinematic = ns.Cinematic ? new ns.Cinematic({
      renderer, timeline, sync, captionHost: stage,
      getSpeed: () => timeline.state.speed || 1,
      onAnchor: () => maybeAnchorMoment(Number.MAX_SAFE_INTEGER),
      onChange: (playing) => { if (controls) controls.setStoryPlaying(playing); },
    }) : null;
    // While a story is playing, ← / → step shots and Esc exits (capture phase so
    // the transport's own arrow handler doesn't also fire).
    const onCineKey = (e) => {
      if (!cinematic) return;
      const active = cinematic.isPlaying() || cinematic.idx >= 0;
      if (!active) return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === 'Escape') { cinematic.exit(); e.stopPropagation(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { cinematic.next(); e.stopPropagation(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { cinematic.prev(); e.stopPropagation(); e.preventDefault(); }
    };
    document.addEventListener('keydown', onCineKey, true);

    // ---- Wave J components: minimap (J2), projections (J4), timeline track (J3) ----
    const minimap = (!caps.readOnly && ns.Minimap) ? new ns.Minimap(stage, { renderer }) : null;
    const projectionView = ns.ProjectionView ? new ns.ProjectionView(stage, { renderer }) : null;
    let tlInstrument = null;
    if (controls && ns.TimelineInstrument) {
      const wrap = rootEl.querySelector('.cinema-scrubber-wrap');
      if (wrap) tlInstrument = new ns.TimelineInstrument(wrap);
    }

    // ---- Scene wiring ----
    let unsubscribe = () => {};
    function onScene(g) {
      if (g && g.__update) {
        renderer.applyUpdate(g.__update);
        // Place any newcomers that arrived without coordinates, without
        // disturbing the rest (no animation/refit on incremental updates).
        if (ns.needsLayout && ns.needsLayout(renderer.sceneGraph)) applyLayout(renderer.sceneGraph, { animate: false });
        if (a11y) a11y.setScene(renderer.sceneGraph);
        reapplyDim();
        buildNodeAssurance();
        updateDisclosureChip();
        if (agentRibbon) agentRibbon.setScene(renderer.sceneGraph);
        updateTrustAura();
        updateSummary();
        refreshTransport();
        refreshOverlay();
        return;
      }
      renderer.setSceneGraph(g || {});
      applyLayout(renderer.sceneGraph, { animate: !firstScene, fit: firstScene });
      firstScene = false;
      if (narrative) {
        try { narrative.setScene(g || {}, { proof: options.proof || (dataSource && dataSource.proof) || null }); } catch (e) {}
      }
      if (a11y) a11y.setScene(renderer.sceneGraph);
      reapplyDim();
      buildNodeAssurance();
      updateDisclosureChip();
      if (agentRibbon) agentRibbon.setScene(renderer.sceneGraph);
      updateTrustAura();
      updateSummary();
      // A fresh full scene resets any active plan-vs-actual compare (I1).
      if (driftActive) exitDrift();
      lastScene = renderer.sceneGraph;
      updateDriftAvailability();
      // Wave J: refresh clusters (J2), vitals (J1), and the active projection (J4).
      updateClusters();
      updateVitals();
      if (projectionView && projMode !== 'graph') projectionView.render(renderer.sceneGraph);
      // Re-arm the cinematic shot list for the new scene (G1); a first-timer gets
      // the once-ever spotlight (G3).
      if (cinematic) { cinematic.exit(); cinematic.setShots(getEvents(), renderer.sceneGraph); }
      if (spotlight && nodeCountNow() > 0) spotlight.maybeShow();
      // A fresh scene re-arms the one-time anchor-confirmation moment (D3); in
      // proof mode (no live scrubbing) play it once on open.
      anchorFired = false;
      if (mode === 'cinema.proof') maybeAnchorMoment(Number.MAX_SAFE_INTEGER);
      refreshTransport();
      refreshOverlay();
      // Restore a shared moment once the first scene exists (L1).
      if (pendingMoment) { applyMoment(pendingMoment); pendingMoment = null; }
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
        const ds = new ns.StandaloneCinemaDataSource({ wsUrl, sessionId, disclosureContext, onConnectionState });
        dialog.el.classList.add('hidden');
        connectionState = 'connecting';
        refreshOverlay();
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

    // Initial transport + overlay + trust-aura paint (before any scene arrives).
    refreshTransport();
    refreshOverlay();
    updateTrustAura();
    updateSummary();
    buildDisclosureDial();

    // Status loop (raw telemetry fallback) + vitals posture (J1).
    const statusTimer = setInterval(() => { updateStatus(renderer, status); updateVitals(); }, 500);

    return {
      mode, caps, renderer, get dataSource() { return dataSource; }, timeline, controls, legend, exporter, details, proofPanel,
      narrative, sync, get viewMode() { return viewMode; },
      setViewMode(m) { viewMode = m; applyViewMode(rootEl, m); persistViewMode(mode, m); },
      // Wave L — share/restore a framed moment (view state only, no scene data).
      getMoment: buildMoment,
      getMomentUrl() { return ns.momentToUrl ? ns.momentToUrl(baseUrl(), buildMoment()) : ''; },
      applyMoment,
      setScene: onScene,
      destroy() {
        try { unsubscribe(); } catch (e) {}
        clearInterval(statusTimer);
        timeline.destroy();
        if (controls && controls.destroy) controls.destroy();
        if (layoutController) layoutController.destroy();
        if (overlay) overlay.destroy();
        if (tooltip) tooltip.destroy();
        if (a11y) a11y.destroy();
        if (agentRibbon) agentRibbon.destroy();
        if (cinematic) cinematic.destroy();
        if (summaryRibbon) summaryRibbon.destroy();
        if (spotlight) spotlight.destroy();
        if (verifyTheatre) verifyTheatre.destroy();
        if (minimap) minimap.destroy();
        if (projectionView) projectionView.destroy();
        if (tlInstrument) tlInstrument.destroy();
        if (vitalsStrip) vitalsStrip.destroy();
        if (toastTimer) clearTimeout(toastTimer);
        if (bloomTimer) clearTimeout(bloomTimer);
        document.removeEventListener('keydown', onCineKey, true);
        if (sync) sync.destroy();
        if (narrative) narrative.destroy();
        renderer.destroy();
      },
    };
  }

  // mountCinemaProofReceipt dynamic-imports the canonical proof-receipt
  // component (the same files the Nexus prove view uses) and mounts a receipt
  // at the top of the proof panel. Best-effort: if the modules are not
  // reachable (e.g. an offline extension bundle), the proof panel still shows.
  function mountCinemaProofReceipt(proofPanel, proof) {
    if (!proofPanel || !proofPanel.el || typeof Promise === 'undefined') return;
    Promise.all([
      import('/lib/proofReceipt.js'),
      import('/components/proofReceiptView.js'),
    ]).then(([rl, rv]) => {
      const govMatch = String((proof.assurance && proof.assurance.label) || '').match(/G\d/);
      const anchor = proof.anchor || {};
      const receipt = rl.buildReceiptFromVerifier({ passed: true, checks: [] }, {
        subjectType: 'evidence',
        governanceLevel: govMatch ? govMatch[0] : '',
        anchorTx: String(anchor.txHash || ''),
        replayVerified: false,
        verifier: 'Cinema proof viewer',
      });
      const host = document.createElement('div');
      host.className = 'cinema-receipt-host';
      proofPanel.el.insertBefore(host, proofPanel.el.firstChild);
      rv.mountProofReceipt(host, receipt);
    }).catch(() => { /* component not reachable in this host; proof panel still renders */ });
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

  function openExportMenu(exporter, rootEl, share) {
    // Self-describing chooser (F2): every option says what it is and who it's for,
    // grouped into "share a view" vs "share proof". Dismisses on outside-click/Esc.
    const existing = rootEl.querySelector('.cinema-export-menu');
    if (existing) { existing.remove(); return; }
    const menu = el('div', 'cinema-export-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Export and share');

    const groups = [];
    if (share) {
      groups.push(['Share a link', [
        ['Copy link to this moment', 'A URL that reopens this exact framed moment (no scene data).', () => share.copyLink && share.copyLink()],
        ['Copy embed snippet', 'An <iframe> embedding this moment with a live trust ladder.', () => share.copyEmbed && share.copyEmbed()],
      ]]);
    }
    groups.push(
      ['Share a view', [
        ['PNG image', 'A picture of the current frame.', () => exporter.screenshot()],
        ['SVG vector', 'A scalable vector of the scene.', () => exporter.exportSVG()],
        ['Scene JSON', 'The scene graph, with a provenance header.', () => exporter.exportJSON()],
        ['Replay reference', 'A pointer that re-opens this exact position.', () => exporter.replayRef()],
      ]],
      ['Share proof', [
        ['Proof report', 'The full provenance envelope for an auditor.', () => exporter.proofReport()],
      ]],
    );
    for (const [heading, items] of groups) {
      const h = el('div', 'cinema-export-group'); h.textContent = heading; menu.appendChild(h);
      for (const [label, desc, fn] of items) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'cinema-export-item'; b.setAttribute('role', 'menuitem');
        const t = el('span', 'cinema-export-item-label'); t.textContent = label;
        const d = el('span', 'cinema-export-item-desc'); d.textContent = desc;
        b.appendChild(t); b.appendChild(d);
        b.addEventListener('click', () => { try { fn(); } catch (e) {} close(); });
        menu.appendChild(b);
      }
    }

    function close() {
      menu.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    function onOutside(e) { if (!menu.contains(e.target)) close(); }
    document.addEventListener('keydown', onKey, true);
    // Defer so the click that opened the menu doesn't immediately close it.
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);

    rootEl.appendChild(menu);
    const first = menu.querySelector('.cinema-export-item');
    if (first && first.focus) first.focus();
  }

  function updateStatus(renderer, status) {
    if (!renderer || !status) return;
    const s = renderer.getStats();
    const g = renderer.sceneGraph;
    setText(status, 'status-nodes', `Nodes: ${s.nodes}`);
    setText(status, 'status-edges', `Edges: ${s.edges}`);
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
