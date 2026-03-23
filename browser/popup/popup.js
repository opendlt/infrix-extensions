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
    html += '<div class="btn-row">';
    html += '<button class="btn btn-primary btn-sm" onclick="approveRequest(' + req.id + ')">Approve</button>';
    html += '<button class="btn btn-danger btn-sm" onclick="rejectRequest(' + req.id + ')">Reject</button>';
    html += '</div>';
    html += '</div>';
  }
  list.innerHTML = html;
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
