/**
 * Infrix Wallet — Plan Approval Sheet (P3 #20, expanded).
 *
 * The see-before-you-sign hero. Pre-closure the popup signed plans blind; the
 * first closure added the rich plan-detail view (steps + sim hash + trust
 * profiles). This sheet goes further — it is the moment that differentiates
 * Infrix from a balance-and-send wallet:
 *
 *   - an embedded, animated Cinema scene built from the plan's REAL steps (the
 *     canonical renderer — the same one Nexus uses — not a bespoke drawing),
 *     with an Expand affordance into the full console;
 *   - a plain-language "What this does" narrative so a non-expert understands
 *     the consequence without reading bytecode;
 *   - a best-effort cost quote (governed billing preview) before committing;
 *   - the simulation-bound plan hash, implicated trust profiles, and an honest
 *     assurance note (pre-sign evidence is structural, not yet anchored);
 *   - the raw technical step list behind a progressive-disclosure toggle.
 *
 * Reads go through the wallet's background RPC proxy (intent.plan / intent.steps
 * / approval.get); the REST billing preview goes through the injected api
 * client. Signing (wallet.approveRequest) MUST go through runtimeSend — it is an
 * extension-internal control message, never a devnet JSON-RPC method.
 */

(function () {
  'use strict';

  let viewSeq = 0;

  class PlanApprovalView {
    constructor(rpcSendFn, runtimeSendFn, apiClient) {
      // rpcSendFn(method, params) → Promise<result>: proxies governed reads
      // (intent.plan, intent.steps, approval.get) through the background to the
      // devnet JSON-RPC endpoint.
      this.rpc = rpcSendFn;
      // runtimeSendFn(message) → Promise<result>: direct chrome.runtime path for
      // extension-internal control messages (wallet.approveRequest). These MUST
      // NOT route through the JSON-RPC proxy.
      this.runtimeSend = runtimeSendFn;
      // apiClient: popup-side InfrixWalletApi for REST reads (billing preview).
      // Optional — the sheet degrades gracefully without it.
      this.api = apiClient || null;
      this._cinema = null;
      this._uid = 'plan-cinema-' + (++viewSeq);
    }

    async render(container, request) {
      container.innerHTML = this.renderSkeleton(request);
      const detail = await this.fetchPlanDetail(request);
      container.innerHTML = this.renderFull(request, detail);

      // Mount the embedded Cinema scene from the plan's real steps, then load
      // the best-effort cost quote. Both are non-blocking enrichments.
      this.mountScene(container, detail);
      this.loadCost(container, detail);
      this.loadSignBytes(container, detail);
      this.renderLockState(container);

      const approveBtn = container.querySelector('.plan-approve-btn');
      const rejectBtn = container.querySelector('.plan-reject-btn');
      const expandBtn = container.querySelector('.plan-cinema-expand');
      if (expandBtn) {
        expandBtn.addEventListener('click', () => {
          if (typeof window.openWalletConsole === 'function') window.openWalletConsole(detail.intentId);
        });
      }
      if (approveBtn) {
        approveBtn.addEventListener('click', async () => {
          if (typeof window.clearWalletError === 'function') window.clearWalletError();
          // Gate on the popup's unlock model; reveals the unlock bar if locked.
          if (typeof window.walletEnsureUnlocked === 'function' && !window.walletEnsureUnlocked()) return;
          try {
            await this.signAndApprove(request, detail);
          } catch (e) {
            // A session evicted mid-sign surfaces as a WALLET_LOCKED code —
            // prompt unlock instead of a generic error.
            if (e && e.code === 'WALLET_LOCKED' && typeof window.walletHandleLocked === 'function') {
              window.walletHandleLocked({ code: 'WALLET_LOCKED' });
            } else if (typeof window.showWalletError === 'function') {
              window.showWalletError(e && e.message ? e.message : String(e));
            }
          }
        });
      }
      if (rejectBtn) rejectBtn.addEventListener('click', () => window.rejectRequest(request.id));
    }

    async fetchPlanDetail(request) {
      const detail = {
        intentId: request.params && request.params.intentId,
        planId: '',
        planHash: '',
        stepCount: 0,
        totalGasEstimate: 0,
        approvalCountRequired: 0,
        approvalCountCollected: 0,
        steps: [],
        trustProfiles: [],
        errors: [],
      };

      if (request.params && request.params.planHash) detail.planHash = request.params.planHash;
      if (request.params && request.params.planId) detail.planId = request.params.planId;

      if (detail.intentId) {
        try {
          const plan = await this.rpc('intent.plan', { intentId: detail.intentId });
          if (plan && plan.fields) {
            detail.planHash = detail.planHash || plan.fields.PlanHash || '';
            detail.stepCount = Number(plan.fields.StepCount || 0);
            detail.totalGasEstimate = Number(plan.fields.TotalGasEstimate || 0);
            detail.approvalCountRequired = Number(plan.fields.ApprovalCount || 0);
          }
          if (plan && plan.id) detail.planId = detail.planId || plan.id;
        } catch (e) {
          detail.errors.push('intent.plan: ' + (e.message || e));
        }
      }

      if (detail.intentId) {
        try {
          const stepsResult = await this.rpc('intent.steps', { intentId: detail.intentId });
          const list = (stepsResult && stepsResult.steps) || [];
          if (stepsResult && stepsResult.planId && !detail.planId) detail.planId = stepsResult.planId;
          for (const step of list) {
            const fields = step.fields || {};
            const profile = fields.TrustProfileID || '';
            detail.steps.push({
              index: Number(fields.StepIndex || 0),
              kind: fields.StepKind || '',
              name: fields.StepName || '',
              trustProfileId: profile,
              state: step.state || '',
            });
            if (profile && !detail.trustProfiles.includes(profile)) detail.trustProfiles.push(profile);
          }
          detail.steps.sort((a, b) => a.index - b.index);
        } catch (e) {
          detail.errors.push('intent.steps: ' + (e.message || e));
        }
      }

      const approvalId = request.params && (request.params.approvalId || request.params.id);
      if (approvalId) {
        try {
          const ap = await this.rpc('approval.get', { approvalId });
          if (ap && ap.fields) {
            detail.approvalCountRequired = detail.approvalCountRequired || Number(ap.fields.RequiredApprovals || 0);
            detail.approvalCountCollected = Number(ap.fields.CollectedApprovals || 0);
          }
        } catch (e) {
          detail.errors.push('approval.get: ' + (e.message || e));
        }
      }
      return detail;
    }

    renderSkeleton(request) {
      return [
        '<div class="plan-card">',
          '<div class="plan-header">',
            '<div class="plan-title">Plan Approval</div>',
            '<div class="plan-origin">' + this.esc(request.origin || 'Unknown origin') + '</div>',
          '</div>',
          '<div class="plan-loading">Loading plan detail…</div>',
        '</div>',
      ].join('');
    }

    renderFull(request, detail) {
      const stepCount = detail.stepCount || detail.steps.length;

      const narrative = detail.steps.length === 0
        ? '<li><span class="pn-n">•</span><span>' + (detail.intentId ? 'No steps to show.' : 'No intentId on this request.') + '</span></li>'
        : detail.steps.map((s, i) =>
            '<li><span class="pn-n">' + (i + 1) + '</span><span>' + this.esc(this.describeStep(s)) + '</span></li>').join('');

      const trustList = detail.trustProfiles.length === 0
        ? '<span class="plan-muted">none declared</span>'
        : detail.trustProfiles.map((p) => '<span class="plan-trust-pill">' + this.esc(p) + '</span>').join(' ');

      const reqLabel = detail.approvalCountRequired || '?';
      const collected = detail.approvalCountCollected || 0;

      const stepRows = detail.steps.length === 0
        ? '<div class="plan-empty">no steps loaded</div>'
        : detail.steps.map((s, i) => this.renderStep(s, i + 1)).join('');

      const errors = detail.errors.length === 0 ? '' :
        '<div class="plan-errors">load errors: ' + detail.errors.map((e) => this.esc(e)).join(' · ') + '</div>';

      return [
        '<div class="plan-card">',
          '<div class="plan-header">',
            '<div class="plan-title">Approve this plan’s ' + stepCount + ' step' + (stepCount === 1 ? '' : 's') + '</div>',
            '<div class="plan-origin">from ' + this.esc(request.origin || 'unknown') + '</div>',
          '</div>',

          // Embedded Cinema scene (the consequence movie).
          '<div class="plan-cinema-bar"><span>Preview</span>',
            '<button class="plan-cinema-expand" type="button">⌬ Expand</button></div>',
          '<div class="plan-cinema" id="' + this._uid + '"></div>',

          // Plain-language consequence.
          '<div class="plan-lead">Signing commits you to the plan hash below — these exact steps, as simulated:</div>',
          '<ul class="plan-narrative">' + narrative + '</ul>',

          '<div class="plan-row">',
            '<div class="plan-label">Plan hash</div>',
            '<div class="plan-value plan-mono plan-hash">' + this.esc(detail.planHash || '—') + '</div>',
          '</div>',
          '<div class="plan-row">',
            '<div class="plan-label">Approvals</div>',
            '<div class="plan-value">' + collected + ' of ' + reqLabel + ' collected</div>',
          '</div>',
          '<div class="plan-row">',
            '<div class="plan-label">Est. cost</div>',
            '<div class="plan-value plan-cost">calculating…</div>',
          '</div>',
          '<div class="plan-row">',
            '<div class="plan-label">Trust profiles</div>',
            '<div class="plan-value">' + trustList + '</div>',
          '</div>',

          // Raw technical steps behind progressive disclosure.
          '<details class="plan-tech"><summary>Technical steps (' + detail.steps.length + ')</summary>',
            '<div class="plan-steps">' + stepRows + '</div>',
          '</details>',

          '<div class="plan-disclosure-note">This preview is simulation-bound (structural) — not yet L0-anchored. Evidence is anchored after execution; you can replay it from Activity.</div>',

          // WB-10: the exact bytes the user cryptographically commits to.
          '<details class="plan-tech plan-signbytes"><summary>What you’re signing</summary>',
            '<div class="plan-row"><div class="plan-label">Payload</div><div class="plan-value plan-mono" id="' + this._uid + '-payload">…</div></div>',
            '<div class="plan-row"><div class="plan-label">SHA-256</div><div class="plan-value plan-mono plan-hash" id="' + this._uid + '-payloadhash">…</div></div>',
            '<div class="plan-disclosure-note">A hardware device would display this SHA-256 — they must match.</div>',
          '</details>',

          errors,

          '<div class="plan-lockstate" id="' + this._uid + '-lock"></div>',
          '<div class="plan-actions">',
            '<button class="btn btn-danger plan-reject-btn">Reject</button>',
            '<button class="btn btn-primary plan-approve-btn">Sign &amp; approve</button>',
          '</div>',
        '</div>',
      ].join('');
    }

    renderStep(step, ordinal) {
      const profile = step.trustProfileId
        ? '<span class="plan-trust-inline">' + this.esc(step.trustProfileId) + '</span>'
        : '<span class="plan-muted">no trust profile</span>';
      return [
        '<div class="plan-step">',
          '<div class="plan-step-num">' + ordinal + '</div>',
          '<div class="plan-step-body">',
            '<div class="plan-step-kind">' + this.esc(step.kind || 'unknown') + '</div>',
            '<div class="plan-step-meta">', this.esc(step.name || ''), ' · ', profile, '</div>',
          '</div>',
        '</div>',
      ].join('');
    }

    // describeStep turns a StepKind/StepName into a plain-language line.
    describeStep(step) {
      const kind = this.humanize(step.kind || 'step');
      return step.name ? (kind + ' — ' + step.name) : kind;
    }

    humanize(s) {
      return String(s).replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // buildPlanScene constructs a SceneGraph (renderer-native shape) from the
    // plan's real steps: an intent node followed by a left-to-right chain of
    // step nodes with animated flow edges. This drives the canonical Cinema
    // renderer — the same code Nexus uses — so the embed is real, not a mock.
    buildPlanScene(detail) {
      const nodes = [];
      const edges = [];
      const y = 95;
      const gap = 140;
      nodes.push({ id: 'intent', label: 'Intent', kind: 'intent', shape: 'circle', size: 15, position: { x: 70, y }, color: { r: 92, g: 212, b: 228, a: 255 } });
      let prev = 'intent';
      detail.steps.forEach((s, i) => {
        const id = 'step-' + i;
        nodes.push({
          id,
          label: this.humanize(s.kind || ('step ' + (i + 1))),
          kind: 'plan_step',
          shape: 'rectangle',
          size: 13,
          position: { x: 70 + gap * (i + 1), y },
          color: this.stepColor(s),
        });
        edges.push({ fromNodeId: prev, toNodeId: id, label: s.name || '', animated: true });
        prev = id;
      });
      return { nodes, edges };
    }

    stepColor(step) {
      const st = String(step.state || '').toLowerCase();
      if (/(fail|denied|revert|error)/.test(st)) return { r: 244, g: 67, b: 54, a: 255 };
      if (/(pending|await|propos)/.test(st)) return { r: 255, g: 193, b: 7, a: 255 };
      return { r: 70, g: 211, b: 154, a: 255 };
    }

    mountScene(container, detail) {
      const mount = container.querySelector('.plan-cinema');
      if (!mount) return;
      const core = (typeof window !== 'undefined') && window.InfrixCinema;
      if (!core || typeof core.mountCinema !== 'function') { mount.style.display = 'none'; return; }
      const scene = this.buildPlanScene(detail);
      if (!scene.nodes.length || scene.nodes.length === 1) { mount.style.display = 'none'; return; }
      try {
        this._cinema = core.mountCinema({ mode: 'cinema.embed', root: mount, scene });
      } catch (e) {
        mount.style.display = 'none';
      }
    }

    async loadCost(container, detail) {
      const el = container.querySelector('.plan-cost');
      if (!el) return;
      if (!this.api || typeof this.api.billingPreview !== 'function') { el.textContent = '—'; return; }
      try {
        const body = await this.api.billingPreview({
          actor: this.api.actor,
          facts: {
            planSteps: detail.steps.length || detail.stepCount || 0,
            approverRounds: detail.approvalCountRequired || 0,
          },
        });
        const d = (body && (body.data || body)) || {};
        const iu = d.meteredIU != null ? d.meteredIU : (d.MeteredIU != null ? d.MeteredIU : null);
        const usd = d.usd != null ? d.usd : (d.USD != null ? d.USD : (d.usdCost != null ? d.usdCost : null));
        if (iu == null && usd == null) { el.textContent = '—'; return; }
        el.textContent = (iu != null ? iu + ' IU' : '') + (usd != null ? ((iu != null ? ' · ' : '') + '$' + usd) : '');
      } catch (e) {
        el.textContent = '—';
      }
    }

    // loadSignBytes shows the EXACT canonical payload the user commits to and
    // its SHA-256 (the value a hardware device would display), from the single
    // background chokepoint — "trust you can read" (WB-10).
    async loadSignBytes(container, detail) {
      const payloadEl = container.querySelector('#' + this._uid + '-payload');
      const hashEl = container.querySelector('#' + this._uid + '-payloadhash');
      if (!payloadEl || !hashEl) return;
      try {
        const prev = await this.runtimeSend({
          type: 'wallet.previewSignaturePayload',
          intentId: detail.intentId,
          planHash: detail.planHash,
        });
        if (!prev || prev.error || !prev.payload) { payloadEl.textContent = '—'; hashEl.textContent = '—'; return; }
        payloadEl.textContent = prev.payload;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prev.payload));
        hashEl.textContent = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      } catch (_) {
        payloadEl.textContent = '—';
        hashEl.textContent = '—';
      }
    }

    // renderLockState surfaces the session lock countdown at the moment of
    // signing, so the user knows whether the next click signs instantly or
    // prompts to unlock (WB-10 + WB-04).
    renderLockState(container) {
      const el = container.querySelector('#' + this._uid + '-lock');
      if (!el) return;
      const st = (typeof window.walletLockState === 'function') ? window.walletLockState() : null;
      if (!st) { el.textContent = ''; return; }
      if (st.unlocked) {
        const s = Math.max(0, Math.floor((st.remainingMs || 0) / 1000));
        el.textContent = '🔓 Unlocked · locks in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        el.className = 'plan-lockstate unlocked';
      } else {
        el.textContent = '🔒 Locked — you’ll be asked to unlock to sign';
        el.className = 'plan-lockstate';
      }
    }

    async signAndApprove(request, detail) {
      // WB-06: route through the signer seam. The canonical payload comes from
      // the background (single chokepoint); the signature is produced by the
      // selected signer (software keystore now; Ledger/YubiKey in WB-07/08);
      // the background assembles + submits the envelope. The plan hash is the
      // simulation binding — signing it commits the user to the exact plan.
      const prev = await this.runtimeSend({
        type: 'wallet.previewSignaturePayload',
        intentId: detail.intentId,
        planHash: detail.planHash,
      });
      if (!prev || prev.error || !prev.payload) {
        throw new Error((prev && prev.error) || 'could not build the signature payload');
      }

      const signer = (typeof window.WalletSigner === 'function')
        ? new window.WalletSigner(this.runtimeSend)
        : null;
      const signed = signer
        ? await signer.sign({ payload: prev.payload, signer: this.signerId || 'software', passphrase: this.currentPassphrase() })
        : await this._softwareSignFallback(prev.payload);

      const result = await this.runtimeSend({
        type: 'wallet.submitApproval',
        requestId: request.id,
        intentId: detail.intentId,
        planHash: detail.planHash,
        signerIdentity: prev.signerIdentity,
        signerPublicKey: signed.publicKey,
        signature: signed.signature,
        signatureAlgorithm: signed.algorithm,
        signaturePayload: prev.payload,
      });
      if (typeof window.walletHandleLocked === 'function' && window.walletHandleLocked(result)) {
        return result;
      }
      if (result && result.error) {
        throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
      }
      if (typeof window.refreshPending === 'function') await window.refreshPending();
      return result;
    }

    async _softwareSignFallback(payload) {
      const r = await this.runtimeSend({ type: 'wallet.signPayload', payload, passphrase: this.currentPassphrase() });
      if (!r || r.error) {
        const e = new Error((r && r.error) || 'signing failed');
        e.code = r && r.code;
        throw e;
      }
      return { signature: r.signature, publicKey: r.publicKey, algorithm: r.algorithm || 'ed25519' };
    }

    esc(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    currentPassphrase() {
      const input = document.getElementById('keyPassphraseInput');
      return input ? input.value : '';
    }
  }

  window.PlanApprovalView = PlanApprovalView;
})();
