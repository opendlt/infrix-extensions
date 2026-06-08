/**
 * Infrix Cinema — narrative ↔ graph ↔ replay synchronization (adoption-05).
 *
 * Keeps the narrative panel, the scene graph, and the replay head in lockstep:
 *   - replay position changes  -> panel.setPosition (future events dim).
 *   - a graph node is selected  -> the matching story card highlights.
 *   - a story card is clicked   -> the related graph nodes are highlighted
 *     (dimming the rest) so the eye lands where the sentence is talking about.
 *
 * The graph highlight reuses the renderer's own opacity/glow fields (no new
 * renderer API), so it works identically across every Cinema mode.
 *
 * Classic script: attaches to globalThis.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  function nodesOf(graph) {
    if (!graph) return [];
    const n = graph.nodes || graph.Nodes;
    return !n ? [] : (Array.isArray(n) ? n : Object.values(n));
  }

  /**
   * createNarrativeSync wires a renderer, a narrative panel, and (optionally) a
   * timeline together. Returns { onPosition, highlightNodes, clearHighlight,
   * destroy }.
   *
   * @param {object} cfg { renderer, panel, timeline? }
   */
  function createNarrativeSync(cfg) {
    cfg = cfg || {};
    const renderer = cfg.renderer;
    const panel = cfg.panel;
    let savedOpacity = null;

    // Graph -> narrative: when a node is selected on the canvas, highlight its
    // story card. Renderer emits 'nodeSelected' (see app.js wiring).
    function onNodeSelected(n) {
      if (n && n.id && panel && panel.focusByNode) panel.focusByNode(n.id);
    }
    if (renderer && typeof renderer.on === 'function') renderer.on('nodeSelected', onNodeSelected);

    // Narrative -> graph: dim every node except the focused set; raise theirs.
    function highlightNodes(ids) {
      const g = renderer && renderer.sceneGraph;
      if (!g) return;
      const set = new Set(ids || []);
      const all = nodesOf(g);
      if (!savedOpacity) {
        savedOpacity = new Map();
        for (const node of all) savedOpacity.set(node.id, node.opacity != null ? node.opacity : 1);
      }
      if (!set.size) { clearHighlight(); return; }
      for (const node of all) {
        const on = set.has(node.id);
        node.opacity = on ? 1 : 0.18;
        node.glow = on ? Math.max(node.glow || 0, 0.6) : (node.glow || 0);
      }
    }
    function clearHighlight() {
      const g = renderer && renderer.sceneGraph;
      if (!g || !savedOpacity) return;
      for (const node of nodesOf(g)) {
        if (savedOpacity.has(node.id)) node.opacity = savedOpacity.get(node.id);
      }
    }

    // Replay -> narrative: advance the story head.
    function onPosition(seq) {
      if (panel && panel.setPosition) panel.setPosition(seq | 0);
    }

    return {
      onPosition,
      highlightNodes,
      clearHighlight,
      destroy() {
        if (renderer && typeof renderer.off === 'function') renderer.off('nodeSelected', onNodeSelected);
        clearHighlight();
      },
    };
  }

  ns.createNarrativeSync = createNarrativeSync;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createNarrativeSync };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
