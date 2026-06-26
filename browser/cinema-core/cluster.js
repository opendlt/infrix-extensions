/**
 * Infrix Cinema — semantic clustering for overview/scale (Wave J / J2).
 *
 * At altitude (zoomed out), 10,000 nodes should read as a dozen labeled
 * super-nodes, not a hairball. clusterScene groups nodes by family (kindFamily)
 * or spine lane (layoutStageOf), computes a centroid + member list per cluster,
 * and aggregates inter-cluster edges. The renderer swaps to clusters below a
 * zoom threshold (LOD).
 *
 * Pure + unit-tested.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  function groupKey(n, by) {
    if (by === 'lane') return (ns.layoutStageOf && ns.layoutStageOf(n)) || 'other';
    return (ns.kindFamily && ns.kindFamily(n.kind)) || 'core';
  }

  /**
   * clusterScene → { clusters:[{id,label,count,memberIds,position}], clusterEdges:[{fromId,toId,count}] }
   */
  function clusterScene(graph, opts) {
    const by = (opts && opts.by) || 'family';
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const edges = toArray(graph && (graph.edges || graph.Edges));
    const groups = new Map();
    const clusterOf = new Map();
    for (const n of nodes) {
      const g = groupKey(n, by);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
      clusterOf.set(n.id, 'cluster:' + g);
    }
    const clusters = [];
    for (const [g, members] of groups) {
      let sx = 0, sy = 0, cnt = 0;
      for (const m of members) { if (m.position) { sx += m.position.x; sy += m.position.y; cnt++; } }
      clusters.push({
        id: 'cluster:' + g,
        label: g,
        count: members.length,
        memberIds: members.map((m) => m.id),
        position: cnt ? { x: sx / cnt, y: sy / cnt } : { x: 0, y: 0 },
      });
    }
    const agg = new Map();
    for (const e of edges) {
      const a = clusterOf.get(e.fromNodeId), b = clusterOf.get(e.toNodeId);
      if (!a || !b || a === b) continue;
      const k = a + '→' + b;
      agg.set(k, (agg.get(k) || 0) + 1);
    }
    const clusterEdges = [...agg].map(([k, count]) => { const i = k.indexOf('→'); return { fromId: k.slice(0, i), toId: k.slice(i + 1), count }; });
    return { clusters, clusterEdges };
  }

  const api = { clusterScene };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
