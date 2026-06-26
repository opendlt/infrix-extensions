/**
 * Infrix Cinema — narrative panel (adoption-05).
 *
 * Renders the audit story (built by narrativeTemplates.buildNarrative) as a
 * column of chronological, keyboard-reachable cards. Each card explains one
 * spine stage in plain language and carries an honest, capped assurance label.
 *
 * The panel is a read-only view of the scene/proof; it never invents truth.
 * Raw hashes are hidden by default (a "show raw hashes" toggle reveals the
 * proof refs + graph node ids). Clicking a card highlights the related graph
 * nodes (via opts.onCardFocus); the sync module highlights the matching card
 * when a graph node is selected and dims future events as the replay advances.
 *
 * Classic script: attaches to globalThis.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  const ASSURANCE_ORDER = ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness'];

  const STAGE_LABEL = {
    intent: 'Intent', policy: 'Policy', approval: 'Approval', execution: 'Execution',
    outcome: 'Outcome', evidence: 'Evidence', anchor: 'Anchor', witness: 'Witness', disclosure: 'Disclosure',
  };
  const STAGE_ICON = {
    intent: '◆', policy: '§', approval: '✔', execution: '⚙', outcome: '●',
    evidence: '🗎', anchor: '⚓', witness: '👁', disclosure: '🔒',
  };
  // "What this proves" — one honest line per spine stage (C4).
  const STAGE_PROVES = {
    intent: 'a governed flow was opened by a named requester.',
    policy: 'the request was checked against an explicit rule before it ran.',
    approval: 'the approval is bound to the exact plan that executed.',
    execution: 'the governed steps ran (or halted) deterministically.',
    outcome: 'the committed result is the one the plan produced.',
    evidence: 'a portable bundle binds the plan, outcome, policy, and proof.',
    anchor: 'the evidence commitment is independently verifiable on L0.',
    witness: 'independent witnesses re-derived and signed the outcome.',
    disclosure: 'only the disclosed fields are visible; the rest stay sealed.',
  };
  const ASSURANCE_LABEL = { offline: 'offline', replay: 'replay', l0: 'L0', witness: 'witness' };

  function elt(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  class NarrativePanel {
    constructor(hostEl, opts) {
      this.host = hostEl;
      this.opts = opts || {};
      this.events = [];
      this.showRaw = false;
      this.stageFilter = null; // null = all stages
      this.currentSeq = 0;
      this._cards = new Map(); // seq -> { li, btn }
      this._build();
    }

    _build() {
      const aside = elt('aside', 'cinema-narrative-panel');
      aside.id = 'cinema-narrative-panel';
      aside.setAttribute('aria-label', 'Audit story');

      const head = elt('header', 'cinema-narrative-head');
      head.appendChild(elt('h3', 'cinema-narrative-title', 'Audit story'));

      const receipt = elt('div', 'cinema-narrative-receipt');
      receipt.id = 'cinema-narrative-receipt';
      head.appendChild(receipt);
      this.receiptEl = receipt;

      const ctrls = elt('div', 'cinema-narrative-controls');
      const filters = elt('div', 'cinema-narrative-filters');
      filters.setAttribute('role', 'group');
      filters.setAttribute('aria-label', 'Filter by stage');
      this.filtersEl = filters;
      ctrls.appendChild(filters);

      const rawLabel = elt('label', 'cinema-narrative-rawtoggle');
      const rawInput = document.createElement('input');
      rawInput.type = 'checkbox';
      rawInput.id = 'cinema-narrative-rawtoggle';
      rawInput.addEventListener('change', () => { this.showRaw = rawInput.checked; this._renderList(); });
      rawLabel.appendChild(rawInput);
      rawLabel.appendChild(elt('span', null, 'Show raw hashes'));
      ctrls.appendChild(rawLabel);
      head.appendChild(ctrls);

      aside.appendChild(head);

      const list = elt('ol', 'cinema-narrative-list');
      list.id = 'cinema-narrative-list';
      aside.appendChild(list);
      this.listEl = list;

      this.el = aside;
      if (this.host) this.host.appendChild(aside);
    }

    /** setScene rebuilds the story from a (disclosure-filtered) scene graph. */
    setScene(graph, buildOpts) {
      const opts = Object.assign({ proof: this.opts.proof, headlines: this.opts.headlines }, buildOpts || {});
      this.events = (ns.buildNarrative ? ns.buildNarrative(graph, opts) : []) || [];
      this._renderFilters();
      this._renderReceipt();
      this._renderList();
      this.setPosition(this.currentSeq);
    }

    _renderReceipt() {
      const overall = this.events.reduce((acc, e) => (rank(e.assurance) > rank(acc) ? e.assurance : acc), 'offline');
      this.receiptEl.replaceChildren();
      // Shared Trust Ladder (C1): same component as the proof rail. Use the
      // bundle's proof when present, else synthesize the ceiling from the
      // events' computed assurance so the two surfaces always agree.
      if (ns.TrustLadder) {
        const proofForLadder = this.opts.proof || { assurance: { id: overall } };
        this.ladder = new ns.TrustLadder(this.receiptEl, { proof: proofForLadder, compact: true, onRungClick: this.opts.onRungClick });
      } else {
        const badge = elt('span', 'cinema-narrative-assurance', 'Assurance: ' + (ASSURANCE_LABEL[overall] || overall));
        badge.dataset.assurance = overall;
        this.receiptEl.appendChild(badge);
      }
      this.receiptEl.appendChild(elt('span', 'cinema-narrative-receipt-note', this.events.length + ' steps — read top to bottom.'));
    }

    _renderFilters() {
      this.filtersEl.replaceChildren();
      const stages = [];
      for (const e of this.events) if (!stages.includes(e.stage)) stages.push(e.stage);
      const mk = (stage, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cinema-narrative-filter' + ((this.stageFilter === stage) ? ' active' : '');
        b.dataset.stage = stage == null ? 'all' : stage;
        b.textContent = label;
        b.addEventListener('click', () => { this.stageFilter = stage; this._renderFilters(); this._renderList(); });
        return b;
      };
      this.filtersEl.appendChild(mk(null, 'All'));
      for (const s of stages) this.filtersEl.appendChild(mk(s, STAGE_LABEL[s] || s));
    }

    _renderList() {
      this.listEl.replaceChildren();
      this._cards.clear();
      for (const e of this.events) {
        if (this.stageFilter && e.stage !== this.stageFilter) continue;
        const li = elt('li', 'cinema-narrative-card');
        li.dataset.seq = String(e.sequence);
        li.dataset.stage = e.stage;
        li.dataset.nodes = (e.graphNodeIds || []).join(',');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cinema-narrative-card-btn';
        btn.setAttribute('aria-label', (STAGE_LABEL[e.stage] || e.stage) + ': ' + e.headline);

        const topRow = elt('div', 'cinema-narrative-card-top');
        topRow.appendChild(elt('span', 'cinema-narrative-stage', (STAGE_ICON[e.stage] ? STAGE_ICON[e.stage] + ' ' : '') + (STAGE_LABEL[e.stage] || e.stage)));
        const a = elt('span', 'cinema-narrative-assurance', ASSURANCE_LABEL[e.assurance] || e.assurance);
        a.dataset.assurance = e.assurance;
        topRow.appendChild(a);
        const st = elt('span', 'cinema-narrative-status', e.status);
        st.dataset.status = e.status;
        topRow.appendChild(st);
        btn.appendChild(topRow);

        btn.appendChild(elt('span', 'cinema-narrative-headline', e.headline));
        btn.appendChild(elt('span', 'cinema-narrative-summary', e.summary));
        if (STAGE_PROVES[e.stage]) btn.appendChild(elt('span', 'cinema-narrative-proves', 'Proves: ' + STAGE_PROVES[e.stage]));

        btn.addEventListener('click', () => this._focusCard(e, true));
        li.appendChild(btn);

        if (this.showRaw) {
          const refs = elt('div', 'cinema-narrative-refs');
          refs.textContent = 'proof: ' + (e.proofRefs || []).join(', ') + ' · nodes: ' + (e.graphNodeIds || []).join(', ');
          li.appendChild(refs);
        }

        this.listEl.appendChild(li);
        this._cards.set(e.sequence, { li, btn, event: e });
      }
      this._applyPosition();
    }

    _focusCard(event, fromClick) {
      for (const { li } of this._cards.values()) li.classList.remove('focused');
      const entry = this._cards.get(event.sequence);
      if (entry) {
        entry.li.classList.add('focused');
        if (entry.li.scrollIntoView) entry.li.scrollIntoView({ block: 'nearest' });
      }
      if (fromClick && typeof this.opts.onCardFocus === 'function') {
        this.opts.onCardFocus(event.graphNodeIds || [], event);
      }
    }

    /** focusByNode highlights the card whose graph nodes include nodeId. */
    focusByNode(nodeId) {
      for (const entry of this._cards.values()) {
        if ((entry.event.graphNodeIds || []).indexOf(nodeId) >= 0) { this._focusCard(entry.event, false); return true; }
      }
      return false;
    }

    /** setPosition dims events after the replay head and marks the current one. */
    setPosition(seq) {
      this.currentSeq = seq;
      this._applyPosition();
    }

    _applyPosition() {
      let current = -1;
      for (const [s] of this._cards) if (s <= this.currentSeq && s > current) current = s;
      for (const [s, { li }] of this._cards) {
        li.classList.toggle('future', s > this.currentSeq);
        li.classList.toggle('current', s === current);
      }
    }

    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  function rank(id) { const i = ASSURANCE_ORDER.indexOf(id); return i < 0 ? 0 : i; }

  ns.NarrativePanel = NarrativePanel;
  if (typeof module !== 'undefined' && module.exports) module.exports = { NarrativePanel };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
