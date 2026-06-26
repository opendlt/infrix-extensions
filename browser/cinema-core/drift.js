/**
 * Infrix Cinema — Predicted-vs-Actual / drift (Wave I / I1).
 *
 * The renderer has ALWAYS supported a translucent ghost overlay (setGhostGraph)
 * and the plan/ghost node-kinds + Drift colors — and nothing in the product ever
 * drove it. This is the EVM-impossible view: because Infrix captures the plan,
 * Cinema can show what was PREDICTED ghosted under what ACTUALLY happened, with
 * drift edges where they diverge. No chain without captured intent can do this.
 *
 * Disclosure-safe: a sealed step reports "comparison withheld" — a redacted
 * value is never read or compared.
 *
 * `hasPlan` / `splitPlanActual` / `computeDrift` / `driftSummary` are pure +
 * unit-tested; `DriftView` drives the renderer.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  const GHOST_KINDS = new Set(['plan_timeline', 'plan_step', 'ghost_prediction']);
  const GHOST_EDGE_KINDS = new Set(['ghost_drift', 'plan_link', 'ghost_compare']);
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  function hasPlan(graph, plan) {
    if (plan && toArray(plan.nodes || plan.Nodes).length) return true;
    return toArray(graph && (graph.nodes || graph.Nodes)).some((n) => GHOST_KINDS.has(n.kind));
  }

  /**
   * splitPlanActual partitions a scene (or a scene + a separate plan subgraph)
   * into { actual, ghost }. References the same node objects (positions preserved).
   */
  function splitPlanActual(graph, plan) {
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const edges = toArray(graph && (graph.edges || graph.Edges));
    if (plan && toArray(plan.nodes || plan.Nodes).length) {
      return { actual: { nodes, edges }, ghost: { nodes: toArray(plan.nodes || plan.Nodes), edges: toArray(plan.edges || plan.Edges) } };
    }
    const ghostNodes = nodes.filter((n) => GHOST_KINDS.has(n.kind));
    const ghostIds = new Set(ghostNodes.map((n) => n.id));
    const actualNodes = nodes.filter((n) => !GHOST_KINDS.has(n.kind));
    const isGhostEdge = (e) => ghostIds.has(e.fromNodeId) || ghostIds.has(e.toNodeId) || GHOST_EDGE_KINDS.has(e.kind);
    return {
      actual: { nodes: actualNodes, edges: edges.filter((e) => !isGhostEdge(e)) },
      ghost: { nodes: ghostNodes, edges: edges.filter(isGhostEdge) },
    };
  }

  // The fields compared between a prediction and its actual.
  const FIELDS = [
    { field: 'gas', predOf: (g) => pick(g, ['predicted', 'gas'], ['predGas'], ['gas']), actOf: (a) => first(a.gasCost, a.gas) },
    { field: 'status', predOf: (g) => pick(g, ['predicted', 'status'], ['predStatus']), actOf: (a) => first(a.status, a.breakerState) },
    { field: 'outcome', predOf: (g) => pick(g, ['predicted', 'outcome'], ['predOutcome']), actOf: (a) => first(a.outcome) },
  ];
  function first() { for (let i = 0; i < arguments.length; i++) if (arguments[i] != null) return arguments[i]; return undefined; }
  function pick(o) {
    for (let i = 1; i < arguments.length; i++) {
      const path = arguments[i]; let v = o;
      for (const k of path) { v = v == null ? undefined : v[k]; }
      if (v != null) return v;
    }
    return undefined;
  }
  function stepKey(n) { return n.stepId != null ? String(n.stepId) : (n.label != null ? String(n.label) : String(n.id)); }

  /**
   * computeDrift pairs predictions with their actuals and flags divergences.
   * @returns {{matched:string[], drifted:[{stepId,field,predicted,actual}], driftEdges:[{fromId,toId,drift}]}}
   */
  function computeDrift(actual, ghost) {
    const actualNodes = toArray(actual && actual.nodes);
    const ghostNodes = toArray(ghost && ghost.nodes);
    const byKey = new Map();
    const byId = new Map();
    for (const n of actualNodes) { byKey.set(stepKey(n), n); byId.set(n.id, n); }

    const matched = [], drifted = [], driftEdges = [];
    for (const g of ghostNodes) {
      const a = (g.predictsId && byId.get(g.predictsId)) || (g.actualId && byId.get(g.actualId)) || byKey.get(stepKey(g));
      if (!a) continue; // nothing actual to compare against
      if (a.redacted || g.redacted) { matched.push(a.id); driftEdges.push({ fromId: g.id, toId: a.id, drift: false, sealed: true }); continue; }
      const divs = [];
      for (const F of FIELDS) {
        const p = F.predOf(g);
        if (p == null) continue;
        const ac = F.actOf(a);
        if (String(p) !== String(ac)) divs.push({ stepId: stepKey(g), field: F.field, predicted: p, actual: ac });
      }
      driftEdges.push({ fromId: g.id, toId: a.id, drift: divs.length > 0 });
      if (divs.length) for (const d of divs) drifted.push(d); else matched.push(a.id);
    }
    return { matched, drifted, driftEdges };
  }

  function fmt(v) { return v == null ? '—' : String(v); }
  function driftSummary(drift) {
    const driftedSteps = new Set((drift.drifted || []).map((d) => d.stepId));
    const matchedCount = (drift.matched || []).length;
    const total = matchedCount + driftedSteps.size;
    if (!total) return 'No plan steps to compare.';
    let s = matchedCount + ' of ' + total + ' step' + (total === 1 ? '' : 's') + ' matched the plan.';
    const f = (drift.drifted || [])[0];
    if (f) s += ' Step ' + f.stepId + ' diverged: predicted ' + f.field + ' ' + fmt(f.predicted) + ', actual ' + fmt(f.actual) + '.';
    return s;
  }

  // driftedNodeIds — the actual-node ids that diverged (for the "drift only" filter).
  function driftedNodeIds(drift) {
    const out = new Set();
    for (const e of (drift.driftEdges || [])) if (e.drift) out.add(e.toId);
    return [...out];
  }

  class DriftView {
    constructor(opts) { this.renderer = (opts || {}).renderer; this.active = false; this.summary = ''; this.drift = null; }

    apply(graph, plan) {
      const { actual, ghost } = splitPlanActual(graph, plan);
      const drift = computeDrift(actual, ghost);
      // Position each ghost (prediction) node near its matched actual; offset the
      // ones that drifted so the divergence is visible.
      const apos = new Map();
      for (const n of actual.nodes) if (n.position) apos.set(n.id, n.position);
      for (const e of drift.driftEdges) {
        const a = apos.get(e.toId);
        const g = ghost.nodes.find((n) => n.id === e.fromId);
        if (g && a) g.position = { x: a.x + (e.drift ? 38 : 0), y: a.y - (e.drift ? 38 : 0) };
      }
      this.renderer.setSceneGraph(actual);
      this.renderer.setGhostGraph(ghost);
      if (this.renderer.setDriftEdges) this.renderer.setDriftEdges(drift.driftEdges);
      this.drift = drift;
      this.summary = driftSummary(drift);
      this.active = true;
    }

    clear(graph) {
      this.renderer.clearGhostGraph();
      if (this.renderer.setDriftEdges) this.renderer.setDriftEdges(null);
      if (graph) this.renderer.setSceneGraph(graph);
      this.active = false;
      this.drift = null;
      this.summary = '';
    }
  }

  const api = { hasPlan, splitPlanActual, computeDrift, driftSummary, driftedNodeIds, DriftView, GHOST_KINDS };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
