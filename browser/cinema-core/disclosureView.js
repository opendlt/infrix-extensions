/**
 * Infrix Cinema — client-side disclosure view.
 *
 * Browser mirror of pkg/cinema/scene/visibility_filter.go. The Go filter
 * already runs server-side when a scene is built for an authenticated viewer;
 * this module is the LAST-LINE client guarantee that no Cinema surface leaks
 * private data through a side channel even if it is ever handed a scene that
 * still carries private nodes (e.g. a proof bundle, a cached fixture, or an
 * embed host that forgot to scope its data source).
 *
 * It reproduces the Go FilterAction decision table exactly:
 *   public        -> render_full
 *   owner-read    -> render_full if viewer == owner, else placeholder
 *   private       -> placeholder ([private] / [encrypted])
 *   authority     -> suppress (node removed)
 *   unknown       -> placeholder (fail-closed)
 * with a disclosure-grant override that upgrades placeholder/suppress to
 * render_full, and FIXED size/opacity so private nodes never leak magnitude.
 *
 * Mirrors: TestVisibilityFilter* in pkg/cinema/scene/visibility_filter_test.go.
 */
(function (root) {
  'use strict';

  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  const D = ns.DISCLOSURE || {};

  // FilterAction — identical ordering/string to Go's FilterAction.
  const FilterAction = {
    RENDER_FULL: 'render_full',
    RENDER_PLACEHOLDER: 'render_placeholder',
    RENDER_OWNER_ONLY: 'render_owner_only',
    SUPPRESS: 'suppress',
  };

  // Visibility levels — mirror shadow.VisibilityPolicy levels.
  const Level = {
    PUBLIC: 'public',
    OWNER_READ: 'owner_read',
    PRIVATE: 'private',
    AUTHORITY_ONLY: 'authority_only',
  };

  /**
   * decide reproduces VisibilityFilter.FilterStateKey for one node/value.
   * @param {string} level    visibility level (Level.*)
   * @param {object} ctx      { viewerId, owner, hasGrant, grantId }
   * @returns {{action,label,placeholder,zkIndicator,fixedSize}}
   */
  function decide(level, ctx) {
    ctx = ctx || {};
    let decision;
    switch (level) {
      case Level.PUBLIC:
        decision = { action: FilterAction.RENDER_FULL, label: ctx.key || '', placeholder: '', zkIndicator: false, fixedSize: 0 };
        break;
      case Level.OWNER_READ:
        if (ctx.viewerId && ctx.owner && ctx.viewerId === ctx.owner) {
          decision = { action: FilterAction.RENDER_OWNER_ONLY, label: ctx.key || '', placeholder: '', zkIndicator: false, fixedSize: 0 };
        } else {
          decision = { action: FilterAction.RENDER_PLACEHOLDER, label: D.LABEL_OWNER_RESTRICTED, placeholder: D.PLACEHOLDER_ENCRYPTED, zkIndicator: true, fixedSize: D.PRIVATE_NODE_FIXED_SIZE };
        }
        break;
      case Level.AUTHORITY_ONLY:
        decision = { action: FilterAction.SUPPRESS, label: '', placeholder: '', zkIndicator: false, fixedSize: 0 };
        break;
      case Level.PRIVATE:
        decision = { action: FilterAction.RENDER_PLACEHOLDER, label: D.LABEL_PRIVATE, placeholder: D.PLACEHOLDER_ENCRYPTED, zkIndicator: true, fixedSize: D.PRIVATE_NODE_FIXED_SIZE };
        break;
      default:
        // Fail-closed: unknown level treated as private.
        decision = { action: FilterAction.RENDER_PLACEHOLDER, label: D.LABEL_UNKNOWN, placeholder: D.PLACEHOLDER_ENCRYPTED, zkIndicator: false, fixedSize: D.PRIVATE_NODE_FIXED_SIZE };
    }

    // Disclosure-grant override (G-13): a held grant upgrades a hidden
    // decision to a full render, exactly as the Go filter does. A malformed
    // context (some-but-not-all identity fields) fails closed — no override.
    const malformed = ctxMalformed(ctx);
    if (!malformed && ctx.hasGrant &&
        (decision.action === FilterAction.RENDER_PLACEHOLDER || decision.action === FilterAction.SUPPRESS)) {
      const label = ctx.grantId
        ? (ctx.key || '') + D.DISCLOSED_VIA_PREFIX + ctx.grantId + ']'
        : (ctx.key || '') + D.DISCLOSED_SUFFIX;
      decision = { action: FilterAction.RENDER_FULL, label, placeholder: '', zkIndicator: false, fixedSize: 0 };
    }
    return decision;
  }

  // ctxMalformed mirrors scene.DisclosureContext.IsMalformed: some-but-not-all
  // of the (viewer, purpose, workflow) identity triple populated.
  function ctxMalformed(ctx) {
    const any = !!(ctx.viewerId || ctx.purpose || ctx.workflowInstance);
    const all = !!(ctx.viewerId && ctx.purpose && ctx.workflowInstance);
    return any && !all;
  }

  /**
   * applyDisclosure rewrites a scene graph in place of any private content,
   * returning a NEW graph that is safe to render. A node is treated as private
   * when it declares `visibility`/`encryptedFields`. This never mutates the
   * input. Suppressed nodes (and their incident edges) are removed entirely.
   *
   * @param {object} graph  scene graph (nodes/edges as map or array)
   * @param {object} ctx    { viewerId, purpose, workflowInstance, grants:Set, mode }
   */
  function applyDisclosure(graph, ctx) {
    ctx = ctx || {};
    const nodesIn = toArray(graph.nodes || graph.Nodes);
    const edgesIn = toArray(graph.edges || graph.Edges);
    const keptIds = new Set();
    const nodesOut = [];

    for (const raw of nodesIn) {
      const n = Object.assign({}, raw);
      const level = nodeLevel(n);
      if (level === Level.PUBLIC) {
        keptIds.add(n.id); nodesOut.push(n); continue;
      }
      const owner = n.owner || n.url || '';
      const key = n.label || n.id || '';
      const hasGrant = ctx.grants instanceof Set
        ? (ctx.grants.has(grantKey(n)) || ctx.grants.has(owner))
        : false;
      const dec = decide(level, {
        viewerId: ctx.viewerId, purpose: ctx.purpose, workflowInstance: ctx.workflowInstance,
        owner, key, hasGrant, grantId: hasGrant ? (n.grantId || '') : '',
      });
      if (dec.action === FilterAction.SUPPRESS) continue; // node + edges dropped
      if (dec.action === FilterAction.RENDER_FULL || dec.action === FilterAction.RENDER_OWNER_ONLY) {
        if (dec.label) n.label = dec.label;
        keptIds.add(n.id); nodesOut.push(n); continue;
      }
      // Placeholder: redact label, fix size/opacity, strip magnitude fields so
      // neither the value, its size, nor its balance can be inferred.
      n.label = dec.label;
      n.size = D.PRIVATE_NODE_FIXED_SIZE;
      n.opacity = D.PRIVATE_NODE_FIXED_OPACITY;
      n.color = ns.COLORS ? ns.COLORS.Encrypted : n.color;
      n.zkIndicator = dec.zkIndicator;
      delete n.balance;
      delete n.amount;
      delete n.anomalyScore;
      n.redacted = true;
      keptIds.add(n.id); nodesOut.push(n);
    }

    // Keep only edges whose endpoints both survived; redact private edges.
    const edgesOut = [];
    for (const raw of edgesIn) {
      const e = Object.assign({}, raw);
      if (!keptIds.has(e.fromNodeId) || !keptIds.has(e.toNodeId)) continue;
      const level = edgeLevel(e);
      if (level !== Level.PUBLIC) {
        e.label = D.LABEL_PRIVATE;
        e.width = D.PRIVATE_EDGE_FIXED_WIDTH;
        e.particleCount = D.PRIVATE_PARTICLE_FIXED_COUNT;
        delete e.amount;
        delete e.gasCost;
        e.redacted = true;
      }
      edgesOut.push(e);
    }

    return Object.assign({}, graph, { nodes: nodesOut, edges: edgesOut });
  }

  function nodeLevel(n) {
    if (n.visibility && Level[String(n.visibility).toUpperCase()]) return Level[String(n.visibility).toUpperCase()];
    if (n.visibility) return n.visibility; // already a level string
    if (n.encryptedFields > 0) return Level.PRIVATE;
    return Level.PUBLIC;
  }
  function edgeLevel(e) {
    if (e.visibility) return e.visibility;
    return Level.PUBLIC;
  }
  function grantKey(n) { return (n.url || '') + '::' + (n.label || n.id || ''); }

  function toArray(x) {
    if (!x) return [];
    return Array.isArray(x) ? x.slice() : Object.values(x);
  }

  Object.assign(ns, { FilterAction, Level, decide, applyDisclosure, ctxMalformed });
  const api = { FilterAction, Level, decide, applyDisclosure, ctxMalformed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
