/**
 * Infrix Cinema — question-based smart filters (Wave K / K2).
 *
 * Search finds nodes; smart filters ANSWER QUESTIONS in one tap — "Unanchored
 * outcomes", "Anything an agent was stopped from", "Sealed but disclosable to
 * me", "Steps that drifted from plan", "Frozen or anomalous" — each a real query
 * over data already present. Disclosure-safe: predicates read only ids/kinds/
 * flags, never a redacted value.
 *
 * `SMART_FILTERS` + `runSmartFilter` are pure + unit-tested.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  const SMART_FILTERS = [
    { id: 'unanchored', label: 'Unanchored outcomes', predicate: (n, ctx) => n.kind === 'outcome' && !ctx.anchored },
    { id: 'stopped-agent', label: 'Stopped agent actions', predicate: (n) => n.id === 'prevented' || /prevent|not authorized|refus/i.test(String(n.label || '')) },
    { id: 'disclosable', label: 'Sealed but disclosable to me', predicate: (n) => !!n.redacted && !!n.grantId },
    { id: 'drifted', label: 'Steps that drifted from plan', predicate: (n, ctx) => !!(ctx.driftedIds && ctx.driftedIds.has(n.id)) },
    { id: 'frozen-anomalous', label: 'Frozen or anomalous', predicate: (n) => n.breakerState === 'frozen' || n.anomalyScore > 0 },
  ];

  function filterById(id) { return SMART_FILTERS.find((f) => f.id === id) || null; }

  /** runSmartFilter → matched node ids for a filter id, given a context. */
  function runSmartFilter(graph, id, ctx) {
    const f = filterById(id);
    if (!f) return [];
    ctx = ctx || {};
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const out = [];
    for (const n of nodes) { if (f.predicate(n, ctx)) out.push(n.id); }
    return out;
  }

  const api = { SMART_FILTERS, runSmartFilter, smartFilterById: filterById };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
