/**
 * Infrix Cinema — causal provenance tracing (Wave H / H2).
 *
 * "Why did this happen, and who authorized it?" — answered visually in one click.
 * From any node, walk the typed causal edges BACKWARD to the originating intent
 * and FORWARD to the L0 anchor, producing the exact chain of governance that
 * produced the result. Disclosure-safe: reads only ids/kinds and the redacted
 * labels already present.
 *
 * `traceCausalChain(graph, nodeId)` is pure + unit-tested.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  // Edges that carry governance causality. Untyped edges are treated as causal
  // flow too, so a plain spine scene still traces.
  const CAUSAL_KINDS = new Set([
    'intent_to_outcome', 'approval', 'policy_check', 'capability_exercise',
    'contract_call', 'event_dispatch', 'evidence_link', 'evidence_chain',
    'evidence_anchor', 'anchor_link', 'settlement_leg', 'dependency',
  ]);
  function isCausal(edge) { return !edge.kind || CAUSAL_KINDS.has(edge.kind); }

  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  /**
   * traceCausalChain walks the causal edges from nodeId backward (to intent) and
   * forward (to anchor), cycle-safe.
   * @returns {{nodes:string[], edges:string[], hops:[{fromId,toId,edgeKind,proofRef}]}}
   */
  function traceCausalChain(graph, nodeId) {
    const empty = { nodes: [], edges: [], hops: [] };
    if (!graph || !nodeId) return empty;
    const edges = toArray(graph.edges || graph.Edges).filter(isCausal);
    const incoming = new Map(); // toId -> [edge]
    const outgoing = new Map(); // fromId -> [edge]
    for (const e of edges) {
      if (!incoming.has(e.toNodeId)) incoming.set(e.toNodeId, []);
      incoming.get(e.toNodeId).push(e);
      if (!outgoing.has(e.fromNodeId)) outgoing.set(e.fromNodeId, []);
      outgoing.get(e.fromNodeId).push(e);
    }

    const nodeSet = new Set([nodeId]);
    const edgeSet = new Set();
    const hops = [];

    // walk a direction; `pick(e)` returns the next node id to follow.
    function walk(startId, map, pick, nextFrom) {
      const stack = [startId];
      const seen = new Set([startId]);
      while (stack.length) {
        const cur = stack.pop();
        for (const e of (map.get(cur) || [])) {
          const nxt = pick(e);
          edgeSet.add(edgeId(e));
          nodeSet.add(e.fromNodeId); nodeSet.add(e.toNodeId);
          hops.push({ fromId: e.fromNodeId, toId: e.toNodeId, edgeKind: e.kind || 'flow', proofRef: e.proofRef || e.proof || '' });
          if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
        }
      }
    }
    // backward: follow incoming edges to their sources
    walk(nodeId, incoming, (e) => e.fromNodeId);
    // forward: follow outgoing edges to their targets
    walk(nodeId, outgoing, (e) => e.toNodeId);

    return { nodes: [...nodeSet], edges: [...edgeSet], hops: dedupeHops(hops) };
  }

  function edgeId(e) { return e.id || ((e.fromNodeId || '') + '→' + (e.toNodeId || '')); }
  function dedupeHops(hops) {
    const seen = new Set(); const out = [];
    for (const h of hops) { const k = h.fromId + '→' + h.toId; if (!seen.has(k)) { seen.add(k); out.push(h); } }
    return out;
  }

  // edgeKeysOf maps hops to renderer trace-path keys ("from→to").
  function edgeKeysOf(chain) { return (chain.hops || []).map((h) => (h.fromId || '') + '→' + (h.toId || '')); }

  const api = { traceCausalChain, edgeKeysOf };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
