/**
 * Infrix Cinema — canonical scene renderer.
 *
 * This is THE single Cinema renderer. Every Cinema surface (standalone full,
 * Nexus-mounted, embed widget, portable proof) draws through this class; no
 * surface ships its own scene renderer. It draws the SceneGraph
 * (pkg/cinema/scene) on a Canvas 2D context with pan/zoom, node selection,
 * hover, animated edge particles, and a translucent ghost overlay.
 *
 * Moved here from tools/cinema-viewer/js/renderer.js as part of Priority 05
 * (one canonical Cinema product surface). The old path is a deprecation shim.
 *
 * Loaded as a classic script; attaches CinemaRenderer to window.InfrixCinema.
 */
(function (root) {
  'use strict';

  // Canvas font strings must be concrete — ctx.font does NOT resolve CSS var().
  const FONT_UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const FONT_MONO = 'SFMono-Regular, Menlo, Consolas, monospace';

  // A pointer gesture is a click (not a pan) only if it moves less than this (CSS px).
  const DRAG_THRESHOLD = 4;
  // First-encounter kind hint window (G3): teach the vocabulary in context.
  const KIND_HINT_MS = 3000;
  function humanKind(kind) { return String(kind || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()); }
  function easeInOutRenderer(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function rendererReducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  }

  // Motion hierarchy (D2): a single "attention" node animates; everything else
  // stays calm. severityOf ranks how much a node demands attention.
  function severityOf(node) {
    if (!node) return 0;
    if (node.breakerState === 'frozen') return 100;
    if (node.anomalyScore > 0) return 60 + Math.min(1, node.anomalyScore) * 20;
    if (node.breakerState === 'paused') return 50;
    if (node.quarantined) return 40;
    if (node.breakerState === 'throttled') return 20;
    return 0;
  }
  function computeAttention(nodes) {
    let best = null, bestSev = 0;
    for (const n of (nodes || [])) {
      const s = severityOf(n);
      if (s > bestSev) { bestSev = s; best = n.id; }
    }
    return bestSev > 0 ? best : null;
  }

class CinemaRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.sceneGraph = null;
        this.camera = { x: 0, y: 0, zoom: 1.0 };
        this.selectedNode = null;
        this.hoveredNode = null;
        this.hoveredEdge = null;
        this.animationFrame = null;
        this.ghostGraph = null;
        this.isDragging = false;
        this.lastMouse = { x: 0, y: 0 };
        this.particlePhase = 0;
        this.eventHandlers = new Map();
        this.frameCount = 0;
        this.lastFPSTime = (typeof performance !== 'undefined' ? performance.now() : 0);
        this.fps = 0;
        this.nodeEntryTimes = new Map();  // nodeId -> performance.now()
        this.edgeEntryTimes = new Map();  // "from→to" -> performance.now()

        // HiDPI (A3): backing store is scaled by devicePixelRatio; cssWidth/Height
        // are the logical pixels every coordinate calculation uses.
        this.dpr = 1;
        this.cssWidth = 0;
        this.cssHeight = 0;
        // Layout lanes (A1) drawn behind the graph in spine mode.
        this._lanes = null;
        // Per-node rendered radius cache (label anchoring + future hit-testing).
        this._nodeRenderRadius = new Map();
        // Label candidates collected during drawGraph, placed in render() (A5).
        this._labelCandidates = [];
        // Keyboard focus ring target (B5) + camera animation handle (B1/B4).
        this._focusedNode = null;
        this._camRaf = null;
        // Anchor-confirmation moment (D3): {evId, anId, start} while playing.
        this._anchorMoment = null;
        // Causal trace path (H2): Set of "from→to" keys lit as a golden chain.
        this._tracePath = null;
        // Drift edges (I1): [{fromId(ghost), toId(actual), drift}] for plan-vs-actual.
        this._driftEdges = null;
        // Semantic clustering LOD (J2): below _lodZoom, draw clusters not nodes.
        this._clusters = null;
        this._lodZoom = 0.4;
        // Motion hierarchy (D2): reduced-motion flag + the single attention node.
        this.reducedMotion = rendererReducedMotion();
        this._attentionFocus = null;

        // Performance (E): dirty-flag rendering + precomputed aggregation + a
        // spatial grid for hit-testing. Debug HUD is opt-in only (F1).
        this._dirty = true;
        this._agg = null;
        this._viewRect = null;
        this._hitGrid = new Map();
        this._hitCell = 80;
        this._sceneHasAnimatedEdges = false;
        this._sceneHasSealed = false;
        this._lastSceneChange = 0;
        this.debug = !!(root.__INFRIX_CINEMA_DEBUG__);
        // First-encounter kind hints (G3).
        this.showKindHints = true;
        this._kindFirstSeen = new Map();
        this._kindHintUntil = 0;
        this._mql = null;
        try {
            if (typeof window !== 'undefined' && window.matchMedia) {
                this._mql = window.matchMedia('(prefers-reduced-motion: reduce)');
                this._onMotionPref = (e) => { this.reducedMotion = !!(e && e.matches); };
                if (this._mql.addEventListener) this._mql.addEventListener('change', this._onMotionPref);
            }
        } catch (_) {}

        this.resizeCanvas();
        this._onResize = () => this.resizeCanvas();
        if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
            this._resizeObserver = new ResizeObserver(this._onResize);
            this._resizeObserver.observe(this.canvas.parentElement);
        } else {
            window.addEventListener('resize', this._onResize);
        }
        this.setupInteraction();
        this.startAnimationLoop();
    }

    resizeCanvas() {
        const parent = this.canvas.parentElement;
        const cssW = (parent ? parent.clientWidth : this.canvas.width) || 0;
        const cssH = (parent ? parent.clientHeight : this.canvas.height) || 0;
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        this.dpr = dpr;
        this.cssWidth = cssW;
        this.cssHeight = cssH;
        this.canvas.width = Math.max(1, Math.round(cssW * dpr));
        this.canvas.height = Math.max(1, Math.round(cssH * dpr));
        this.canvas.style.width = cssW + 'px';
        this.canvas.style.height = cssH + 'px';
        this.requestRender();
    }

    /** setLayoutLanes stores spine-lane metadata (from layout.js) to draw behind
     *  the graph; null clears it. */
    setLayoutLanes(lanes) { this._lanes = (lanes && lanes.length) ? lanes : null; this._dirty = true; }

    /** setTracePath lights a causal chain (H2); keys are "from→to" strings. */
    setTracePath(keys) { this._tracePath = (keys && keys.length) ? new Set(keys) : null; this._dirty = true; }
    clearTracePath() { this._tracePath = null; this._dirty = true; }

    /** setDriftEdges draws predicted→actual divergence edges (I1). */
    setDriftEdges(edges) { this._driftEdges = (edges && edges.length) ? edges : null; this._dirty = true; }

    /** setClusters supplies the overview clustering (J2); shown below _lodZoom. */
    setClusters(c) { this._clusters = (c && c.clusters && c.clusters.length) ? c : null; this._dirty = true; }
    _clusterLOD() { return !!(this._clusters && this.camera.zoom < this._lodZoom); }
    _drawClusters() {
        const ctx = this.ctx;
        const { clusters, clusterEdges } = this._clusters;
        const byId = new Map();
        for (const c of clusters) byId.set(c.id, c);
        for (const e of (clusterEdges || [])) {
            const a = byId.get(e.fromId), b = byId.get(e.toId);
            if (!a || !b) continue;
            ctx.beginPath();
            ctx.moveTo(a.position.x, a.position.y); ctx.lineTo(b.position.x, b.position.y);
            ctx.strokeStyle = 'rgba(120,150,200,0.4)';
            ctx.lineWidth = Math.min(10, 1 + e.count * 0.5);
            ctx.stroke();
        }
        for (const c of clusters) {
            const rr = 14 + Math.min(44, Math.sqrt(c.count) * 9);
            ctx.beginPath(); ctx.arc(c.position.x, c.position.y, rr, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(60,80,140,0.85)'; ctx.fill();
            ctx.strokeStyle = 'rgba(140,170,230,0.9)'; ctx.lineWidth = 2; ctx.stroke();
            const fs = Math.max(11, 13 / this.camera.zoom);
            ctx.fillStyle = '#dfe4f2'; ctx.font = `700 ${fs}px ${FONT_UI}`; ctx.textAlign = 'center';
            ctx.fillText(humanKind(c.label), c.position.x, c.position.y - 2);
            ctx.font = `${Math.max(10, 11 / this.camera.zoom)}px ${FONT_UI}`; ctx.fillStyle = '#aab2d9';
            ctx.fillText(c.count + ' nodes', c.position.x, c.position.y + fs);
        }
    }
    _indexNodes(graph) {
        const m = new Map();
        if (!graph) return m;
        let nodes = graph.nodes || graph.Nodes;
        if (!nodes) return m;
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        for (const n of nodes) m.set(n.id, n);
        return m;
    }
    _drawDriftEdges() {
        const ctx = this.ctx;
        const gmap = this._indexNodes(this.ghostGraph);
        const amap = this._indexNodes(this.sceneGraph);
        for (const e of this._driftEdges) {
            if (!e.drift) continue;
            const g = gmap.get(e.fromId), a = amap.get(e.toId);
            if (!g || !a || !g.position || !a.position) continue;
            ctx.beginPath();
            ctx.moveTo(g.position.x, g.position.y);
            ctx.lineTo(a.position.x, a.position.y);
            ctx.strokeStyle = 'rgba(244,67,54,0.85)';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([5, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    setSceneGraph(graph) {
        const isFirst = !this.sceneGraph;
        const now = performance.now();

        // Track node entries for animation
        let nodes = graph.nodes || graph.Nodes || {};
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        const currentNodeIds = new Set(nodes.map(n => n.id));
        currentNodeIds.forEach(id => {
            if (!this.nodeEntryTimes.has(id)) this.nodeEntryTimes.set(id, now);
        });

        // First-encounter kind hints (G3): the first time a node-kind appears this
        // session, schedule a brief in-context label so the vocabulary self-teaches.
        if (this.showKindHints) {
            for (const n of nodes) {
                if (n.kind && !this._kindFirstSeen.has(n.kind)) {
                    this._kindFirstSeen.set(n.kind, now);
                    this._kindHintUntil = now + KIND_HINT_MS;
                }
            }
        }
        for (const id of this.nodeEntryTimes.keys()) {
            if (!currentNodeIds.has(id)) this.nodeEntryTimes.delete(id);
        }

        // Track edge entries
        let edges = graph.edges || graph.Edges || {};
        if (!Array.isArray(edges)) edges = Object.values(edges);
        const currentEdgeKeys = new Set();
        (Array.isArray(edges) ? edges : Object.values(edges)).forEach(e => {
            currentEdgeKeys.add((e.fromNodeId || '') + '→' + (e.toNodeId || ''));
        });
        currentEdgeKeys.forEach(key => {
            if (!this.edgeEntryTimes.has(key)) this.edgeEntryTimes.set(key, now);
        });
        for (const key of this.edgeEntryTimes.keys()) {
            if (!currentEdgeKeys.has(key)) this.edgeEntryTimes.delete(key);
        }

        this.sceneGraph = graph;
        this._computeAttention();
        this._refreshAggregate();
        if (isFirst) this.fitToView();
        this.requestRender();
    }

    // _computeAttention picks the single highest-severity node so only it animates.
    _computeAttention() {
        let nodes = this.sceneGraph && (this.sceneGraph.nodes || this.sceneGraph.Nodes);
        if (!nodes) { this._attentionFocus = null; return; }
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        this._attentionFocus = computeAttention(nodes);
    }

    // _aggregate groups parallel edges into per-pair traffic, computes per-node
    // activity, and flags animated/sealed presence — once per scene change (E4)
    // rather than every frame.
    _aggregate(nodes, edges) {
        if (!Array.isArray(nodes)) nodes = nodes ? Object.values(nodes) : [];
        if (!Array.isArray(edges)) edges = edges ? Object.values(edges) : [];
        const nodeMap = new Map();
        nodes.forEach(n => nodeMap.set(n.id, n));
        const edgeTraffic = {};
        let hasAnimatedEdges = false;
        edges.forEach(edge => {
            const key = (edge.fromNodeId || '') + '→' + (edge.toNodeId || '');
            let t = edgeTraffic[key];
            if (!t) t = edgeTraffic[key] = { count: 0, totalGas: 0, label: '', animated: false, color: null, fromId: edge.fromNodeId, toId: edge.toNodeId };
            t.count++;
            t.totalGas += (edge.gasCost || 0);
            t.label = edge.label || edge.function || t.label;
            if (edge.animated) { t.animated = true; hasAnimatedEdges = true; }
            if (edge.color) t.color = edge.color;
        });
        const nodeActivity = {};
        Object.values(edgeTraffic).forEach(t => {
            nodeActivity[t.toId] = (nodeActivity[t.toId] || 0) + t.count;
            nodeActivity[t.fromId] = (nodeActivity[t.fromId] || 0) + t.count;
        });
        let hasSealed = false;
        for (const n of nodes) { if (n.redacted || n.zkIndicator) { hasSealed = true; break; } }
        return { nodeMap, edgeTraffic, nodeActivity, hasAnimatedEdges, hasSealed };
    }

    _refreshAggregate() {
        if (!this.sceneGraph) { this._agg = null; return; }
        this._agg = this._aggregate(this.sceneGraph.nodes || this.sceneGraph.Nodes, this.sceneGraph.edges || this.sceneGraph.Edges);
        this._edgeTraffic = this._agg.edgeTraffic;
        this._nodeActivity = this._agg.nodeActivity;
        this._nodeMap = this._agg.nodeMap;
        this._sceneHasAnimatedEdges = this._agg.hasAnimatedEdges;
        this._sceneHasSealed = this._agg.hasSealed;
        this._lastSceneChange = (typeof performance !== 'undefined' ? performance.now() : 0);
    }

    _inView(pos, pad) {
        const r = this._viewRect;
        if (!r || !pos) return true;
        return pos.x >= r.x0 - pad && pos.x <= r.x1 + pad && pos.y >= r.y0 - pad && pos.y <= r.y1 + pad;
    }

    fitToView() {
        if (!this.sceneGraph) return;
        let nodes = this.sceneGraph.nodes || this.sceneGraph.Nodes || [];
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        if (nodes.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            if (!n.position) return;
            const r = (n.size || 10) + 20;
            if (n.position.x - r < minX) minX = n.position.x - r;
            if (n.position.y - r < minY) minY = n.position.y - r;
            if (n.position.x + r > maxX) maxX = n.position.x + r;
            if (n.position.y + r > maxY) maxY = n.position.y + r;
        });

        const graphW = maxX - minX || 1;
        const graphH = maxY - minY || 1;
        const padded = 0.85; // leave 15% padding
        const zoomX = (this.cssWidth * padded) / graphW;
        const zoomY = (this.cssHeight * padded) / graphH;
        this.camera.zoom = Math.min(zoomX, zoomY, 2.0);
        // Center on graph midpoint
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        this.camera.x = -cx * this.camera.zoom;
        this.camera.y = -cy * this.camera.zoom;
        this._dirty = true;
    }

    applyUpdate(update) {
        if (!this.sceneGraph) return;

        // Handle both camelCase and Go PascalCase field names
        const added = update.nodesAdded || update.NodesAdded || update.addedNodes || [];
        const removed = update.nodesRemoved || update.NodesRemoved || update.removedNodeIds || [];
        const addedEdges = update.edgesAdded || update.EdgesAdded || update.addedEdges || [];
        const removedEdges = update.edgesRemoved || update.EdgesRemoved || update.removedEdgeIds || [];

        // Ensure nodes is an object (map) -- the Go SceneGraph uses map[string]*SceneNode
        if (!this.sceneGraph.nodes) this.sceneGraph.nodes = {};
        if (Array.isArray(this.sceneGraph.nodes)) {
            // Convert array to map if needed
            const map = {};
            this.sceneGraph.nodes.forEach(n => { map[n.id || n.ID] = n; });
            this.sceneGraph.nodes = map;
        }

        added.forEach(n => { this.sceneGraph.nodes[n.id || n.ID] = n; });
        removed.forEach(id => { delete this.sceneGraph.nodes[id]; });

        if (!this.sceneGraph.edges) this.sceneGraph.edges = {};
        if (Array.isArray(this.sceneGraph.edges)) {
            const map = {};
            this.sceneGraph.edges.forEach(e => { map[e.id || e.ID] = e; });
            this.sceneGraph.edges = map;
        }

        addedEdges.forEach(e => { this.sceneGraph.edges[e.id || e.ID] = e; });
        removedEdges.forEach(id => { delete this.sceneGraph.edges[id]; });

        this._computeAttention();
        this._refreshAggregate();
        this.requestRender();
    }

    setGhostGraph(ghostGraph) {
        this.ghostGraph = ghostGraph;
        this.requestRender();
    }

    clearGhostGraph() {
        this.ghostGraph = null;
        this.requestRender();
    }

    resetView() {
        this.camera = { x: 0, y: 0, zoom: 1.0 };
        this.requestRender();
    }

    requestRender() { this._dirty = true; }

    // _needsContinuousAnimation: is anything actually moving this frame? When
    // false AND not dirty, render() skips entirely so an idle scene costs ~0 CPU
    // (E3). Reduced-motion makes idle truly idle.
    _needsContinuousAnimation() {
        if (this._anchorMoment || this._camRaf) return true;
        if (this.reducedMotion) return false;
        const tnow = (typeof performance !== 'undefined' ? performance.now() : 0);
        if (tnow - (this._lastSceneChange || 0) < 650) return true; // entry animations
        if (tnow < this._kindHintUntil) return true;               // first-encounter hints (G3)
        return !!this._sceneHasAnimatedEdges || !!this._attentionFocus || !!this._sceneHasSealed;
    }

    startAnimationLoop() {
        const loop = () => {
            this.render();
            this.animationFrame = requestAnimationFrame(loop);
        };
        loop();
    }

    render() {
        // Dirty-flag rendering (E3): skip the whole frame when nothing changed
        // and nothing is animating.
        if (!this._dirty && !this._needsContinuousAnimation()) return;
        this._dirty = false;
        this.particlePhase += 0.02;
        this.frameCount++;
        {
            const t = performance.now();
            if (t - this.lastFPSTime > 1000) {
                this.fps = Math.round(this.frameCount * 1000 / (t - this.lastFPSTime));
                this.frameCount = 0;
                this.lastFPSTime = t;
            }
        }

        const { ctx, camera } = this;
        const w = this.cssWidth, h = this.cssHeight;
        // Establish a CSS-pixel coordinate space scaled by dpr so everything is
        // crisp on HiDPI displays (A3); all math below is in logical pixels.
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // Visible world rect for viewport culling (E1).
        const z = camera.zoom || 1;
        this._viewRect = {
            x0: (-w / 2 - camera.x) / z, x1: (w / 2 - camera.x) / z,
            y0: (-h / 2 - camera.y) / z, y1: (h / 2 - camera.y) / z,
        };

        // Background gradient + subtle vignette for depth.
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#0a0a1a');
        grad.addColorStop(1, '#0e0e24');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Depth (D1): parallax dot-field + vignette, in screen space.
        this._drawBackdrop();

        ctx.save();
        ctx.translate(w / 2 + camera.x, h / 2 + camera.y);
        ctx.scale(camera.zoom, camera.zoom);

        // Spine lanes (A1) sit behind everything.
        if (this._lanes) this.drawLanes(this._lanes);

        this._labelCandidates = [];
        this._nodeRenderRadius.clear();

        // Ghost overlay (translucent)
        if (this.ghostGraph) {
            ctx.globalAlpha = 0.25;
            this.drawGraph(this.ghostGraph, true);
            ctx.globalAlpha = 1.0;
        }

        // Main graph — or, at altitude, the semantic clusters (J2 LOD).
        if (this._clusterLOD()) {
            this._drawClusters();
        } else if (this.sceneGraph) {
            this.drawGraph(this.sceneGraph, false);
        }

        // Drift edges (I1) + anchor-confirmation moment (D3), in world space.
        if (this._driftEdges) this._drawDriftEdges();
        if (this._anchorMoment) this._drawAnchorMoment();

        ctx.restore();

        // Labels are drawn last, in screen space, with collision avoidance (A5).
        this.drawLabels();
        if (this.debug) this.drawHUD(); // dev-only FPS HUD (F1)
    }

    // _drawBackdrop adds spatial depth (D1): a faint dot-field that drifts with
    // panning (parallax) + an edge vignette. Drawn in screen space.
    _drawBackdrop() {
        const { ctx, camera } = this;
        const w = this.cssWidth, h = this.cssHeight;
        const gap = 44;
        const ox = ((camera.x % gap) + gap) % gap;
        const oy = ((camera.y % gap) + gap) % gap;
        ctx.fillStyle = 'rgba(150,160,210,0.05)';
        for (let x = ox; x < w; x += gap) {
            for (let y = oy; y < h; y += gap) ctx.fillRect(x, y, 1.4, 1.4);
        }
        const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, 'rgba(0,0,0,0.38)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
    }

    // drawLanes paints faint vertical bands + headers for the spine layout so
    // the graph reads as the governance pipeline Intent → … → Witness.
    drawLanes(lanes) {
        const { ctx } = this;
        const laneW = 240;
        for (const lane of lanes) {
            const x = lane.x;
            const y0 = lane.y0, y1 = lane.y1;
            ctx.fillStyle = 'rgba(255,255,255,0.018)';
            ctx.fillRect(x - laneW / 2, y0, laneW, Math.max(0, y1 - y0));
            // lane divider
            ctx.strokeStyle = 'rgba(140,148,189,0.10)';
            ctx.lineWidth = 1 / this.camera.zoom;
            ctx.beginPath();
            ctx.moveTo(x - laneW / 2, y0);
            ctx.lineTo(x - laneW / 2, y1);
            ctx.stroke();
            // header (drawn at constant-ish size via inverse zoom)
            ctx.fillStyle = 'rgba(170,178,209,0.55)';
            const fs = Math.max(11, 13 / this.camera.zoom);
            ctx.font = `600 ${fs}px ${FONT_UI}`;
            ctx.textAlign = 'center';
            ctx.fillText(String(lane.label).toUpperCase(), x, y0 - 8);
        }
    }

    drawGraph(graph, isGhost) {
        const { ctx } = this;
        // Nodes/edges may be arrays or objects (Go maps serialize as JSON objects)
        let nodes = graph.nodes || graph.Nodes || [];
        let edges = graph.edges || graph.Edges || [];
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        if (!Array.isArray(edges)) edges = Object.values(edges);

        // Use the precomputed aggregation for the main scene (E4); the ghost
        // overlay (rare) computes inline.
        const agg = isGhost ? this._aggregate(nodes, edges) : (this._agg || (this._agg = this._aggregate(nodes, edges)));
        const nodeMap = agg.nodeMap;
        const edgeTraffic = agg.edgeTraffic;
        const vr = this._viewRect;

        // Draw aggregated edges -- one line per pair, thickness = traffic volume
        const now_e = performance.now();
        Object.values(edgeTraffic).forEach(traffic => {
            const from = nodeMap.get(traffic.fromId);
            const to = nodeMap.get(traffic.toId);
            if (!from || !to) return;
            if (!from.position || !to.position) return;

            // Viewport culling (E1): skip edges whose bounding box is off-screen.
            if (vr) {
                const exMin = Math.min(from.position.x, to.position.x), exMax = Math.max(from.position.x, to.position.x);
                const eyMin = Math.min(from.position.y, to.position.y), eyMax = Math.max(from.position.y, to.position.y);
                if (exMax < vr.x0 - 30 || exMin > vr.x1 + 30 || eyMax < vr.y0 - 30 || eyMin > vr.y1 + 30) return;
            }

            // Edge entry animation (300ms grow from source to target)
            const edgeKey = (traffic.fromId || '') + '→' + (traffic.toId || '');
            const edgeEntry = this.edgeEntryTimes.get(edgeKey) || 0;
            const edgeAge = now_e - edgeEntry;
            const edgeT = Math.min(1, edgeAge / 300);

            const c = traffic.color || { r: 100, g: 150, b: 255, a: 200 };

            // Dim edges whose endpoints were filtered out (B4): tie edge alpha to
            // the dimmer of the two node opacities so the filter reads on edges too.
            const fOp = from.opacity == null ? 1 : from.opacity;
            const tOp = to.opacity == null ? 1 : to.opacity;
            const dim = Math.min(fOp, tOp) < 1 ? 0.22 : 1;

            // Edge thickness grows with call count (min 2, max 12)
            const thickness = Math.min(12, 2 + traffic.count * 1.5);

            // Interpolated endpoint for entry animation
            const tx = from.position.x + (to.position.x - from.position.x) * edgeT;
            const ty = from.position.y + (to.position.y - from.position.y) * edgeT;

            // Edge glow based on traffic
            const glowSize = thickness + 6;
            ctx.beginPath();
            ctx.moveTo(from.position.x, from.position.y);
            ctx.lineTo(tx, ty);
            ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${0.15 * edgeT * dim})`;
            ctx.lineWidth = glowSize;
            ctx.stroke();

            // Main edge line
            ctx.beginPath();
            ctx.moveTo(from.position.x, from.position.y);
            ctx.lineTo(tx, ty);
            ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${0.7 * edgeT * dim})`;
            ctx.lineWidth = thickness;
            ctx.stroke();

            // Causal trace overlay (H2): a bright golden line over chain edges.
            if (!isGhost && this._tracePath && this._tracePath.has(edgeKey)) {
                ctx.beginPath();
                ctx.moveTo(from.position.x, from.position.y);
                ctx.lineTo(to.position.x, to.position.y);
                ctx.strokeStyle = 'rgba(255,215,0,0.95)';
                ctx.lineWidth = thickness + 3;
                ctx.stroke();
            }

            // Edge label collected for the screen-space de-clutter pass (A5).
            const isHov = this.hoveredEdge && this.hoveredEdge.fromId === traffic.fromId && this.hoveredEdge.toId === traffic.toId;
            if (!isGhost && traffic.label && (dim === 1 || isHov)) {
                const midX = (from.position.x + to.position.x) / 2;
                const midY = (from.position.y + to.position.y) / 2;
                const callLabel = traffic.count > 1 ? `${traffic.label} (×${traffic.count})` : traffic.label;
                this._labelCandidates.push({
                    kind: 'edge', wx: midX, wy: midY, anchorPx: 0,
                    text: callLabel,
                    sub: traffic.totalGas > 0 ? `${traffic.totalGas.toLocaleString()} gas` : '',
                    color: '#e8ebf7', subColor: '#f0a030',
                    priority: 100 + traffic.count, force: !!isHov,
                    minZoom: isHov ? 0 : 0.7,
                });
            }

            // Ambient flow particles (D2) — calm: fewer/smaller, and frozen under
            // reduced-motion. The one ambient layer, never competing for attention.
            if (traffic.animated && !isGhost && dim === 1 && !this.reducedMotion) {
                const particleEdge = {
                    particleCount: Math.min(5, 1 + traffic.count),
                    particleSpeed: 1.2 + traffic.count * 0.22,
                    particleSize: Math.min(5, 2 + traffic.count * 0.4),
                };
                this.drawFlowParticle(from.position, to.position, particleEdge, c);
            }
        });

        const nodeActivity = agg.nodeActivity;
        // Rebuild the spatial hit-grid for the main scene this frame (E1).
        if (!isGhost) { this._hitGrid = new Map(); this._edgeTraffic = edgeTraffic; this._nodeActivity = nodeActivity; this._nodeMap = nodeMap; }

        // Draw nodes
        const now = performance.now();
        const cell = this._hitCell;
        nodes.forEach((node, nodeIdx) => {
            if (!node.position) return;
            // Viewport culling (E1): skip nodes whose disc is off-screen.
            if (vr && !this._inView(node.position, (node.size || 10) + 50)) return;
            const activity = nodeActivity[node.id] || 0;

            // Entry animation (500ms scale-up + fade-in)
            const entryTime = this.nodeEntryTimes.get(node.id) || 0;
            const entryAge = now - entryTime;
            const entryT = Math.min(1, entryAge / 500);
            // Ease-out-back for overshoot bounce: t * (2.7*t - 1.7)
            const entryScale = entryT < 1 ? entryT * (2.7 * entryT * entryT - 1.7 * entryT + 1) : 1;
            const entryAlpha = Math.min(1, entryT * 2);

            // Motion hierarchy (D2): only the single attention-focus node pulses;
            // every other node holds a steady size, so the eye lands on what matters
            // instead of a field of competing throbs.
            const motion = !this.reducedMotion;
            const isFocus = !isGhost && node.id === this._attentionFocus;
            const pulseAmount = (motion && isFocus) ? Math.sin(this.particlePhase * 3) * 2.5 : 0;
            const activityBonus = Math.min(15, activity * 2);
            const baseSize = (node.size || 10) + activityBonus;
            const radius = (baseSize + pulseAmount) * entryScale * (this.selectedNode === node.id ? 1.3 : 1.0);

            const c = node.color || { r: 80, g: 200, b: 120, a: 255 };
            const alpha = (node.opacity || 1) * (c.a || 255) / 255 * entryAlpha;

            // Cache the actual rendered radius (label anchoring + hit testing).
            if (!isGhost) this._nodeRenderRadius.set(node.id, radius);

            // Nodes never jitter (D2): the static dashed hazard border below is the
            // legible quarantine indicator; the shake is gone.
            const nx = node.position.x;
            const ny = node.position.y;

            // Insert into the spatial hit-grid (E1) — main scene only.
            if (!isGhost) {
                const key = Math.floor(nx / cell) + ',' + Math.floor(ny / cell);
                let bucket = this._hitGrid.get(key);
                if (!bucket) this._hitGrid.set(key, (bucket = []));
                bucket.push({ id: node.id, x: nx, y: ny, r: radius, idx: nodeIdx });
            }

            // Anomaly glow — pulses ONLY when this is the attention focus; other
            // anomalous nodes get a calm static glow that is still clearly red.
            if (node.anomalyScore > 0 && !isGhost) {
                const glowR = radius + 20 * Math.min(1, node.anomalyScore) + (isFocus ? 6 : 0);
                const ga = (motion && isFocus) ? (0.28 + 0.16 * Math.sin(this.particlePhase * 4)) : 0.2;
                const grad = ctx.createRadialGradient(nx, ny, radius, nx, ny, glowR);
                grad.addColorStop(0, `rgba(255,87,34,${ga})`);
                grad.addColorStop(1, 'rgba(255,87,34,0)');
                ctx.beginPath();
                ctx.arc(nx, ny, glowR, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
            }

            // Circuit breaker ring — static dashed ring; gentle pulse + slow spin
            // ONLY for the attention focus, otherwise calm and legible.
            if (node.breakerState && !isGhost) {
                const ringR = radius + 6;
                const animate = motion && isFocus;
                let ringColor;
                if (node.breakerState === 'throttled') {
                    ringColor = `rgba(255,193,7,${animate ? 0.4 + 0.3 * Math.sin(this.particlePhase * 2) : 0.65})`;
                } else if (node.breakerState === 'paused') {
                    ringColor = `rgba(255,152,0,${animate ? 0.5 + 0.3 * Math.sin(this.particlePhase * 4) : 0.72})`;
                } else if (node.breakerState === 'frozen') {
                    ringColor = `rgba(244,67,54,${animate ? 0.6 + 0.4 * Math.abs(Math.sin(this.particlePhase * 8)) : 0.85})`;
                }
                if (ringColor) {
                    ctx.beginPath();
                    ctx.arc(nx, ny, ringR, 0, Math.PI * 2);
                    ctx.strokeStyle = ringColor;
                    ctx.lineWidth = 3;
                    ctx.setLineDash([4, 4]);
                    ctx.lineDashOffset = animate ? this.particlePhase * 20 : 0;
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }

            // Activity glow ring
            const glow = node.glow || 0;
            if (activity > 0 || glow > 0) {
                const glowRadius = radius + 8 + activity * 2;
                const glowAlpha = Math.min(0.4, 0.1 + activity * 0.05 + glow * 0.3) * entryAlpha;
                ctx.beginPath();
                ctx.arc(nx, ny, glowRadius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${glowAlpha})`;
                ctx.fill();
            }

            // Hover/select glow
            if (this.hoveredNode === node.id || this.selectedNode === node.id) {
                ctx.beginPath();
                ctx.arc(nx, ny, radius + 6, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.2)`;
                ctx.fill();
            }

            // Keyboard focus ring (B5) — distinct dashed accent ring.
            if (this._focusedNode === node.id && !isGhost) {
                ctx.beginPath();
                ctx.arc(nx, ny, radius + 9, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(92,212,228,0.95)';
                ctx.lineWidth = 2.5;
                ctx.setLineDash([5, 4]);
                ctx.lineDashOffset = motion ? -this.particlePhase * 15 : 0;
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Node shape
            ctx.beginPath();
            if (node.shape === 'hexagon') {
                this.drawHexagon(ctx, nx, ny, radius);
            } else if (node.shape === 'diamond') {
                this.drawDiamond(ctx, nx, ny, radius);
            } else if (node.shape === 'rectangle') {
                ctx.rect(nx - radius, ny - radius * 0.6, radius * 2, radius * 1.2);
            } else {
                ctx.arc(nx, ny, radius, 0, Math.PI * 2);
            }
            ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
            ctx.fill();

            // Plan nodes get dashed borders
            if (node.kind === 'plan_timeline' || node.kind === 'plan_step') {
                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${Math.min(alpha + 0.4, 1)})`;
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.setLineDash([]);
            } else {
                ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${Math.min(alpha + 0.3, 1)})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // Quarantine dashed border
            if (node.quarantined) {
                ctx.beginPath();
                if (node.shape === 'hexagon') {
                    this.drawHexagon(ctx, nx, ny, radius + 3);
                } else {
                    ctx.arc(nx, ny, radius + 3, 0, Math.PI * 2);
                }
                ctx.strokeStyle = '#ff4444';
                ctx.lineWidth = 2;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Sealed (disclosure-redacted) treatment (C2): a deliberate frosted
            // look — a sweeping shimmer + a dashed seal ring + a centered lock —
            // NOT a bare emoji. Fixed size/opacity are already enforced upstream
            // so this never leaks the hidden value's magnitude. A node that is
            // disclosable via a held grant gets an "unlockable" accent ring.
            if ((node.redacted || node.zkIndicator) && !isGhost) {
                const disclosable = !!node.grantId;
                // frosted overlay disc
                ctx.beginPath();
                ctx.arc(nx, ny, radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(220,224,236,${0.10 * entryAlpha})`;
                ctx.fill();
                // shimmer sweep (frosted glass) — motion only
                if (motion) {
                    const sweep = (this.particlePhase * 0.6) % (Math.PI * 2);
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius, sweep, sweep + 0.6);
                    ctx.strokeStyle = `rgba(235,238,248,${0.5 * entryAlpha})`;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }
                // dashed seal ring
                ctx.beginPath();
                ctx.arc(nx, ny, radius + 4, 0, Math.PI * 2);
                ctx.strokeStyle = disclosable ? `rgba(92,212,228,${0.9 * entryAlpha})` : `rgba(158,158,158,${0.8 * entryAlpha})`;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.lineDashOffset = motion ? -this.particlePhase * 10 : 0;
                ctx.stroke();
                ctx.setLineDash([]);
                // centered lock glyph
                ctx.fillStyle = `rgba(235,238,248,${entryAlpha})`;
                ctx.font = `${Math.max(9, radius * 0.8)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('\u{1F512}', nx, ny);
                ctx.textBaseline = 'alphabetic';
            }

            // Label collected for the screen-space de-clutter pass (A5). Selected
            // / hovered nodes are forced; active nodes get priority; the rest are
            // subject to semantic-zoom gating + collision skipping.
            if (!isGhost && node.label && entryAlpha > 0.5) {
                const label = node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label;
                const important = this.selectedNode === node.id || this.hoveredNode === node.id;
                this._labelCandidates.push({
                    kind: 'node', wx: nx, wy: ny, anchorPx: radius * this.camera.zoom + 11,
                    text: label, sub: '', color: '#cdd2e6', subColor: '#cdd2e6',
                    priority: (important ? 1e6 : 0) + activity * 10 + (node.size || 10),
                    force: important,
                    minZoom: (important || activity > 2) ? 0 : 0.55,
                });
            }

            // First-encounter kind hint (G3): the human kind name above the node,
            // fading in/out over its window, so the vocabulary teaches itself.
            if (!isGhost && this.showKindHints && motion && node.kind) {
                const seenAt = this._kindFirstSeen.get(node.kind);
                if (seenAt != null) {
                    const age = now - seenAt;
                    if (age >= 0 && age < KIND_HINT_MS) {
                        const a = Math.min(1, age / 160) * Math.min(1, (KIND_HINT_MS - age) / 700);
                        if (a > 0.02) this._labelCandidates.push({
                            kind: 'hint', wx: nx, wy: ny, anchorPx: -(radius * this.camera.zoom) - 8,
                            text: humanKind(node.kind), sub: '',
                            color: `rgba(140,210,228,${a.toFixed(3)})`, subColor: '',
                            priority: 5000, force: false, minZoom: 0,
                        });
                    }
                }
            }
        });
    }

    // drawLabels projects collected label candidates to screen space and places
    // them greedily, skipping any that would overlap one already placed — so a
    // busy graph never becomes an unreadable pile of text (A5). Forced labels
    // (selected/hovered) always render; everything else respects semantic zoom.
    drawLabels() {
        const { ctx, camera } = this;
        if (!this._labelCandidates || !this._labelCandidates.length) return;
        const w = this.cssWidth, h = this.cssHeight;
        const project = (wx, wy) => ({ x: w / 2 + camera.x + wx * camera.zoom, y: h / 2 + camera.y + wy * camera.zoom });

        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const FS = 11, PAD_X = 5, LINE = 13;

        // Build screen-space rects; drop candidates failing semantic-zoom gate or
        // off-screen, then place by priority with collision avoidance.
        const candidates = [];
        ctx.font = `${FS}px var(--cinema-font-ui, sans-serif)`;
        for (const c of this._labelCandidates) {
            if (!c.force && camera.zoom < (c.minZoom || 0)) continue;
            const p = project(c.wx, c.wy);
            if (p.x < -80 || p.x > w + 80 || p.y < -40 || p.y > h + 40) continue;
            const tw = ctx.measureText(c.text).width;
            const lines = c.sub ? 2 : 1;
            const halfW = tw / 2 + PAD_X;
            const top = c.kind === 'node' ? p.y + c.anchorPx - FS : p.y - LINE - 2;
            candidates.push({
                c, x: p.x, top,
                rect: { x1: p.x - halfW, y1: top - 2, x2: p.x + halfW, y2: top + lines * LINE },
            });
        }
        const placed = ns.placeLabels(candidates.map((it, i) => ({ id: i, priority: it.c.priority, force: it.c.force, rect: it.rect })));

        for (let i = 0; i < candidates.length; i++) {
            if (!placed.has(i)) continue;
            const it = candidates[i];
            // subtle shadow for legibility against the graph
            ctx.fillStyle = 'rgba(8,9,16,0.66)';
            const r = it.rect;
            ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, (it.c.sub ? 2 : 1) * LINE + 2);
            ctx.font = `${FS}px ${FONT_UI}`;
            ctx.fillStyle = it.c.color;
            ctx.fillText(it.c.text, it.x, it.top + FS);
            if (it.c.sub) {
                ctx.font = `${FS - 1}px ${FONT_MONO}`;
                ctx.fillStyle = it.c.subColor;
                ctx.fillText(it.c.sub, it.x, it.top + FS + LINE);
            }
        }
    }

    drawFlowParticle(from, to, edge, color) {
        const count = edge.particleCount || 3;
        const speed = edge.particleSpeed || 2;
        const size = edge.particleSize || 5;

        for (let i = 0; i < count; i++) {
            const t = ((this.particlePhase * speed + i / count) % 1);
            const x = from.x + (to.x - from.x) * t;
            const y = from.y + (to.y - from.y) * t;

            // Outer glow
            this.ctx.beginPath();
            this.ctx.arc(x, y, size + 4, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},0.2)`;
            this.ctx.fill();

            // Inner bright particle
            this.ctx.beginPath();
            this.ctx.arc(x, y, size, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(255,255,255,0.9)`;
            this.ctx.fill();

            // Core color
            this.ctx.beginPath();
            this.ctx.arc(x, y, size - 1, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},1.0)`;
            this.ctx.fill();
        }
    }

    drawHexagon(ctx, x, y, r) {
        ctx.moveTo(x + r, y);
        for (let i = 1; i <= 6; i++) {
            const angle = (Math.PI / 3) * i;
            ctx.lineTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
        }
        ctx.closePath();
    }

    drawDiamond(ctx, x, y, r) {
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
    }

    drawHUD() {
        // FPS counter (top-left, not affected by camera)
        this.ctx.fillStyle = '#444';
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(`${this.fps} FPS`, 8, 14);
    }

    // Pointer Events unify mouse + touch (B1 + B2). A gesture is a CLICK only if
    // it moved < DRAG_THRESHOLD; otherwise it pans. Two pointers pinch-zoom.
    setupInteraction() {
        const canvas = this.canvas;
        this._pointers = new Map();   // pointerId -> {x,y,type}
        this._pinchPrev = null;
        this._gesture = null;         // single-pointer gesture state

        this._onWheel = (e) => {
            e.preventDefault();
            this._zoomAbout(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.1);
        };
        canvas.addEventListener('wheel', this._onWheel, { passive: false });

        this._onPointerDown = (e) => {
            if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
            this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
            if (this._pointers.size === 1) {
                this._gesture = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, type: e.pointerType };
                canvas.style.cursor = 'grabbing';
            } else if (this._pointers.size === 2) {
                this._gesture = null;            // second finger cancels click/drag → pinch
                this._pinchPrev = this._pinchState();
            }
        };

        this._onPointerMove = (e) => {
            const p = this._pointers.get(e.pointerId);
            if (p) { p.x = e.clientX; p.y = e.clientY; }

            if (this._pointers.size >= 2) {       // pinch-zoom + two-finger pan
                const cur = this._pinchState();
                if (this._pinchPrev && this._pinchPrev.dist) {
                    this._zoomAbout(cur.midX, cur.midY, cur.dist / this._pinchPrev.dist);
                    this.camera.x += cur.midX - this._pinchPrev.midX;
                    this.camera.y += cur.midY - this._pinchPrev.midY;
                }
                this._pinchPrev = cur;
                this._dirty = true;
                return;
            }

            const g = this._gesture;
            if (g && this._pointers.has(g.id)) {
                const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
                if (!g.moved && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) g.moved = true;
                if (g.moved) {
                    this.camera.x += e.clientX - g.lastX;
                    this.camera.y += e.clientY - g.lastY;
                    g.lastX = e.clientX; g.lastY = e.clientY;
                    this._dirty = true;
                }
                return;
            }

            if (e.pointerType === 'mouse') this._hover(e.clientX, e.clientY);
        };

        this._onPointerUp = (e) => {
            if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }
            const g = this._gesture;
            const wasClick = g && g.id === e.pointerId && !g.moved;
            this._pointers.delete(e.pointerId);
            if (this._pointers.size < 2) this._pinchPrev = null;
            canvas.style.cursor = this._pointers.size ? 'grabbing' : '';
            if (wasClick && this._pointers.size === 0) this._click(e.clientX, e.clientY, g.type !== 'mouse');
            if (g && g.id === e.pointerId) this._gesture = null;
        };

        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerUp);

        this._onDblClick = (e) => { const n = this.hitTestNode(e.clientX, e.clientY); if (n) this.flyTo(n); };
        canvas.addEventListener('dblclick', this._onDblClick);

        this._onPointerLeave = () => {
            if (this.hoveredNode || this.hoveredEdge) { this.hoveredNode = null; this.hoveredEdge = null; this.emit('hoverEnd'); }
            this.canvas.style.cursor = '';
        };
        canvas.addEventListener('pointerleave', this._onPointerLeave);
    }

    _pinchState() {
        const pts = [...this._pointers.values()];
        const a = pts[0], b = pts[1];
        if (!a || !b) return { dist: 0, midX: 0, midY: 0 };
        return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
    }

    // _zoomAbout keeps the world point under (clientX,clientY) fixed while zooming.
    _zoomAbout(clientX, clientY, factor) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = clientX - rect.left, sy = clientY - rect.top;
        const wx = (sx - this.cssWidth / 2 - this.camera.x) / this.camera.zoom;
        const wy = (sy - this.cssHeight / 2 - this.camera.y) / this.camera.zoom;
        const z = Math.max(0.05, Math.min(20, this.camera.zoom * factor));
        this.camera.zoom = z;
        this.camera.x = sx - this.cssWidth / 2 - wx * z;
        this.camera.y = sy - this.cssHeight / 2 - wy * z;
        this._dirty = true;
    }

    _hover(clientX, clientY) {
        const prevNode = this.hoveredNode, prevEdge = this.hoveredEdge;
        const markIfChanged = () => { if (this.hoveredNode !== prevNode || this.hoveredEdge !== prevEdge) this._dirty = true; };
        const node = this.hitTestNode(clientX, clientY);
        if (node) {
            this.hoveredEdge = null;
            this.hoveredNode = node.id;
            markIfChanged();
            this.canvas.style.cursor = 'pointer';
            const s = this._worldToClient(node.position);
            this.emit('nodeHovered', { node, x: s.x, y: s.y });
            return;
        }
        this.hoveredNode = null;
        const edge = this.hitTestEdge(clientX, clientY);
        if (edge) {
            this.hoveredEdge = edge;
            markIfChanged();
            this.canvas.style.cursor = 'pointer';
            this.emit('edgeHovered', { edge, x: clientX, y: clientY });
        } else {
            if (this.hoveredEdge) { this.hoveredEdge = null; }
            markIfChanged();
            this.canvas.style.cursor = 'grab';
            this.emit('hoverEnd');
        }
    }

    _click(clientX, clientY, coarse) {
        this._dirty = true;
        const node = this.hitTestNode(clientX, clientY, { coarse });
        if (node) { this.selectedNode = node.id; this.emit('nodeSelected', node); return; }
        const edge = this.hitTestEdge(clientX, clientY);
        if (edge) { this.emit('edgeSelected', edge); return; }
        this.selectedNode = null;
        this.emit('backgroundClicked');
    }

    _worldToClient(pos) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: rect.left + this.cssWidth / 2 + this.camera.x + pos.x * this.camera.zoom,
            y: rect.top + this.cssHeight / 2 + this.camera.y + pos.y * this.camera.zoom,
        };
    }

    _findNode(id) {
        if (!this.sceneGraph) return null;
        let nodes = this.sceneGraph.nodes || this.sceneGraph.Nodes;
        if (!nodes) return null;
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        return nodes.find((n) => n.id === id) || null;
    }

    // flyTo animates the camera to center a node at a comfortable zoom (B1).
    flyTo(node, opts) {
        if (typeof node === 'string') node = this._findNode(node);
        if (!node || !node.position) return;
        opts = opts || {};
        const z = opts.zoom || Math.max(this.camera.zoom, 1.4);
        this._animateCamera({ x: -node.position.x * z, y: -node.position.y * z, zoom: z }, opts.duration || 380);
    }

    // fitToNodes frames a subset of nodes (B4 — fit-to-matches).
    fitToNodes(ids) {
        if (!this.sceneGraph || !ids || !ids.length) return;
        let nodes = this.sceneGraph.nodes || this.sceneGraph.Nodes;
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        const set = new Set(ids);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            if (!set.has(n.id) || !n.position) continue;
            const r = (this._nodeRenderRadius.get(n.id) || n.size || 10) + 26;
            minX = Math.min(minX, n.position.x - r); minY = Math.min(minY, n.position.y - r);
            maxX = Math.max(maxX, n.position.x + r); maxY = Math.max(maxY, n.position.y + r);
        }
        if (!isFinite(minX)) return;
        const w = maxX - minX || 1, h = maxY - minY || 1;
        const z = Math.min((this.cssWidth * 0.8) / w, (this.cssHeight * 0.8) / h, 3);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        this._animateCamera({ x: -cx * z, y: -cy * z, zoom: z }, 420);
    }

    // playAnchorConfirmation kicks off the one-time ~800ms "it's now independently
    // verifiable" beat (D3): a beam from the evidence node to the L0 anchor + a
    // crystallize ring. Reduced-motion → no-op (the trust state is still legible).
    playAnchorConfirmation(evidenceId, anchorId) {
        if (rendererReducedMotion()) return;
        if (!this._findNode(evidenceId) || !this._findNode(anchorId)) return;
        this._anchorMoment = { evId: evidenceId, anId: anchorId, start: performance.now() };
        this._dirty = true;
    }

    _drawAnchorMoment() {
        const m = this._anchorMoment;
        const t = (performance.now() - m.start) / 800;
        if (t >= 1) { this._anchorMoment = null; return; }
        const ev = this._findNode(m.evId), an = this._findNode(m.anId);
        if (!ev || !an || !ev.position || !an.position) { this._anchorMoment = null; return; }
        const ctx = this.ctx;
        const k = easeInOutRenderer(Math.min(1, t));
        const bx = ev.position.x + (an.position.x - ev.position.x) * k;
        const by = ev.position.y + (an.position.y - ev.position.y) * k;
        ctx.save();
        // beam
        ctx.strokeStyle = `rgba(255,215,0,${0.85 * (1 - t) + 0.15})`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(ev.position.x, ev.position.y); ctx.lineTo(bx, by); ctx.stroke();
        // leading spark
        ctx.beginPath(); ctx.arc(bx, by, 4 + 3 * Math.sin(this.particlePhase * 6), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,236,150,0.95)'; ctx.fill();
        // crystallize ring at the anchor once the beam arrives
        if (k > 0.6) {
            const rt = (k - 0.6) / 0.4;
            const rr = 10 + rt * 44;
            ctx.strokeStyle = `rgba(255,215,0,${(1 - rt) * 0.9})`;
            ctx.lineWidth = 2 + (1 - rt) * 3;
            ctx.beginPath(); ctx.arc(an.position.x, an.position.y, rr, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
    }

    setKeyboardFocus(id) {
        this._focusedNode = id || null;
        this._dirty = true;
        if (id) { const n = this._findNode(id); if (n && n.position) this.flyTo(n, { zoom: Math.max(this.camera.zoom, 1.2), duration: 260 }); }
    }

    _animateCamera(to, duration) {
        if (rendererReducedMotion()) { this.camera.x = to.x; this.camera.y = to.y; this.camera.zoom = to.zoom; return; }
        if (this._camRaf) cancelAnimationFrame(this._camRaf);
        const from = { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom };
        const start = performance.now();
        const step = () => {
            const k = easeInOutRenderer(Math.min(1, (performance.now() - start) / duration));
            this.camera.x = from.x + (to.x - from.x) * k;
            this.camera.y = from.y + (to.y - from.y) * k;
            this.camera.zoom = from.zoom + (to.zoom - from.zoom) * k;
            this._dirty = true;
            this._camRaf = k < 1 ? requestAnimationFrame(step) : null;
        };
        this._camRaf = requestAnimationFrame(step);
    }

    // hitTestNode tests against the CACHED RENDERED radius (B3) using the spatial
    // grid (E1) — O(1) amortized instead of a linear scan — and returns the
    // top-most node (greatest draw index). Falls back to a linear scan before the
    // first frame populates the grid.
    hitTestNode(clientX, clientY, opts) {
        if (!this.sceneGraph || !this.sceneGraph.nodes) return null;
        const rect = this.canvas.getBoundingClientRect();
        const cx = (clientX - rect.left - this.cssWidth / 2 - this.camera.x) / this.camera.zoom;
        const cy = (clientY - rect.top - this.cssHeight / 2 - this.camera.y) / this.camera.zoom;
        const pad = (opts && opts.coarse) ? 9 : 2;

        if (this._hitGrid && this._hitGrid.size) {
            const cell = this._hitCell;
            const cxN = Math.floor(cx / cell), cyN = Math.floor(cy / cell);
            let best = null, bestIdx = -1;
            for (let gx = -1; gx <= 1; gx++) {
                for (let gy = -1; gy <= 1; gy++) {
                    const bucket = this._hitGrid.get((cxN + gx) + ',' + (cyN + gy));
                    if (!bucket) continue;
                    for (const e of bucket) {
                        const dx = cx - e.x, dy = cy - e.y, r = e.r + pad;
                        if (dx * dx + dy * dy <= r * r && e.idx > bestIdx) { bestIdx = e.idx; best = e; }
                    }
                }
            }
            return best ? this._findNode(best.id) : null;
        }

        // Fallback: linear scan, top-most first.
        let nodes = this.sceneGraph.nodes;
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            if (!node.position) continue;
            const rr = this._nodeRenderRadius.get(node.id);
            const r = (rr != null ? rr : (node.size || 10)) + pad;
            const dx = cx - node.position.x, dy = cy - node.position.y;
            if (dx * dx + dy * dy <= r * r) return node;
        }
        return null;
    }

    hitTestEdge(clientX, clientY) {
        if (!this._edgeTraffic || !this._nodeMap) return null;
        const rect = this.canvas.getBoundingClientRect();
        const mx = (clientX - rect.left - this.cssWidth / 2 - this.camera.x) / this.camera.zoom;
        const my = (clientY - rect.top - this.cssHeight / 2 - this.camera.y) / this.camera.zoom;
        const threshold = 10 / this.camera.zoom;

        let closest = null, closestDist = threshold;
        for (const traffic of Object.values(this._edgeTraffic)) {
            const from = this._nodeMap.get(traffic.fromId);
            const to = this._nodeMap.get(traffic.toId);
            if (!from || !to || !from.position || !to.position) continue;

            const d = this._distToSegment(mx, my,
                from.position.x, from.position.y,
                to.position.x, to.position.y);
            if (d < closestDist) {
                closestDist = d;
                closest = traffic;
            }
        }
        return closest;
    }

    _distToSegment(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        return Math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2);
    }

    getNodeStats(nodeId) {
        const activity = this._nodeActivity ? (this._nodeActivity[nodeId] || 0) : 0;
        let inbound = 0, outbound = 0, totalGas = 0;
        if (this._edgeTraffic) {
            Object.values(this._edgeTraffic).forEach(t => {
                if (t.toId === nodeId) { inbound += t.count; totalGas += t.totalGas; }
                if (t.fromId === nodeId) { outbound += t.count; totalGas += t.totalGas; }
            });
        }
        return { activity, inbound, outbound, totalGas };
    }

    on(event, callback) {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
        this.eventHandlers.get(event).push(callback);
    }

    // off removes a handler — lets consumers (e.g. narrativeSync) unsubscribe on
    // destroy instead of leaking across remounts (E2).
    off(event, callback) {
        const a = this.eventHandlers.get(event);
        if (!a) return;
        const i = a.indexOf(callback);
        if (i >= 0) a.splice(i, 1);
    }

    emit(event, data) {
        (this.eventHandlers.get(event) || []).forEach(cb => cb(data));
    }

    getStats() {
        let nodeCount = 0, edgeCount = 0;
        if (this.sceneGraph) {
            const n = this.sceneGraph.nodes || this.sceneGraph.Nodes;
            const e = this.sceneGraph.edges || this.sceneGraph.Edges;
            nodeCount = n ? (Array.isArray(n) ? n.length : Object.keys(n).length) : 0;
            edgeCount = e ? (Array.isArray(e) ? e.length : Object.keys(e).length) : 0;
        }
        return { nodes: nodeCount, edges: edgeCount, fps: this.fps, zoom: this.camera.zoom.toFixed(2) };
    }

    destroy() {
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        if (this._camRaf) cancelAnimationFrame(this._camRaf);
        if (this._resizeObserver) { try { this._resizeObserver.disconnect(); } catch (e) {} this._resizeObserver = null; }
        else if (this._onResize) { window.removeEventListener('resize', this._onResize); }
        const c = this.canvas;
        if (c) {
            if (this._onWheel) c.removeEventListener('wheel', this._onWheel);
            if (this._onPointerDown) c.removeEventListener('pointerdown', this._onPointerDown);
            if (this._onPointerMove) c.removeEventListener('pointermove', this._onPointerMove);
            if (this._onPointerUp) { c.removeEventListener('pointerup', this._onPointerUp); c.removeEventListener('pointercancel', this._onPointerUp); }
            if (this._onDblClick) c.removeEventListener('dblclick', this._onDblClick);
            if (this._onPointerLeave) c.removeEventListener('pointerleave', this._onPointerLeave);
        }
        if (this._mql && this._onMotionPref && this._mql.removeEventListener) this._mql.removeEventListener('change', this._onMotionPref);
    }
}

  // rectsIntersect / placeLabels are pure helpers (unit-tested in
  // labelLayout.test.mjs) powering the screen-space label de-clutter pass (A5).
  function rectsIntersect(a, b) {
    return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
  }
  // placeLabels takes [{id, priority, force, rect}] and returns a Set of the ids
  // that fit without overlapping. Forced labels are always placed (and reserve
  // their space first); the rest are placed highest-priority-first, skipping any
  // that would collide with an already-placed rect.
  function placeLabels(items) {
    const sorted = items.slice().sort((a, b) =>
      ((b.force ? 1 : 0) - (a.force ? 1 : 0)) || (b.priority - a.priority));
    const placedRects = [];
    const ids = new Set();
    for (const it of sorted) {
      if (it.force) { placedRects.push(it.rect); ids.add(it.id); continue; }
      let ok = true;
      for (const r of placedRects) { if (rectsIntersect(it.rect, r)) { ok = false; break; } }
      if (ok) { placedRects.push(it.rect); ids.add(it.id); }
    }
    return ids;
  }

  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  ns.CinemaRenderer = CinemaRenderer;
  ns.placeLabels = placeLabels;
  ns.rectsIntersect = rectsIntersect;
  ns.severityOf = severityOf;
  ns.computeAttention = computeAttention;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaRenderer, placeLabels, rectsIntersect, severityOf, computeAttention };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
