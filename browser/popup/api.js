/**
 * Infrix Wallet — popup-side governance API client.
 *
 * The popup is an extension page, so it may fetch the localhost host the
 * manifest grants directly — the same path the Cinema/Debug widgets already
 * use. Every governed read carries the disclosure trio
 * (X-Actor / X-Purpose / X-Workflow-Instance); the actor is the wallet's ADI.
 * The Gap 12 gate rejects requests missing any of the three with HTTP 400, so
 * the client refuses to issue a read without an actor.
 *
 * The v4 REST envelope is { data, governance, meta, error }. `get`/`post`
 * return the parsed envelope; callers read `.data` and `.governance`.
 *
 * Pure helpers (assurance grading, identicon) are exported for Node tests; the
 * fetch-backed client only runs in the extension page.
 */
(function (root) {
  'use strict';

  // ---- Assurance ladder (mirrors @infrix/cinema-core ASSURANCE) -------------
  // The wallet grades every governed action by the strongest proof its
  // evidence actually backs — never higher. This is the wallet's
  // differentiator: a cryptographically honest trust badge on each item.
  const ASSURANCE = {
    offline: { id: 'offline', label: 'Structural', rank: 0 },
    replay: { id: 'replay', label: 'Replay-verified', rank: 1 },
    l0: { id: 'l0', label: 'L0-anchored', rank: 2 },
    witness: { id: 'witness', label: 'Witness-quorum', rank: 3 },
  };

  /**
   * gradeAssurance maps an evidence bundle (and optional verify result) to the
   * highest assurance rung it cryptographically backs. Fail-closed: anything
   * unproven is "Structural" (offline). Never claims L0 without an anchor, nor
   * witness without witness data — same cardinal rule as the Cinema proof rail.
   */
  function gradeAssurance(evidence, verify) {
    const ev = evidence || {};
    const anchor = ev.anchor || ev.Anchor || (ev.data && (ev.data.anchor || ev.data.Anchor));
    const hasAnchor = !!(anchor && (anchor.txHash || anchor.TxHash));
    const witnessed = !!(ev.witnessed || ev.witnessQuorum || (verify && verify.witnessed));
    const replayed = !!(ev.replayVerified || (verify && (verify.verified || verify.replayVerified)));
    if (witnessed) return ASSURANCE.witness;
    if (hasAnchor) return ASSURANCE.l0;
    if (replayed) return ASSURANCE.replay;
    return ASSURANCE.offline;
  }

  // ---- Status semantics -----------------------------------------------------
  // Map an intent lifecycle status to a coarse visual state so the activity
  // feed and pending hero read at a glance.
  function statusKind(status) {
    const s = String(status || '').toLowerCase();
    if (/(fail|denied|revert|error|reject)/.test(s)) return 'failed';
    if (/(pending|await|propos|review|submitted|open)/.test(s)) return 'pending';
    if (/(complete|executed|approved|anchored|settled|verified|success|done)/.test(s)) return 'ok';
    return 'neutral';
  }

  // ---- Identicon ------------------------------------------------------------
  // Deterministic, dependency-free 5x5 symmetric identicon (GitHub-style) from
  // any string (the ADI). Zero-config visual identity: the same ADI always
  // renders the same glyph, so users recognize their account instantly.
  function hashString(s) {
    // FNV-1a 32-bit — stable across platforms, good enough for a glyph seed.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function identiconSvg(seed, size) {
    const px = size || 40;
    const s = String(seed || '');
    const h = hashString(s);
    // Hue from the hash → a stable accent within the cyan/teal family so it
    // sits in the product palette rather than clashing.
    const hue = 150 + (h % 90); // 150–240: teal→cyan→blue
    const fg = `hsl(${hue}, 64%, 60%)`;
    const cell = px / 5;
    let rects = '';
    // 5 columns but mirror columns 0..1 onto 4..3 for vertical symmetry.
    for (let col = 0; col < 3; col++) {
      for (let rowIdx = 0; rowIdx < 5; rowIdx++) {
        const bit = (h >> (col * 5 + rowIdx)) & 1;
        if (!bit) continue;
        const x1 = col * cell;
        const x2 = (4 - col) * cell;
        const y = rowIdx * cell;
        rects += `<rect x="${x1.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
        if (col !== 2) {
          rects += `<rect x="${x2.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" role="img" aria-label="account identicon">`
      + `<rect width="${px}" height="${px}" rx="8" fill="rgba(255,255,255,0.04)"/>`
      + `<g fill="${fg}">${rects}</g></svg>`;
  }

  // ---- REST client ----------------------------------------------------------
  class InfrixWalletApi {
    constructor(rpcUrl, actor) {
      this.base = InfrixWalletApi.originOf(rpcUrl);
      this.actor = actor || '';
    }

    static originOf(rpcUrl) {
      try { return new URL(rpcUrl).origin; } catch (_) { return 'http://localhost:8080'; }
    }

    isConnected() { return this.actor !== ''; }

    headers(purpose) {
      const p = purpose || 'wallet-read';
      return {
        'Content-Type': 'application/json',
        'X-Actor': this.actor,
        'X-Purpose': p,
        // Distinct per call so audit trails stay correlatable but separable.
        'X-Workflow-Instance': p + '-' + (this._seq = (this._seq || 0) + 1),
      };
    }

    async get(path, purpose) {
      if (!this.isConnected()) throw new Error('wallet not connected (no ADI)');
      const res = await fetch(this.base + path, { headers: this.headers(purpose) });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      return res.json();
    }

    async post(path, body, purpose) {
      if (!this.isConnected()) throw new Error('wallet not connected (no ADI)');
      const res = await fetch(this.base + path, {
        method: 'POST', headers: this.headers(purpose), body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      return res.json();
    }

    // Domain reads (all return the v4 envelope; callers read .data/.governance).
    networkStatus() { return this.get('/v4/network/status', 'wallet-network'); }
    listIntents(limit) { return this.get('/v4/intents?limit=' + (limit || 25), 'wallet-activity'); }
    pendingIntents() { return this.get('/v4/intents/pending', 'wallet-activity'); }
    intent(id) { return this.get('/v4/intents/' + encodeURIComponent(id), 'wallet-activity'); }
    intentEvidence(id) { return this.get('/v4/intents/' + encodeURIComponent(id) + '/evidence', 'wallet-evidence'); }
    intentBilling(id) { return this.get('/v4/intents/' + encodeURIComponent(id) + '/billing', 'wallet-billing'); }
    evidence(id) { return this.get('/v4/evidence/' + encodeURIComponent(id), 'wallet-evidence'); }
    evidenceVerify(id) { return this.get('/v4/evidence/' + encodeURIComponent(id) + '/verify', 'wallet-evidence'); }
    accountBalance(url) { return this.get('/v4/accounts/' + encodeURIComponent(url) + '/balance', 'wallet-balance'); }
    billingPreview(body) { return this.post('/v4/billing/preview', body, 'wallet-billing'); }
  }

  const api = {
    InfrixWalletApi,
    ASSURANCE,
    gradeAssurance,
    statusKind,
    identiconSvg,
    hashString,
  };

  if (typeof root !== 'undefined') root.InfrixWalletApi = InfrixWalletApi;
  if (typeof root !== 'undefined') root.InfrixWalletData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
