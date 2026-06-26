/**
 * Infrix Cinema — narrative templates (adoption-05).
 *
 * Turns a Cinema scene (already disclosure-filtered) + the proof that backs it
 * into a chronological, plain-language audit story. This is the exact browser
 * mirror of pkg/cinema/narrative (event.go / templates.go / builder.go), so the
 * server-built and client-built stories read the same.
 *
 * Two invariants, identical to the canvas and to proofPanel.js:
 *   - assurance is CAPPED: an event never claims L0 without an anchor present.
 *   - disclosure is PRESERVED: a redacted node's real label/amount never leaks
 *     into narrative text (the input scene is already redacted by
 *     disclosureView.applyDisclosure; we only ever read the redacted label).
 *
 * Classic script: attaches to globalThis.InfrixCinema and exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  const D = ns.DISCLOSURE || {};
  const LABEL_PRIVATE = D.LABEL_PRIVATE || '[private]';
  const ASSURANCE_ORDER = ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness'];

  // node kind -> spine stage (mirror of templates.go stageForKind).
  function stageForKind(kind) {
    switch (kind) {
      case 'intent': return 'intent';
      case 'plan_timeline': case 'policy': case 'policy_decision': case 'policy_check': return 'policy';
      case 'approval_gate': case 'approver': case 'approval': return 'approval';
      case 'plan_step': case 'contract': case 'account': case 'escrow': case 'settlement':
      case 'reservation': case 'token_pool': case 'netting_group': case 'object_op':
      case 'subsystem_action': return 'execution';
      case 'outcome': return 'outcome';
      case 'evidence': case 'evidence_link': return 'evidence';
      case 'anchor': case 'l0_bridge': return 'anchor';
      case 'disclosure_grant': case 'disclosure': return 'disclosure';
      default: return null;
    }
  }
  const STAGE_ORDER = { intent: 0, policy: 1, approval: 2, execution: 3, outcome: 4, evidence: 5, anchor: 6, witness: 7, disclosure: 8 };
  function rankAssurance(id) { const i = ASSURANCE_ORDER.indexOf(id); return i < 0 ? 0 : i; }

  function capAssurance(stage, f) {
    let id = 'offline';
    if (f.hasReplay) id = 'replay';
    if (f.anchored) id = 'l0';
    if (f.anchored && f.witnessed) id = 'witness';
    if (stage === 'anchor' && !f.anchored && rankAssurance(id) > rankAssurance('replay')) id = 'replay';
    if (stage === 'witness' && !f.witnessed) id = f.anchored ? 'l0' : (rankAssurance(id) > rankAssurance('replay') ? 'replay' : id);
    return id;
  }

  function headline(stage, c) {
    switch (stage) {
      case 'intent': return (c.actor || 'A requester') + ' requested ' + c.label + '.';
      case 'policy': return c.status === 'failed' ? 'Policy denied this request.' : 'Policy allowed this request.';
      case 'approval': return c.status === 'failed'
        ? 'Execution stopped because the approval signature did not match the current plan hash.'
        : 'The required approver signed the plan hash.';
      case 'execution': return c.status === 'failed' ? 'Execution stopped before it completed.' : 'The workflow executed.';
      case 'outcome': return c.status === 'failed' ? 'No outcome was committed.' : 'The outcome was committed.';
      case 'evidence': return 'Infrix produced an evidence bundle.';
      case 'anchor': return c.anchored
        ? 'The evidence commitment was confirmed on Accumulate L0.'
        : 'Evidence is sealed locally; no L0 confirmation is present in this bundle.';
      case 'witness': return c.witnessed ? 'Independent witnesses co-signed the outcome.' : 'No independent witnesses are present in this bundle.';
      case 'disclosure': return 'A selective disclosure was exercised.';
      default: return c.label;
    }
  }

  function summary(stage, c) {
    switch (stage) {
      case 'intent': return 'An intent opened the governed flow.';
      case 'policy': return c.status === 'failed'
        ? 'The request did not match an allowed rule, so it was rejected.'
        : 'The plan matched the regulated-release rule, so the request was admitted.';
      case 'approval': return c.status === 'failed'
        ? 'The approval did not bind to the plan that would have executed.'
        : 'The approval binds to the exact plan that executed.';
      case 'execution': return c.status === 'failed'
        ? 'A required step did not complete, so the flow halted.'
        : 'The governed steps ran to completion.';
      case 'outcome': return c.redacted
        ? ('The result was recorded, but its details stay redacted (' + LABEL_PRIVATE + ').')
        : ('The result was recorded as "' + c.label + '".');
      case 'evidence': return 'It binds the plan, the outcome, the policy decision, and the proof material.';
      case 'anchor': return c.anchored
        ? ('Anchored at block ' + c.block + ' — independently verifiable.')
        : 'The commitment can be confirmed later by anchoring it to L0.';
      case 'witness': return c.witnessed ? 'Each witness independently re-derived and signed the outcome.' : 'Add witnesses to raise assurance above L0.';
      case 'disclosure': return 'Only the disclosed fields are visible; the rest stay redacted.';
      default: return '';
    }
  }

  function proofRefs(stage) {
    return ({
      intent: ['intent'], policy: ['plan', 'policy'], approval: ['approvals'], execution: ['steps'],
      outcome: ['outcome'], evidence: ['evidence'], anchor: ['anchor'], witness: ['witness'], disclosure: ['disclosure'],
    })[stage] || [];
  }

  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  // proofFacts derives the assurance-bearing facts from a proof bundle.
  function proofFacts(proof) {
    proof = proof || {};
    const has = (k) => proof[k] && (Array.isArray(proof[k]) ? proof[k].length : true);
    const anchored = !!(proof.anchor && (proof.anchor.block || proof.anchor.txHash || proof.anchor.confirmed));
    return {
      anchored,
      anchorBlock: (proof.anchor && proof.anchor.block) || 0,
      witnessed: !!(has('witness')),
      hasReplay: !!(proof.replay || proof.frames),
    };
  }

  /**
   * buildNarrative derives the ordered story from a (disclosure-filtered) scene
   * and the proof facts.
   * @param {object} graph  scene graph (nodes/edges map or array)
   * @param {object} opts   { proof?, actor?, anchored?, anchorBlock?, witnessed?, hasReplay?, stageStatus? }
   * @returns {Array<NarrativeEvent>}
   */
  function buildNarrative(graph, opts) {
    opts = opts || {};
    if (!graph) return [];
    const facts = Object.assign(proofFacts(opts.proof), {});
    if (opts.anchored != null) facts.anchored = !!opts.anchored;
    if (opts.anchorBlock != null) facts.anchorBlock = opts.anchorBlock;
    if (opts.witnessed != null) facts.witnessed = !!opts.witnessed;
    if (opts.hasReplay != null) facts.hasReplay = !!opts.hasReplay;
    const actor = opts.actor || '';
    const stageStatus = opts.stageStatus || {};

    const nodes = toArray(graph.nodes || graph.Nodes);
    const edges = toArray(graph.edges || graph.Edges);

    // Group nodes by stage; pick a disclosure-safe representative label.
    const groups = {};
    const nodeStage = {};
    for (const n of nodes) {
      const stage = stageForKind(n.kind);
      if (!stage) continue;
      nodeStage[n.id] = stage;
      const g = groups[stage] || (groups[stage] = { stage, nodeIds: [], edgeIds: [], label: '', redacted: false });
      g.nodeIds.push(n.id);
      const redacted = !!n.redacted || (n.encryptedFields > 0);
      const label = redacted ? LABEL_PRIVATE : (n.label || n.id);
      if (!g.label || (redacted && !g.redacted)) g.label = label;
      if (redacted) g.redacted = true;
    }
    for (const e of edges) {
      const s = nodeStage[e.toNodeId];
      if (s && groups[s]) groups[s].edgeIds.push(e.id);
    }

    const order = Object.keys(groups).sort((a, b) => (STAGE_ORDER[a] ?? 99) - (STAGE_ORDER[b] ?? 99));
    const events = [];
    let failedSeen = false;
    let seq = 0;
    for (const stage of order) {
      const g = groups[stage];
      let status = stageStatus[stage];
      if (!status) {
        if (failedSeen) status = 'pending';
        else if (stage === 'anchor') status = facts.anchored ? 'verified' : 'pending';
        else if (stage === 'witness') status = facts.witnessed ? 'verified' : 'pending';
        else if (stage === 'evidence') status = 'verified';
        else status = 'passed';
      }
      if (status === 'failed') failedSeen = true;
      const c = {
        label: g.label, actor, status, redacted: g.redacted,
        anchored: facts.anchored, witnessed: facts.witnessed,
        block: stage === 'anchor' && facts.anchored ? facts.anchorBlock : (graph.blockHeight || graph.BlockHeight || 0),
      };
      events.push({
        id: 'narr-' + stage,
        sequence: seq,
        blockHeight: c.block,
        actor,
        stage,
        // Honor an optional curated server-supplied headline; fall back to the
        // template. Never used to leak a redacted value (caller passes safe text).
        headline: (opts.headlines && opts.headlines[stage]) || headline(stage, c),
        summary: summary(stage, c),
        status,
        assurance: capAssurance(stage, facts),
        proofRefs: proofRefs(stage),
        graphNodeIds: g.nodeIds,
        graphEdgeIds: g.edgeIds,
        redacted: g.redacted,
      });
      seq++;
    }
    return events;
  }

  Object.assign(ns, { buildNarrative, narrativeStageForKind: stageForKind, narrativeCapAssurance: capAssurance });
  const api = { buildNarrative, stageForKind, capAssurance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
