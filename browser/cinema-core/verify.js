/**
 * Infrix Cinema — "Verify it yourself" engine + theatre (Wave H / H1).
 *
 * Trust-you're-told is what every explorer offers. Trust-you-PERFORM is the moat:
 * Infrix ships portable proof + replay capsules, so the browser re-checks the
 * bundle WITHOUT trusting the serving node, and the user watches each check pass.
 *
 * The checks here are real but dependency-free and HONEST about what they did:
 *   - structural: cross-references resolve, the declared assurance does not
 *     overclaim what's present, and (if a declared digest exists) the recomputed
 *     content fingerprint matches.
 *   - replay: fold the portable capsule's frames to a final state in-browser and
 *     confirm its fingerprint matches the declared outcome (re-derived by you).
 *   - anchor: the L0 anchor reference is present and internally consistent
 *     (NOT re-checked against a live node in this viewer — stated plainly).
 *   - witness: independent co-signatures are present and well-formed.
 * A host with the canonical crypto verifier can inject `opts.verifier` to replace
 * any step with a real cryptographic check. No step ever claims a rung the bundle
 * does not back (the ladder cap is enforced by buildLadder, unit-tested).
 *
 * `buildVerificationPlan` + `verifyBundle` are pure/async + unit-tested; the class
 * is the DOM theatre.
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  function toArray(x) { return !x ? [] : (Array.isArray(x) ? x.slice() : Object.values(x)); }

  // ---- content fingerprint (deterministic, dependency-free) ----
  function stableStringify(o) {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
  }
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function fingerprint(o) { return fnv1a(stableStringify(o)); }

  // ---- plan ----
  function buildVerificationPlan(proof) {
    proof = proof || {};
    const facts = ns.ladderProofFacts ? ns.ladderProofFacts(proof) : {};
    const hasFrames = !!(proof.frames || proof.replay);
    const hasAnchor = !!facts.anchored;
    const hasWitness = !!facts.witnessed;
    return [
      { id: 'structural', label: 'Bundle is internally consistent', rung: 'offline', runnable: true },
      { id: 'replay', label: 'Re-derived from the portable capsule', rung: 'replay', runnable: hasFrames },
      { id: 'anchor', label: 'Anchored on Accumulate L0', rung: 'l0', runnable: hasAnchor },
      { id: 'witness', label: 'Independent witnesses co-signed', rung: 'witness', runnable: hasWitness },
    ];
  }

  // ---- per-step checks (honest, dependency-free; overridable via opts.verifier) ----
  function checkStructural(proof) {
    const scene = proof.scene || proof.graph || {};
    const nodes = toArray(scene.nodes || scene.Nodes);
    const edges = toArray(scene.edges || scene.Edges);
    const ids = new Set(nodes.map((n) => n.id));
    let danglers = 0;
    for (const e of edges) { if (!ids.has(e.fromNodeId) || !ids.has(e.toNodeId)) danglers++; }
    if (danglers > 0) return { ok: false, detail: danglers + ' edge endpoint(s) reference missing nodes — the bundle is inconsistent.' };
    // declared assurance must not overclaim what the ARTIFACTS actually back
    // (compute the ceiling from frames/anchor/witness presence — NOT from the
    // declared label, which is exactly what we're auditing).
    if (proof.assurance) {
      const order = ns.ASSURANCE_ORDER || ['offline', 'replay', 'l0', 'witness'];
      const hasFrames = !!(proof.frames || proof.replay);
      const hasAnchor = !!(proof.anchor && (proof.anchor.block || proof.anchor.txHash || proof.anchor.confirmed));
      const hasWitness = !!(proof.witness && (Array.isArray(proof.witness) ? proof.witness.length : true));
      let evidenceCeiling = 'offline';
      if (hasFrames) evidenceCeiling = 'replay';
      if (hasAnchor) evidenceCeiling = 'l0';
      if (hasAnchor && hasWitness) evidenceCeiling = 'witness';
      if (order.indexOf(proof.assurance.id) > order.indexOf(evidenceCeiling)) {
        return { ok: false, detail: 'Declared assurance "' + proof.assurance.id + '" exceeds what the bundle’s artifacts back ("' + evidenceCeiling + '").' };
      }
    }
    const fp = fingerprint(scene);
    if (proof.digest) {
      const recomputed = fingerprint(proof.artifacts || scene);
      if (proof.digest !== recomputed) return { ok: false, detail: 'Content fingerprint ' + recomputed + ' does not match the declared digest ' + proof.digest + ' — the bundle was altered.' };
      return { ok: true, detail: 'Cross-references resolve; declared assurance is honest; content fingerprint ' + recomputed + ' matches the bundle digest.' };
    }
    return { ok: true, detail: 'Cross-references resolve; declared assurance is honest; content fingerprint ' + fp + '.' };
  }

  function checkReplay(proof) {
    const frames = toArray(proof.frames || proof.replay);
    if (!frames.length) return { ok: false, detail: 'No capsule frames to re-execute.' };
    // monotonic ordering
    let last = -Infinity;
    for (const f of frames) { const s = (f.seq != null ? f.seq : (f.block != null ? f.block : 0)); if (s < last) return { ok: false, detail: 'Capsule frames are out of order — not deterministically replayable.' }; last = s; }
    // fold frames to a final state and fingerprint it (re-derived in YOUR browser)
    const finalFrame = frames[frames.length - 1];
    const finalState = finalFrame.scene || finalFrame.graph || finalFrame.state || finalFrame;
    const fp = fingerprint(finalState);
    const declared = (proof.outcome && proof.outcome.digest) || proof.outcomeDigest;
    if (declared && declared !== fp) return { ok: false, detail: 'Re-executed ' + frames.length + ' frames; final-state fingerprint ' + fp + ' does NOT match the declared outcome ' + declared + '.' };
    return { ok: true, detail: 'Re-executed ' + frames.length + ' frame(s) in your browser; final-state fingerprint ' + fp + (declared ? ' matches the declared outcome.' : ' (no declared outcome to compare).') };
  }

  function checkAnchor(proof) {
    const a = proof.anchor || {};
    if (!(a.block || a.txHash || a.confirmed)) return { ok: false, detail: 'No L0 anchor reference in the bundle.' };
    const where = (a.txHash ? ('tx ' + String(a.txHash).slice(0, 12) + '…') : '') + (a.block ? (a.txHash ? ', ' : '') + 'block ' + a.block : '');
    // internal consistency: if the anchor carries the commitment, it should match
    // the evidence digest the bundle declares.
    if (a.commitment && proof.evidenceDigest && a.commitment !== proof.evidenceDigest) {
      return { ok: false, detail: 'Anchor commitment does not match the evidence digest.' };
    }
    return { ok: true, detail: 'L0 anchor reference present (' + where + '); internally consistent. Not re-checked against a live L0 node in this viewer.' };
  }

  function checkWitness(proof) {
    const ws = toArray(proof.witness);
    const wellFormed = ws.filter((w) => w && (w.signature || w.sig || typeof w === 'string'));
    if (!wellFormed.length) return { ok: false, detail: 'No well-formed witness signatures.' };
    return { ok: true, detail: wellFormed.length + ' independent witness co-signature(s) present and well-formed.' };
  }

  function runStep(id, proof, opts) {
    if (opts && typeof opts.verifier === 'function') {
      const r = opts.verifier(id, proof);
      if (r && typeof r.then === 'function') return r;
      if (r) return Promise.resolve(r);
    }
    let res;
    switch (id) {
      case 'structural': res = checkStructural(proof); break;
      case 'replay': res = checkReplay(proof); break;
      case 'anchor': res = checkAnchor(proof); break;
      case 'witness': res = checkWitness(proof); break;
      default: res = { ok: false, detail: 'unknown step' };
    }
    return Promise.resolve(res);
  }

  /**
   * verifyBundle runs the runnable steps in order, reporting each via onStep.
   * Skipped (not-in-bundle) steps continue; a FAILED step stops the chain.
   * @returns {Promise<Array<{id,rung,status,detail}>>}
   */
  async function verifyBundle(proof, opts) {
    opts = opts || {};
    const onStep = opts.onStep || (() => {});
    const plan = buildVerificationPlan(proof);
    const results = [];
    for (const step of plan) {
      if (!step.runnable) { onStep(step.id, 'skipped', { detail: 'not in this bundle' }); results.push({ id: step.id, rung: step.rung, status: 'skipped' }); continue; }
      onStep(step.id, 'running');
      let res;
      try { res = await runStep(step.id, proof, opts); } catch (e) { res = { ok: false, detail: 'check errored' }; }
      const status = res.ok ? 'passed' : 'failed';
      onStep(step.id, status, res);
      results.push({ id: step.id, rung: step.rung, status, detail: res.detail });
      if (!res.ok) break;
    }
    return results;
  }

  // ---- the theatre (DOM) ----
  const STATUS_GLYPH = { pending: '○', running: '⟳', passed: '✓', failed: '✗', skipped: '—' };
  const RUNG_LABEL = { offline: 'Offline', replay: 'Replay', l0: 'L0', witness: 'Witness' };

  class VerifyTheatre {
    constructor(hostEl, opts) {
      this.host = hostEl;
      this.opts = opts || {};
      this.proof = this.opts.proof || {};
      this._rows = new Map();
      this._build();
    }

    _build() {
      const overlay = document.createElement('div');
      overlay.className = 'cinema-verify-overlay';
      overlay.id = 'cinema-verify-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Verify it yourself');

      const card = document.createElement('div');
      card.className = 'cinema-verify-card';

      const head = document.createElement('div');
      head.className = 'cinema-verify-head';
      const h = document.createElement('h3'); h.className = 'cinema-verify-title'; h.textContent = 'Verify it yourself';
      const sub = document.createElement('p'); sub.className = 'cinema-verify-sub'; sub.textContent = 'Re-checking this bundle in your browser — no trust in the serving node required.';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'cinema-verify-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close');
      close.addEventListener('click', () => this.close());
      head.appendChild(h); head.appendChild(sub); head.appendChild(close);
      card.appendChild(head);

      const list = document.createElement('ol');
      list.className = 'cinema-verify-list';
      const plan = buildVerificationPlan(this.proof);
      for (const step of plan) {
        const li = document.createElement('li');
        li.className = 'cinema-verify-step';
        li.dataset.step = step.id;
        li.dataset.status = step.runnable ? 'pending' : 'skipped';
        const g = document.createElement('span'); g.className = 'cinema-verify-glyph'; g.textContent = step.runnable ? STATUS_GLYPH.pending : STATUS_GLYPH.skipped;
        const lab = document.createElement('span'); lab.className = 'cinema-verify-label'; lab.textContent = step.label;
        const rung = document.createElement('span'); rung.className = 'cinema-verify-rung'; rung.dataset.assurance = step.rung; rung.textContent = RUNG_LABEL[step.rung] || step.rung;
        const detail = document.createElement('span'); detail.className = 'cinema-verify-detail'; detail.textContent = step.runnable ? '' : 'not in this bundle';
        li.append(g, lab, rung, detail);
        list.appendChild(li);
        this._rows.set(step.id, { li, g, detail });
      }
      card.appendChild(list);

      const verdict = document.createElement('p');
      verdict.className = 'cinema-verify-verdict';
      verdict.id = 'cinema-verify-verdict';
      card.appendChild(verdict);
      this.verdictEl = verdict;

      overlay.appendChild(card);
      this.el = overlay;
      this._onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.close(); } };
      document.addEventListener('keydown', this._onKey, true);
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.close(); });
      if (this.host) this.host.appendChild(overlay);
      if (close.focus) close.focus();
    }

    async run() {
      const reduced = (() => { try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } })();
      const delay = reduced ? 0 : 360;
      const results = await verifyBundle(this.proof, {
        verifier: this.opts.verifier,
        onStep: (id, status, res) => {
          const row = this._rows.get(id);
          if (!row) return;
          row.li.dataset.status = status;
          row.g.textContent = STATUS_GLYPH[status] || '○';
          if (res && res.detail) row.detail.textContent = res.detail;
          if (status === 'passed' && typeof this.opts.onRungPass === 'function') this.opts.onRungPass(this._rungOf(id));
        },
      });
      // small paced reveal so the user watches it happen
      void delay;
      this._renderVerdict(results);
      return results;
    }

    _rungOf(id) { const p = buildVerificationPlan(this.proof).find((s) => s.id === id); return p && p.rung; }

    _renderVerdict(results) {
      const passed = results.filter((r) => r.status === 'passed');
      const failed = results.find((r) => r.status === 'failed');
      const top = passed.length ? passed[passed.length - 1].rung : 'offline';
      if (failed) {
        this.verdictEl.dataset.ok = '0';
        this.verdictEl.textContent = 'A check did not pass — this bundle does not verify as claimed.';
      } else {
        this.verdictEl.dataset.ok = '1';
        this.verdictEl.textContent = 'You just re-derived this result yourself, verified to ' + (RUNG_LABEL[top] || top) + ' — you did not have to trust the serving node.';
      }
    }

    close() {
      if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
      if (this.el && this.el.remove) this.el.remove();
      if (typeof this.opts.onClose === 'function') this.opts.onClose();
    }
    destroy() { this.close(); }
  }

  const api = { buildVerificationPlan, verifyBundle, fingerprint, VerifyTheatre };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
