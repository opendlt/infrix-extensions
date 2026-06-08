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
      const stats = this.renderer ? this.renderer.getNodeStats(node.id) : { activity: 0, inbound: 0, outbound: 0, totalGas: 0 };
      const rows = [];
      rows.push(section('Identity', [
        ['Type', kindLabel(node.kind)],
        ['URL', node.url || '—'],
        ['Label', node.label || '—'],
      ]));
      if (node.redacted) {
        rows.push(section('Disclosure', [
          ['Visibility', 'private (redacted)'],
          ['Value', '🔒 ' + (node.label || '[encrypted]')],
        ]));
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
  }

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
  function kindLabel(kind) { return String(kind || 'node').replace(/_/g, ' '); }

  ns.DetailsPanel = DetailsPanel;
  if (typeof module !== 'undefined' && module.exports) module.exports = { DetailsPanel };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
