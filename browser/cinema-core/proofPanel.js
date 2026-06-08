/**
 * Infrix Cinema — proof mode panel.
 *
 * Proof mode turns a portable proof bundle into an inspectable, node-
 * independent story: intent → plan → approvals → steps → outcome → evidence →
 * anchor → witness → replay. Each row carries an ASSURANCE label
 * (offline / replay / L0 / witness). The cardinal rule: NEVER imply L4 (full
 * external finality) without an L0 anchor present in the bundle — the panel
 * caps the displayed assurance at what the bundle actually backs.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  const STAGES = [
    ['intent', 'Intent', 'The action that was requested.'],
    ['plan', 'Plan', 'How the system decided to carry it out.'],
    ['approvals', 'Approvals', 'Who authorized it.'],
    ['steps', 'Steps', 'What actually executed.'],
    ['outcome', 'Outcome', 'The committed result.'],
    ['evidence', 'Evidence', 'The portable evidence bundle.'],
    ['anchor', 'Anchor', 'The Accumulate L0 anchor.'],
    ['witness', 'Witness', 'Independent witness co-signatures.'],
    ['replay', 'Replay', 'Deterministic re-execution.'],
  ];

  // capAssurance enforces the ladder: a stage may not claim a level the bundle
  // does not support. Without an L0 anchor, nothing rises above 'replay'.
  function capAssurance(stageId, proof) {
    const has = (k) => proof && proof[k] && (Array.isArray(proof[k]) ? proof[k].length : true);
    const hasAnchor = has('anchor') || (proof && proof.assurance && rank(proof.assurance.id) >= 2);
    const hasWitness = has('witness') || (proof && proof.assurance && rank(proof.assurance.id) >= 3);
    let id = 'offline';
    if (has('replay') || (proof && proof.frames)) id = 'replay';
    if (hasAnchor) id = 'l0';
    if (hasAnchor && hasWitness) id = 'witness';
    // A stage about anchoring/witness can never exceed what's present.
    if (stageId === 'anchor' && !hasAnchor) id = 'offline';
    if (stageId === 'witness' && !hasWitness) id = (hasAnchor ? 'l0' : 'offline');
    return (ns.ASSURANCE && Object.values(ns.ASSURANCE).find(a => a.id === id)) || { id, label: id };
  }
  function rank(id) { return Math.max(0, (ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness']).indexOf(id)); }

  class ProofPanel {
    constructor(hostEl, proof, opts) {
      this.host = hostEl;
      this.proof = proof || {};
      this.opts = opts || {};
      this.el = null;
      this.build();
    }
    build() {
      const wrap = document.createElement('section');
      wrap.className = 'cinema-proof-panel';
      wrap.id = 'cinema-proof-panel';

      const head = document.createElement('header');
      head.className = 'cinema-proof-head';
      const title = document.createElement('h3');
      title.textContent = 'Portable proof';
      head.appendChild(title);
      const sub = document.createElement('p');
      sub.className = 'cinema-proof-sub';
      sub.textContent = 'Verified from the bundle — no trust in the serving node required where an anchor or replay is present.';
      head.appendChild(sub);
      wrap.appendChild(head);

      // Top-level assurance badge (capped at what the bundle backs).
      const overall = capAssurance('overall', this.proof);
      const badge = document.createElement('div');
      badge.className = 'cinema-assurance-badge';
      badge.id = 'cinema-assurance-overall';
      badge.dataset.assurance = overall.id;
      badge.style.borderColor = ns.colorCss ? ns.colorCss(overall.color || {}) : '#888';
      badge.textContent = 'Assurance: ' + overall.label;
      wrap.appendChild(badge);

      const list = document.createElement('ol');
      list.className = 'cinema-proof-stages';
      for (const [id, label, hint] of STAGES) {
        const present = stagePresent(id, this.proof);
        const a = capAssurance(id, this.proof);
        const li = document.createElement('li');
        li.className = 'cinema-proof-stage' + (present ? '' : ' absent');
        li.dataset.stage = id;
        const name = document.createElement('span'); name.className = 'cinema-proof-stage-name'; name.textContent = label;
        const lvl = document.createElement('span');
        lvl.className = 'cinema-proof-stage-assurance';
        lvl.dataset.assurance = present ? a.id : 'absent';
        lvl.textContent = present ? a.label : 'not in bundle';
        const note = document.createElement('span'); note.className = 'cinema-proof-stage-note'; note.textContent = hint;
        li.appendChild(name); li.appendChild(lvl); li.appendChild(note);
        list.appendChild(li);
      }
      wrap.appendChild(list);

      this.el = wrap;
      if (this.host) this.host.appendChild(wrap);
    }
  }

  function stagePresent(id, proof) {
    if (!proof) return false;
    if (id === 'replay') return !!(proof.replay || proof.frames);
    const v = proof[id];
    return !!(v && (Array.isArray(v) ? v.length : true));
  }

  ns.ProofPanel = ProofPanel;
  ns.capAssurance = capAssurance;
  if (typeof module !== 'undefined' && module.exports) module.exports = { ProofPanel, capAssurance };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
