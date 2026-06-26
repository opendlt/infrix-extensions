/**
 * Infrix Cinema — client-side layout engine (Tier A / A1).
 *
 * The renderer draws node.position verbatim and SKIPS any node without one, so
 * before this module a scene was only as good as the (x,y) the Go backend
 * happened to compute. This module gives Cinema its own layouts so a scene with
 * nodes but no positions still renders clean, non-overlapping, and readable —
 * and so the default governance scene reads as the spine it actually is:
 *
 *   Intent → Policy → Approval → Execution → Outcome → Evidence → Anchor → Witness
 *
 * Engines:
 *   - 'spine'  left→right governance lanes keyed off the narrative stage of each
 *              node kind; emits lane metadata the renderer draws as bands+headers.
 *   - 'force'  dependency-free velocity-Verlet sim (charge + spring + collision +
 *              centering), grid-bucketed repulsion, deterministic seeding.
 *   - 'grid'   deterministic fallback for edgeless/stageless scenes.
 *   - 'none'   identity (respect server-provided positions).
 *
 * Disclosure-safe: operates only on the already-filtered graph the renderer is
 * handed. It moves nodes; it never resurrects a suppressed node, and it never
 * touches a redacted node's fixed size/opacity or any stripped field.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node tests.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  // Lane order for the spine layout (mirror of narrativeTemplates STAGE_ORDER,
  // replicated locally so layout has no load-order dependency on narrative).
  const STAGE_ORDER = {
    intent: 0, policy: 1, approval: 2, execution: 3,
    outcome: 4, evidence: 5, anchor: 6, witness: 7, disclosure: 8,
  };
  const STAGE_LABEL = {
    intent: 'Intent', policy: 'Policy', approval: 'Approval', execution: 'Execution',
    outcome: 'Outcome', evidence: 'Evidence', anchor: 'Anchor', witness: 'Witness',
    disclosure: 'Disclosure', other: 'Activity',
  };

  // Tunables (world units).
  const LANE_W = 240;        // horizontal distance between spine lanes
  const ROW_H = 78;          // vertical spacing of nodes within a lane
  const SUBCOL_W = 96;       // offset when a lane wraps into sub-columns
  const LANE_MAX_ROWS = 9;   // rows before a lane wraps into a new sub-column
  const LINK_DIST = 120;     // ideal spring length (force)
  const CHARGE = 5200;       // repulsion strength (force)
  const ITERATIONS = 320;    // force ticks (synchronous settle)

  // ---- helpers ----
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }
  function nodeRadius(n) { return (n && n.size != null ? n.size : 10) + 8; }

  // stageOf maps a node kind to a spine lane. Uses the narrative mapping when
  // present so the lanes match the audit story exactly.
  function stageOf(node) {
    const kind = node && node.kind;
    if (ns.narrativeStageForKind) {
      const s = ns.narrativeStageForKind(kind);
      if (s) return s;
    }
    switch (kind) {
      case 'intent': return 'intent';
      case 'plan_timeline': case 'policy': case 'policy_decision': return 'policy';
      case 'approval_gate': case 'approver': return 'approval';
      case 'outcome': return 'outcome';
      case 'evidence': case 'evidence_link': return 'evidence';
      case 'anchor': case 'l0_bridge': return 'anchor';
      case 'disclosure_grant': case 'disclosure': return 'disclosure';
      default: return null;
    }
  }

  // Deterministic [0,1) pseudo-random from an integer seed — keeps layouts
  // reproducible (and unit-testable) without Math.random.
  function rand01(seed) {
    let x = (seed * 2654435761) % 2147483647;
    if (x < 0) x += 2147483647;
    return x / 2147483647;
  }

  // needsLayout: true when any renderable node lacks a finite position.
  function needsLayout(graph) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    for (const n of nodes) {
      const p = n && n.position;
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' ||
          !isFinite(p.x) || !isFinite(p.y)) return true;
    }
    return false;
  }

  // chooseAutoEngine: spine when the scene is meaningfully a governance flow
  // (>=40% of nodes map to a stage AND at least two distinct stages exist),
  // else force, falling back to grid when there is nothing to pull on.
  function chooseAutoEngine(graph) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const edges = toArray(graph && (graph.edges || graph.Edges));
    if (!nodes.length) return 'grid';
    const stages = new Set();
    let staged = 0;
    for (const n of nodes) { const s = stageOf(n); if (s) { staged++; stages.add(s); } }
    if (staged / nodes.length >= 0.4 && stages.size >= 2) return 'spine';
    if (edges.length > 0) return 'force';
    return 'grid';
  }

  // ---- spine layout ----
  function spineLayout(nodes) {
    const groups = new Map(); // stage -> nodes[]
    for (const n of nodes) {
      const s = stageOf(n) || 'other';
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(n);
    }
    // Order lanes by STAGE_ORDER, 'other' always last.
    const laneKeys = [...groups.keys()].sort((a, b) => {
      const ra = a === 'other' ? 99 : (STAGE_ORDER[a] != null ? STAGE_ORDER[a] : 90);
      const rb = b === 'other' ? 99 : (STAGE_ORDER[b] != null ? STAGE_ORDER[b] : 90);
      return ra - rb;
    });

    const positions = new Map();
    const lanes = [];
    laneKeys.forEach((stage, laneIdx) => {
      const laneNodes = groups.get(stage);
      const laneX = laneIdx * LANE_W;
      const rows = Math.min(LANE_MAX_ROWS, laneNodes.length);
      const colHeight = (rows - 1) * ROW_H;
      let y0 = Infinity, y1 = -Infinity;
      laneNodes.forEach((n, i) => {
        const subcol = Math.floor(i / LANE_MAX_ROWS);
        const rowInCol = i % LANE_MAX_ROWS;
        const rowsThisCol = Math.min(LANE_MAX_ROWS, laneNodes.length - subcol * LANE_MAX_ROWS);
        const colH = (rowsThisCol - 1) * ROW_H;
        const x = laneX + subcol * SUBCOL_W;
        const y = rowInCol * ROW_H - colH / 2;
        positions.set(n.id, { x, y });
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      });
      if (!isFinite(y0)) { y0 = -ROW_H; y1 = ROW_H; }
      lanes.push({
        stage,
        label: STAGE_LABEL[stage] || stage,
        x: laneX,
        y0: y0 - ROW_H,
        y1: y1 + ROW_H,
        count: laneNodes.length,
      });
      void colHeight;
    });
    return { positions, lanes };
  }

  // ---- grid layout ----
  function gridLayout(nodes) {
    const positions = new Map();
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    const gap = LINK_DIST;
    nodes.forEach((n, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      positions.set(n.id, { x: (c - cols / 2) * gap, y: (r - cols / 2) * gap });
    });
    return { positions, lanes: null };
  }

  // ---- force layout (dependency-free) ----
  function forceLayout(nodes, edges) {
    const N = nodes.length;
    const idx = new Map();
    nodes.forEach((n, i) => idx.set(n.id, i));
    const px = new Float64Array(N), py = new Float64Array(N);
    const vx = new Float64Array(N), vy = new Float64Array(N);
    const rad = new Float64Array(N);

    // Seed: server position when present, else a deterministic phyllotaxis spiral
    // (avoids the degenerate all-on-a-line start a plain grid can give).
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      rad[i] = nodeRadius(n);
      if (n.position && isFinite(n.position.x) && isFinite(n.position.y)) {
        px[i] = n.position.x + (rand01(i + 1) - 0.5) * 4;
        py[i] = n.position.y + (rand01(i + 7) - 0.5) * 4;
      } else {
        const a = i * 2.399963229; // golden angle
        const r = LINK_DIST * 0.6 * Math.sqrt(i + 1);
        px[i] = Math.cos(a) * r;
        py[i] = Math.sin(a) * r;
      }
    }

    const links = [];
    for (const e of edges) {
      const a = idx.get(e.fromNodeId), b = idx.get(e.toNodeId);
      if (a != null && b != null && a !== b) links.push([a, b]);
    }

    const cell = LINK_DIST * 1.6;
    let alpha = 1;
    const alphaDecay = 1 - Math.pow(0.001, 1 / ITERATIONS);

    for (let it = 0; it < ITERATIONS; it++) {
      // Bucket nodes into a uniform grid for local repulsion.
      const buckets = new Map();
      for (let i = 0; i < N; i++) {
        const cx = Math.floor(px[i] / cell), cy = Math.floor(py[i] / cell);
        const key = cx + ',' + cy;
        let arr = buckets.get(key);
        if (!arr) buckets.set(key, (arr = []));
        arr.push(i);
      }
      // Repulsion (charge) + collision against neighbours in the 3x3 cell block.
      for (let i = 0; i < N; i++) {
        const cx = Math.floor(px[i] / cell), cy = Math.floor(py[i] / cell);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const arr = buckets.get(gx + ',' + gy);
            if (!arr) continue;
            for (const j of arr) {
              if (j <= i) continue;
              let dx = px[i] - px[j], dy = py[i] - py[j];
              let d2 = dx * dx + dy * dy;
              if (d2 === 0) { dx = (rand01(i * 131 + j) - 0.5); dy = (rand01(j * 131 + i) - 0.5); d2 = dx * dx + dy * dy || 1e-6; }
              const d = Math.sqrt(d2);
              // charge
              const f = (CHARGE / d2) * alpha;
              const ux = dx / d, uy = dy / d;
              vx[i] += ux * f; vy[i] += uy * f;
              vx[j] -= ux * f; vy[j] -= uy * f;
              // collision (hard separation)
              const minD = rad[i] + rad[j];
              if (d < minD) {
                const push = (minD - d) * 0.5 * alpha;
                vx[i] += ux * push; vy[i] += uy * push;
                vx[j] -= ux * push; vy[j] -= uy * push;
              }
            }
          }
        }
      }
      // Springs along edges toward ideal length.
      for (const [a, b] of links) {
        let dx = px[b] - px[a], dy = py[b] - py[a];
        let d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const f = ((d - LINK_DIST) / d) * 0.5 * alpha;
        const fx = dx * f, fy = dy * f;
        vx[a] += fx; vy[a] += fy;
        vx[b] -= fx; vy[b] -= fy;
      }
      // Mild centering toward origin.
      for (let i = 0; i < N; i++) { vx[i] -= px[i] * 0.002 * alpha; vy[i] -= py[i] * 0.002 * alpha; }
      // Integrate with velocity damping.
      for (let i = 0; i < N; i++) {
        px[i] += vx[i]; py[i] += vy[i];
        vx[i] *= 0.6; vy[i] *= 0.6;
      }
      alpha = Math.max(0, alpha - alphaDecay);
    }

    const positions = new Map();
    for (let i = 0; i < N; i++) positions.set(nodes[i].id, { x: px[i], y: py[i] });
    return { positions, lanes: null };
  }

  // computeLayout returns positions (+ optional lane metadata) WITHOUT mutating
  // the input graph. The controller applies/animates them onto the live nodes.
  function computeLayout(graph, engine) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const edges = toArray(graph && (graph.edges || graph.Edges));
    if (!nodes.length) return { positions: new Map(), lanes: null };
    const eng = engine === 'auto' || !engine ? chooseAutoEngine(graph) : engine;
    switch (eng) {
      case 'none': {
        const positions = new Map();
        for (const n of nodes) if (n.position) positions.set(n.id, { x: n.position.x, y: n.position.y });
        return { positions, lanes: null, engine: 'none' };
      }
      case 'grid': return Object.assign(gridLayout(nodes), { engine: 'grid' });
      case 'force': return Object.assign(forceLayout(nodes, edges), { engine: 'force' });
      case 'spine':
      default: return Object.assign(spineLayout(nodes), { engine: 'spine' });
    }
  }

  // prefersReducedMotion — snap instead of animate when the user asks for it.
  function prefersReducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // LayoutController applies a computed layout onto the renderer's live scene,
  // animating each node from its current position to the target. Because the
  // renderer reads node.position every frame, mutating it animates for free.
  class LayoutController {
    constructor(renderer) {
      this.renderer = renderer;
      this._raf = null;
      this.engine = null;
    }

    apply(graph, engine, opts) {
      opts = opts || {};
      if (!graph) return;
      const { positions, lanes, engine: resolved } = computeLayout(graph, engine);
      this.engine = resolved || engine || 'auto';
      if (this.renderer && this.renderer.setLayoutLanes) this.renderer.setLayoutLanes(lanes || null);

      const nodes = toArray(graph.nodes || graph.Nodes);
      const targets = [];
      for (const n of nodes) {
        const t = positions.get(n.id);
        if (!t) continue;
        const from = (n.position && isFinite(n.position.x)) ? { x: n.position.x, y: n.position.y } : { x: t.x, y: t.y };
        targets.push({ n, from, to: t });
      }

      this.stop();
      const animate = opts.animate !== false && !prefersReducedMotion();
      const duration = opts.duration || 420;
      if (!animate) {
        for (const { n, to } of targets) n.position = { x: to.x, y: to.y };
        if (this.renderer && this.renderer.requestRender) this.renderer.requestRender();
        if (this.renderer && this.renderer.fitToView && opts.fit) this.renderer.fitToView();
        return;
      }

      const start = (typeof performance !== 'undefined' ? performance.now() : 0);
      const step = () => {
        const now = (typeof performance !== 'undefined' ? performance.now() : start + duration);
        const t = Math.min(1, (now - start) / duration);
        const k = easeInOut(t);
        for (const { n, from, to } of targets) {
          n.position = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
        }
        if (this.renderer && this.renderer.requestRender) this.renderer.requestRender(); // keep frames flowing under dirty-render (E3)
        if (t < 1) { this._raf = requestAnimationFrame(step); }
        else { this._raf = null; if (this.renderer && this.renderer.fitToView && opts.fit) this.renderer.fitToView(); }
      };
      this._raf = requestAnimationFrame(step);
    }

    stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }
    destroy() { this.stop(); }
  }

  const api = {
    computeLayout, needsLayout, chooseAutoEngine, LayoutController,
    layoutStageOf: stageOf, LAYOUT_STAGE_ORDER: STAGE_ORDER,
  };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
