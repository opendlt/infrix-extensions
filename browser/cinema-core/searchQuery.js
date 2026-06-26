/**
 * Infrix Cinema — search query grammar (Tier B / B4).
 *
 * Turns the filter box from a dumb substring dimmer into a real query language.
 * Pure + dependency-free so the parser/matcher are unit-testable:
 *
 *   kind:contract            node kind contains "contract"
 *   status:frozen            derived node status contains "frozen"
 *   gas:>10000               node total gas (via ctx.gasOf) > 10000
 *   transfer                 free text — matches label + kind + url
 *
 * Multiple clauses are AND-ed. An unknown `field:value` is treated as free text
 * (never a silent match-all). Disclosure-safe: it only reads the redacted label
 * the renderer already holds; a redacted node's status is simply "private".
 *
 * Classic script: attaches to window.InfrixCinema, exports for node tests.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  const FIELDS = { kind: 1, status: 1, gas: 1 };
  const GAS_RE = /^(>=|<=|=|==|>|<)?\s*(\d[\d_]*)$/;

  // nodeStatus derives a single coarse status word for status: matching.
  function nodeStatus(node) {
    if (!node) return 'normal';
    if (node.redacted) return 'private';
    if (node.quarantined) return 'quarantined';
    if (node.breakerState) return String(node.breakerState).toLowerCase();
    if (node.anomalyScore > 0) return 'anomaly';
    return 'normal';
  }

  function parseSearchQuery(str) {
    const raw = String(str || '').trim();
    const predicates = [];
    const terms = [];
    if (!raw) return { predicates, terms, isEmpty: true, raw };
    for (const tok of raw.split(/\s+/)) {
      const m = tok.match(/^([a-zA-Z]+):(.+)$/);
      if (m && FIELDS[m[1].toLowerCase()]) {
        const field = m[1].toLowerCase();
        const val = m[2];
        if (field === 'gas') {
          const g = val.match(GAS_RE);
          if (g) { predicates.push({ field: 'gas', op: g[1] || '=', num: Number(String(g[2]).replace(/_/g, '')) }); continue; }
          // malformed gas clause → fall through to free text so it can't match-all
        } else {
          predicates.push({ field, val: val.toLowerCase() });
          continue;
        }
      }
      terms.push(tok.toLowerCase());
    }
    return { predicates, terms, isEmpty: predicates.length === 0 && terms.length === 0, raw };
  }

  function cmp(a, op, b) {
    switch (op) {
      case '>': return a > b;
      case '<': return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
      case '=': case '==': default: return a === b;
    }
  }

  function matchSearch(node, parsed, ctx) {
    if (!parsed || parsed.isEmpty) return true;
    ctx = ctx || {};
    for (const p of parsed.predicates) {
      if (p.field === 'kind') {
        if (!String(node.kind || '').toLowerCase().includes(p.val)) return false;
      } else if (p.field === 'status') {
        if (!nodeStatus(node).includes(p.val)) return false;
      } else if (p.field === 'gas') {
        const g = typeof ctx.gasOf === 'function' ? (ctx.gasOf(node) || 0) : 0;
        if (!cmp(g, p.op, p.num)) return false;
      }
    }
    if (parsed.terms.length) {
      const hay = (String(node.label || '') + ' ' + String(node.kind || '') + ' ' + String(node.url || '')).toLowerCase();
      for (const t of parsed.terms) if (!hay.includes(t)) return false;
    }
    return true;
  }

  const api = { parseSearchQuery, matchSearch, nodeStatus };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
