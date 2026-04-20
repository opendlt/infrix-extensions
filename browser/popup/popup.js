/**
 * Infrix Wallet — Popup Script
 *
 * Controls the popup UI: account display, key management, session keys,
 * and pending transaction approval.
 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await refreshState();

  document.getElementById('setAdiBtn').addEventListener('click', setADI);
  document.getElementById('generateKeyBtn').addEventListener('click', generateKey);

  // Auto-refresh every 2 seconds for pending requests.
  setInterval(refreshPending, 2000);
}

async function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

async function refreshState() {
  const state = await sendMessage({ type: 'wallet.getState' });

  // ADI display.
  const adiEl = document.getElementById('adiDisplay');
  const dotEl = document.getElementById('statusDot');
  const labelEl = document.getElementById('statusLabel');

  if (state.adi) {
    adiEl.textContent = state.adi;
    dotEl.classList.remove('disconnected');
    labelEl.textContent = 'Connected';
  } else {
    adiEl.textContent = 'No account configured';
    dotEl.classList.add('disconnected');
    labelEl.textContent = 'Disconnected';
  }

  // Keys.
  await refreshKeys();
  await refreshSessions();
  await refreshPending();
}

async function setADI() {
  const input = document.getElementById('adiInput');
  const adi = input.value.trim();
  if (!adi) return;
  await sendMessage({ type: 'wallet.setADI', adi });
  input.value = '';
  await refreshState();
}

async function generateKey() {
  await sendMessage({ type: 'wallet.generateKey', algorithm: 'ed25519' });
  await refreshKeys();
}

async function refreshKeys() {
  const result = await sendMessage({ type: 'wallet.listKeys' });
  const list = document.getElementById('keyList');

  if (!result.keys || result.keys.length === 0) {
    list.innerHTML = '<div class="empty">No keys generated</div>';
    return;
  }

  let html = '';
  for (const key of result.keys) {
    const short = key.publicKey.slice(0, 12) + '...' + key.publicKey.slice(-8);
    html += '<div class="key-item">';
    html += '<span class="key-hex">' + short + '</span>';
    html += '<button class="btn btn-danger btn-sm" onclick="deleteKey(\'' + key.publicKey + '\')">Delete</button>';
    html += '</div>';
  }
  list.innerHTML = html;
}

async function deleteKey(publicKey) {
  await sendMessage({ type: 'wallet.deleteKey', publicKey });
  await refreshKeys();
}

// Make deleteKey globally accessible from onclick handlers.
window.deleteKey = deleteKey;

async function refreshSessions() {
  const result = await sendMessage({ type: 'wallet.listSessions' });
  const list = document.getElementById('sessionList');

  if (!result.sessions || result.sessions.length === 0) {
    list.innerHTML = '<div class="empty">No active sessions</div>';
    return;
  }

  let html = '';
  for (const s of result.sessions) {
    const short = s.publicKey.slice(0, 12) + '...';
    html += '<div class="session-item">';
    html += '<div><strong>' + short + '</strong> (uses left: ' + (s.usesLeft === -1 ? 'unlimited' : s.usesLeft) + ')</div>';
    if (s.scope) {
      const parts = [];
      if (s.scope.contracts && s.scope.contracts.length) parts.push('contracts: ' + s.scope.contracts.join(', '));
      if (s.scope.functions && s.scope.functions.length) parts.push('functions: ' + s.scope.functions.join(', '));
      if (parts.length) html += '<div class="session-scope">' + parts.join(' | ') + '</div>';
    }
    html += '<button class="btn btn-danger btn-sm" style="margin-top:4px" onclick="revokeSession(\'' + s.publicKey + '\')">Revoke</button>';
    html += '</div>';
  }
  list.innerHTML = html;
}

async function revokeSession(publicKey) {
  await sendMessage({ type: 'wallet.revokeSession', publicKey });
  await refreshSessions();
}

window.revokeSession = revokeSession;

async function refreshPending() {
  const result = await sendMessage({ type: 'wallet.getPendingRequests' });
  const section = document.getElementById('pendingSection');
  const list = document.getElementById('pendingList');

  if (!result.requests || result.requests.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  let html = '';
  for (const req of result.requests) {
    html += '<div class="pending-item">';
    html += '<div class="pending-origin">' + (req.origin || 'Unknown origin') + '</div>';
    html += '<div class="pending-action">' + req.type + '</div>';
    // Gap 15 closure: slot the preview + analyze widgets into each
    // pending item. We render after innerHTML is set, so we need unique
    // container IDs per request.
    html += '<div class="cinema-widget-slot" id="cinema-slot-' + req.id + '"></div>';
    html += '<div class="debug-panel-slot" id="debug-slot-' + req.id + '"></div>';
    html += '<div class="btn-row">';
    html += '<button class="btn btn-primary btn-sm" onclick="approveRequest(' + req.id + ')">Approve</button>';
    html += '<button class="btn btn-danger btn-sm" onclick="rejectRequest(' + req.id + ')">Reject</button>';
    html += '</div>';
    html += '</div>';
  }
  list.innerHTML = html;

  // Wire the preview + analyze widgets for any request that carries
  // enough context to invoke them. Pending-request payload lives under
  // req.params (background.js preserves the raw approval envelope
  // verbatim); UI code projects what it needs rather than duplicating
  // fields onto the top-level request. Governance-first discipline:
  // the opaque params envelope stays authoritative, the UI reads from
  // it. The wallet RPC URL comes from the wallet state; fall back to
  // the well-known devnet default so the widget can at least attempt
  // the request.
  //
  // Gap 15 §15 thirteenth-pass closure: /v4/ghost/preview and
  // /v4/debug/analyze are Gap 12 seventh-pass gated endpoints that
  // require X-Actor / X-Purpose / X-Workflow-Instance headers. Build
  // the disclosure context from wallet state + pending-request id and
  // pass it into each widget. If the wallet has no configured ADI we
  // skip widget instantiation entirely — there is no sensible caller
  // identity to stamp, and fabricating one would be a bypass.
  const rpcUrl = (result.rpcUrl || 'http://localhost:8080').replace(/\/+$/, '');
  const walletState = await sendMessage({ type: 'wallet.getState' });
  const actor = (walletState && walletState.adi) || '';
  for (const req of result.requests) {
    const contractUrl = req.params && req.params.contractUrl;
    const fn = req.params && req.params.function;
    const args = (req.params && req.params.args) || null;
    if (!contractUrl || !fn) continue;
    if (!actor) continue; // no wallet ADI → no disclosure context → skip
    // Distinct purpose + workflow-instance for preview vs analyze so
    // audit trails stay separated between the two analytical reads.
    const disclosureCinema = {
      actor,
      purpose: 'wallet-preview',
      workflowInstance: 'wallet-preview-' + req.id,
    };
    const disclosureDebug = {
      actor,
      purpose: 'wallet-analyze',
      workflowInstance: 'wallet-analyze-' + req.id,
    };
    const cinemaSlot = document.getElementById('cinema-slot-' + req.id);
    const debugSlot = document.getElementById('debug-slot-' + req.id);
    if (cinemaSlot && typeof window.CinemaWidget === 'function') {
      const cw = new window.CinemaWidget(cinemaSlot, rpcUrl, disclosureCinema);
      cw.showPreview(contractUrl, fn, args);
    }
    if (debugSlot && typeof window.DebugPanel === 'function') {
      const dp = new window.DebugPanel(debugSlot, rpcUrl, disclosureDebug);
      dp.showForTransaction(contractUrl, fn, args);
    }
  }
}

async function approveRequest(id) {
  await sendMessage({ type: 'wallet.approveRequest', requestId: id });
  await refreshPending();
}

async function rejectRequest(id) {
  await sendMessage({ type: 'wallet.rejectRequest', requestId: id });
  await refreshPending();
}

window.approveRequest = approveRequest;
window.rejectRequest = rejectRequest;
