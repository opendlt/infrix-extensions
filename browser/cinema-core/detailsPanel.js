/**
 * Infrix Cinema — details panel.
 *
 * Renders node / edge detail into a panel element. Disclosure-aware: a node
 * marked `redacted` shows the locked placeholder and never its hidden value,
 * balance, or magnitude. Moved into the core from tools/cinema-viewer.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  class DetailsPanel {
    constructor(panelEl, contentEl, closeBtn) {
      this.panelEl = panelEl;
      this.contentEl = contentEl;
      this.renderer = null;
      if (closeBtn) closeBtn.addEventListener('click', () => this.hide());
    }
    show() { if (this.panelEl) this.panelEl.classList.remove('hidden'); }
    hide() { if (this.panelEl) this.panelEl.classList.add('hidden'); }

    showNode(node) {
      if (!node) return;
      this._lastNode = node;
      const stats = this.renderer ? this.renderer.getNodeStats(node.id) : { activity: 0, inbound: 0, outbound: 0, totalGas: 0 };
      const rows = [];
      // Trace / Why? action (H2) — one click lights the causal chain.
      if (typeof this.onTrace === 'function') {
        rows.push(traceAction(() => this.onTrace(node.id)));
      }
      rows.push(section('Identity', [
        ['Type', kindLabel(node.kind)],
        ['URL', node.url || '—'],
        ['Label', node.label || '—'],
      ]));
      // Per-node assurance chip (C1) — only when a governing event backs it.
      const asr = (typeof this.assuranceProvider === 'function') ? this.assuranceProvider(node.id) : null;
      if (asr && asr.id) {
        const sec = section('Assurance', [['Backed to', asr.label || asr.id]]);
        const chip = sec.querySelector('.cinema-detail-val');
        if (chip) { chip.classList.add('cinema-assurance-chip'); chip.dataset.assurance = asr.id; }
        rows.push(sec);
      }
      if (node.redacted) {
        // Disclosure as a first-class object (C2): say what's PROVABLE without
        // leaking the value, and surface any grant that could reveal it.
        const drows = [['Visibility', 'private — provably hidden']];
        if (node.grantId) drows.push(['Disclosable via', node.grantId]);
        rows.push(section('Disclosure', drows));
        rows.push(noteEl('This redaction did not change the proven outcome — Cinema shows that the field participated, never its value or magnitude.'));
      } else {
        if (stats.activity > 0) rows.push(section('Activity', [
          ['Inbound calls', String(stats.inbound)],
          ['Outbound calls', String(stats.outbound)],
          ['Total gas', stats.totalGas.toLocaleString()],
        ]));
        const stateRows = [];
        if (node.balance != null) stateRows.push(['Balance', String(node.balance)]);
        if (node.encryptedFields) stateRows.push(['Encrypted fields', String(node.encryptedFields)]);
        if (node.breakerState) stateRows.push(['Circuit breaker', node.breakerState]);
        if (node.quarantined) stateRows.push(['Quarantined', 'yes']);
        if (node.anomalyScore) stateRows.push(['Anomaly score', String(node.anomalyScore)]);
        if (stateRows.length) rows.push(section('State', stateRows));
      }
      rows.push(section('Timeline', [
        ['Created at event', node.createdAtEvent != null ? String(node.createdAtEvent) : '—'],
        ['Last updated', node.lastUpdated != null ? String(node.lastUpdated) : '—'],
      ]));
      this.render('Node', rows);
    }

    showTraffic(traffic) {
      if (!traffic) return;
      this.render('Edge', [section('Connection', [
        ['From', traffic.fromId || '—'],
        ['To', traffic.toId || '—'],
        ['Label', traffic.label || '—'],
      ]), section('Traffic', [
        ['Call count', String(traffic.count || 0)],
        ['Total gas', (traffic.totalGas || 0).toLocaleString()],
        ['Animated', traffic.animated ? 'yes' : 'no'],
      ])]);
    }
    showEdge(edge) { this.showTraffic({ fromId: edge.fromNodeId, toId: edge.toNodeId, label: edge.label, count: 1, totalGas: edge.gasCost || 0, animated: edge.animated }); }

    render(title, sections) {
      if (!this.contentEl) return;
      this.contentEl.replaceChildren(...(Array.isArray(sections) ? sections : [sections]));
      this.show();
    }

    /** appendProvenance adds the lit causal chain (H2) under the current node. */
    appendProvenance(hops) {
      if (!this.contentEl) return;
      const wrap = document.createElement('div');
      wrap.className = 'cinema-detail-section';
      const h = document.createElement('h4'); h.textContent = 'Causal chain'; wrap.appendChild(h);
      if (!hops || !hops.length) {
        wrap.appendChild(noteEl2('No causal links from this node.'));
      } else {
        for (const hop of hops) {
          const row = document.createElement('div');
          row.className = 'cinema-detail-row cinema-provenance-hop';
          const k = document.createElement('span'); k.className = 'cinema-detail-key';
          k.textContent = kindLabel(hop.edgeKind) + ':';
          const v = document.createElement('span'); v.className = 'cinema-detail-val';
          v.textContent = hop.fromId + ' → ' + hop.toId + (hop.proofRef ? ' · ' + hop.proofRef : '');
          row.appendChild(k); row.appendChild(v);
          wrap.appendChild(row);
        }
      }
      this.contentEl.appendChild(wrap);
      this.show();
    }
  }

  function traceAction(onClick) {
    const wrap = document.createElement('div');
    wrap.className = 'cinema-detail-actions';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cinema-trace-btn'; b.textContent = '🔍 Trace / Why?';
    b.setAttribute('aria-label', 'Trace the causal chain that produced this');
    b.addEventListener('click', onClick);
    wrap.appendChild(b);
    return wrap;
  }
  function noteEl2(text) { const p = document.createElement('p'); p.className = 'cinema-detail-note'; p.textContent = text; return p; }

  function section(title, pairs) {
    const wrap = document.createElement('div');
    wrap.className = 'cinema-detail-section';
    const h = document.createElement('h4');
    h.textContent = title;
    wrap.appendChild(h);
    for (const [k, v] of pairs) {
      const row = document.createElement('div');
      row.className = 'cinema-detail-row';
      const ke = document.createElement('span'); ke.className = 'cinema-detail-key'; ke.textContent = k;
      const ve = document.createElement('span'); ve.className = 'cinema-detail-val'; ve.textContent = v;
      row.appendChild(ke); row.appendChild(ve);
      wrap.appendChild(row);
    }
    return wrap;
  }
  function noteEl(text) {
    const wrap = document.createElement('div');
    wrap.className = 'cinema-detail-section';
    const p = document.createElement('p');
    p.className = 'cinema-detail-note';
    p.textContent = text;
    wrap.appendChild(p);
    return wrap;
  }
  function kindLabel(kind) { return String(kind || 'node').replace(/_/g, ' '); }

  ns.DetailsPanel = DetailsPanel;
  if (typeof module !== 'undefined' && module.exports) module.exports = { DetailsPanel };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
