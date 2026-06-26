/**
 * Infrix Cinema — agent-stop ribbon (Tier C / C3).
 *
 * Turns agent safety from an invisible guardrail into a watchable trust moment.
 * When the scene is an Agent Action receipt (scene.meta.source === 'agent', built
 * by AgentCinemaDataSource), this renders a horizontal stepper — request →
 * authorization → execution → proof — and, when the safety gate refused, an
 * emphatic BARRIER showing exactly which rule stopped the agent and why.
 *
 * `agentRibbonModel(scene)` is pure + unit-tested; the class is the DOM shell.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  function nodesOf(graph) {
    if (!graph) return [];
    const n = graph.nodes || graph.Nodes;
    return !n ? [] : (Array.isArray(n) ? n.slice() : Object.values(n));
  }

  const TONE_BY_ID = {
    'agent-request': 'info', approval: 'ok', execution: 'ok', proof: 'ok', prevented: 'fail',
  };
  function toneFor(node) {
    if (TONE_BY_ID[node.id]) return TONE_BY_ID[node.id];
    const lab = String(node.label || '').toLowerCase();
    if (/not authorized|required|denied|prevent|refus/.test(lab)) return 'warn';
    return 'info';
  }

  /**
   * agentRibbonModel extracts an ordered stepper + refusal from an agent scene.
   * @returns {{isAgent, ok, steps:[{id,label,tone}], refusal:{code,label}|null, action}}
   */
  function agentRibbonModel(scene) {
    const meta = (scene && scene.meta) || {};
    if (!scene || meta.source !== 'agent') return { isAgent: false, ok: false, steps: [], refusal: null, action: '' };
    const nodes = nodesOf(scene).slice().sort((a, b) => ((a.position && a.position.x) || 0) - ((b.position && b.position.x) || 0));
    const steps = nodes.map((n) => ({ id: n.id, label: n.label || n.id, tone: toneFor(n) }));
    const prevented = nodes.find((n) => n.id === 'prevented');
    let refusal = null;
    if (prevented) {
      const m = String(prevented.label || '').match(/Prevented:\s*(\S+)/);
      refusal = { code: m ? m[1] : 'AGENT_REFUSED', label: prevented.label || 'Prevented' };
    }
    return { isAgent: true, ok: !!meta.ok, steps, refusal, action: meta.action || '' };
  }

  function plainRefusal(action, code) {
    const a = action ? `“${action}”` : 'the requested action';
    return `The agent tried to run ${a}. The policy stopped it (${code}). Nothing executed.`;
  }

  class AgentRibbon {
    constructor(hostEl, opts) {
      this.host = hostEl;
      this.opts = opts || {};
      const el = document.createElement('div');
      el.className = 'cinema-agent-ribbon hidden';
      el.id = 'cinema-agent-ribbon';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', 'Agent action receipt');
      this.el = el;
      if (hostEl) hostEl.appendChild(el);
    }

    setScene(scene) {
      const model = agentRibbonModel(scene);
      if (!model.isAgent) { this.hide(); return; }
      this.el.classList.remove('hidden');
      this.el.replaceChildren();

      const head = document.createElement('div');
      head.className = 'cinema-agent-head';
      head.textContent = model.ok ? 'Agent action — authorized & proven' : 'Agent action — stopped at a safety gate';
      head.dataset.ok = model.ok ? '1' : '0';
      this.el.appendChild(head);

      const row = document.createElement('div');
      row.className = 'cinema-agent-steps';
      model.steps.forEach((s, i) => {
        if (i > 0) { const c = document.createElement('span'); c.className = 'cinema-agent-conn'; c.textContent = '→'; row.appendChild(c); }
        const step = document.createElement('div');
        step.className = 'cinema-agent-step';
        step.dataset.tone = s.tone;
        if (s.id === 'prevented') step.classList.add('barrier');
        step.textContent = s.label;
        row.appendChild(step);
      });
      this.el.appendChild(row);

      if (model.refusal) {
        const why = document.createElement('p');
        why.className = 'cinema-agent-why';
        why.textContent = plainRefusal(model.action, model.refusal.code);
        this.el.appendChild(why);
      }

      const actions = document.createElement('div');
      actions.className = 'cinema-agent-actions';
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'cinema-btn';
      share.textContent = 'Export receipt';
      share.addEventListener('click', () => { if (typeof this.opts.onExport === 'function') this.opts.onExport(); });
      actions.appendChild(share);
      this.el.appendChild(actions);
    }

    hide() { this.el.classList.add('hidden'); this.el.replaceChildren(); }
    destroy() { if (this.el && this.el.remove) this.el.remove(); }
  }

  const api = { AgentRibbon, agentRibbonModel };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
