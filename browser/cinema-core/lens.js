/**
 * Infrix Cinema — role lens (Wave K / K1).
 *
 * One graph for everyone is wrong: an auditor, an operator, a regulator, and an
 * agent-developer care about disjoint things. A lens reframes the SAME disclosed
 * scene — its emphasis, default view, and primary action — to one role's
 * concerns, with zero manual configuration. It never changes what's visible for
 * disclosure; only what's foregrounded.
 *
 * `applyLens` / `lensEmphasis` are pure + unit-tested.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  const LENSES = {
    auditor: {
      label: 'Auditor', emphasizeKinds: ['evidence', 'evidence_link', 'anchor', 'l0_bridge', 'disclosure_grant'],
      view: 'split', primaryAction: 'verify',
    },
    operator: {
      label: 'Operator', emphasizeKinds: ['contract', 'account', 'circuit_breaker'],
      emphasize: (n) => !!n.breakerState || n.anomalyScore > 0, view: 'graph', primaryAction: 'jumpAnomaly',
    },
    regulator: {
      label: 'Regulator', emphasizeKinds: ['policy', 'policy_decision', 'approval_gate', 'approver', 'disclosure_grant', 'intent', 'outcome'],
      view: 'narrative', primaryAction: 'playStory',
    },
    agentDev: {
      label: 'Agent-dev', emphasizeKinds: ['intent', 'policy', 'approval_gate'],
      emphasize: (n) => /agent|prevent/i.test(String(n.id) + ' ' + String(n.label || '')), view: 'graph', primaryAction: 'verify',
    },
  };
  const DEFAULT = { label: 'All', emphasizeKinds: [], view: 'split', primaryAction: null };

  function applyLens(role) { return LENSES[role] || DEFAULT; }

  /** lensEmphasis → the node ids a role foregrounds (others get de-emphasized). */
  function lensEmphasis(graph, role) {
    const L = applyLens(role);
    const kinds = new Set(L.emphasizeKinds || []);
    const nodes = toArray(graph && (graph.nodes || graph.Nodes));
    const out = [];
    for (const n of nodes) {
      if (kinds.has(n.kind) || (typeof L.emphasize === 'function' && L.emphasize(n))) out.push(n.id);
    }
    return out;
  }

  const api = { applyLens, lensEmphasis, LENSES };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
