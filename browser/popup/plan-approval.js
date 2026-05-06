/**
 * Infrix Wallet — Plan Approval Detail View (P3 #20)
 *
 * Per the gap analysis: "approve this plan's 7 steps, here is the
 * simulation hash, here are the implicated trust profiles" should be
 * the default affordance.
 *
 * Pre-closure the popup rendered approvals as a single `req.type`
 * line with [Approve] / [Reject] buttons — the user signed without
 * any visibility into what they were approving. This module replaces
 * that with a rich plan-detail view that fetches and renders:
 *
 *   - The intent ID + plan ID + plan hash (simulation-bound)
 *   - All N steps in order, each with its StepKind, StepName, and
 *     implicated TrustProfileID
 *   - The aggregate set of distinct trust profiles the plan touches
 *   - The required-vs-collected approval count
 *   - Sign / reject affordances with the actual stamped plan hash
 *
 * The view fetches plan + step data through the wallet's background
 * RPC proxy (background.js → /rpc); no direct network access from
 * the popup. Failures degrade gracefully — when a field is missing
 * the row shows "—" rather than blocking the approval.
 */

(function() {
  'use strict';

  // PlanApprovalView is a render-and-fetch helper. Each call to
  // .render(container, request) produces the full plan detail view
  // for one pending approval request.
  class PlanApprovalView {
    constructor(rpcSendFn, runtimeSendFn) {
      // rpcSendFn(method, params) → Promise<result>. The popup
      // injects a closure that proxies through chrome.runtime to the
      // background service worker, which then issues a JSON-RPC POST
      // to the configured devnet (used for governed reads:
      // intent.plan, intent.steps, approval.get).
      this.rpc = rpcSendFn;

      // runtimeSendFn(message) → Promise<result>. Direct
      // chrome.runtime.sendMessage equivalent. Used for popup→
      // background-script messages (wallet.approveRequest,
      // wallet.rejectRequest) — these MUST NOT go through the
      // JSON-RPC proxy because they are extension-internal control
      // messages, not devnet RPC methods.
      this.runtimeSend = runtimeSendFn;
    }

    /**
     * Render the full plan-detail view into `container` for the
     * given pending approval `request`. Returns void; failures
     * surface as inline error rows so the user can still sign or
     * reject (e.g. when the plan-fetch RPC is briefly unavailable).
     */
    async render(container, request) {
      // Skeleton with loading placeholders so the user sees the
      // structure immediately while RPCs are in flight.
      container.innerHTML = this.renderSkeleton(request);
      const detail = await this.fetchPlanDetail(request);
      container.innerHTML = this.renderFull(request, detail);

      // Wire button handlers after innerHTML write.
      const approveBtn = container.querySelector('.plan-approve-btn');
      const rejectBtn = container.querySelector('.plan-reject-btn');
      if (approveBtn) approveBtn.addEventListener('click', () => this.signAndApprove(request, detail));
      if (rejectBtn) rejectBtn.addEventListener('click', () => window.rejectRequest(request.id));
    }

    /**
     * Fetch plan + steps + approval status. Failures per RPC accumulate
     * on detail.errors so the renderer can show a degraded but
     * informative view.
     */
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

      // Some pending requests carry the planHash directly in
      // params.planHash (the canonical approval-envelope shape).
      if (request.params && request.params.planHash) {
        detail.planHash = request.params.planHash;
      }
      if (request.params && request.params.planId) {
        detail.planId = request.params.planId;
      }

      // Fetch the ExecutionPlan if we have an intentId.
      if (detail.intentId) {
        try {
          const plan = await this.rpc('intent.plan', { intentId: detail.intentId });
          if (plan && plan.fields) {
            detail.planHash = detail.planHash || plan.fields.PlanHash || '';
            detail.stepCount = Number(plan.fields.StepCount || 0);
            detail.totalGasEstimate = Number(plan.fields.TotalGasEstimate || 0);
            detail.approvalCountRequired = Number(plan.fields.ApprovalCount || 0);
          }
          if (plan && plan.id) {
            detail.planId = detail.planId || plan.id;
          }
        } catch (e) {
          detail.errors.push('intent.plan: ' + (e.message || e));
        }
      }

      // Fetch plan steps via the canonical intent.steps RPC (added
      // in P3 #20). The method returns objects in StepIndex order
      // and is disclosure-context-gated like every other governed
      // read.
      if (detail.intentId) {
        try {
          const stepsResult = await this.rpc('intent.steps', {
            intentId: detail.intentId,
          });
          const list = (stepsResult && stepsResult.steps) || [];
          if (stepsResult && stepsResult.planId && !detail.planId) {
            detail.planId = stepsResult.planId;
          }
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
            if (profile && !detail.trustProfiles.includes(profile)) {
              detail.trustProfiles.push(profile);
            }
          }
          // Server already returns steps sorted by StepIndex, but
          // double-sort defensively in case of race.
          detail.steps.sort((a, b) => a.index - b.index);
        } catch (e) {
          detail.errors.push('intent.steps: ' + (e.message || e));
        }
      }

      // Fetch the Approval object to learn current collected count.
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

    /**
     * Render the skeleton with loading placeholders. Shows enough
     * structure so the user knows what's coming.
     */
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

    /**
     * Render the populated plan-detail view.
     */
    renderFull(request, detail) {
      const stepRows = detail.steps.length === 0
        ? '<div class="plan-empty">no steps loaded' + (detail.intentId ? '' : ' (no intentId on request)') + '</div>'
        : detail.steps.map((s, i) => this.renderStep(s, i + 1)).join('');

      const trustList = detail.trustProfiles.length === 0
        ? '<span class="plan-muted">none declared</span>'
        : detail.trustProfiles.map(p => '<span class="plan-trust-pill">' + this.esc(p) + '</span>').join(' ');

      const reqLabel = detail.approvalCountRequired || '?';
      const collected = detail.approvalCountCollected || 0;

      const errors = detail.errors.length === 0 ? '' :
        '<div class="plan-errors">load errors: ' + detail.errors.map(e => this.esc(e)).join(' · ') + '</div>';

      return [
        '<div class="plan-card">',
          '<div class="plan-header">',
            '<div class="plan-title">Approve this plan\'s ' + (detail.stepCount || detail.steps.length) + ' steps</div>',
            '<div class="plan-origin">from ' + this.esc(request.origin || 'unknown') + '</div>',
          '</div>',

          '<div class="plan-row">',
            '<div class="plan-label">Intent</div>',
            '<div class="plan-value plan-mono">' + this.esc(detail.intentId || '—') + '</div>',
          '</div>',

          '<div class="plan-row">',
            '<div class="plan-label">Plan hash</div>',
            '<div class="plan-value plan-mono plan-hash">' + this.esc(detail.planHash || '—') + '</div>',
          '</div>',

          '<div class="plan-row">',
            '<div class="plan-label">Approvals</div>',
            '<div class="plan-value">' + collected + ' of ' + reqLabel + ' collected</div>',
          '</div>',

          '<div class="plan-row">',
            '<div class="plan-label">Trust profiles</div>',
            '<div class="plan-value">' + trustList + '</div>',
          '</div>',

          '<div class="plan-section-title">Steps</div>',
          '<div class="plan-steps">' + stepRows + '</div>',

          errors,

          '<div class="plan-actions">',
            '<button class="btn btn-primary plan-approve-btn">Sign &amp; approve</button>',
            '<button class="btn btn-danger plan-reject-btn">Reject</button>',
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
            '<div class="plan-step-meta">',
              this.esc(step.name || ''),
              ' · ',
              profile,
            '</div>',
          '</div>',
        '</div>',
      ].join('');
    }

    async signAndApprove(request, detail) {
      // The actual signing happens in the background service worker
      // (it has access to the wallet's keys). The popup hands the
      // background the request id + plan hash and the background
      // resolves the request. The plan hash is the canonical
      // simulation binding — signing it commits the user to the
      // exact plan rendered above.
      //
      // Use the chrome.runtime path — wallet.approveRequest is an
      // extension-internal message, NOT a devnet JSON-RPC method.
      // Routing it through the rpc proxy would forward
      // "wallet.approveRequest" as a JSON-RPC method to the devnet
      // (which doesn't have that method) and silently fail.
      const result = await this.runtimeSend({
        type: 'wallet.approveRequest',
        requestId: request.id,
        planHash: detail.planHash,
        passphrase: this.currentPassphrase(),
      });
      if (result && result.error) {
        throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
      }
      // refreshPending in popup.js re-renders the pending list.
      if (typeof window.refreshPending === 'function') {
        await window.refreshPending();
      }
      return result;
    }

    /** Minimal HTML escape — the popup runs trusted code but
     * approval-content originates from the dApp page and must be
     * treated as untrusted. */
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

  // Export to window so popup.js can construct it.
  window.PlanApprovalView = PlanApprovalView;
})();
