/**
 * Infrix Wallet — Popup controller.
 *
 * Two views: a zero-friction onboarding wizard (first run) and the dashboard
 * (identity, network, governed-activity feed, pending approvals, keys,
 * sessions). The dashboard leans into what makes Infrix different from a
 * balance-and-send wallet: every governed action is graded by the strongest
 * proof it actually backs, and is replayable in the Cinema console.
 *
 * Signing is gated by an in-memory unlock (the passphrase lives only for the
 * popup's lifetime — the popup closes on blur, so it is naturally short-lived).
 */

document.addEventListener('DOMContentLoaded', init);

// ---- Module state ----------------------------------------------------------
let api = null;            // InfrixWalletApi (built once the ADI + rpcUrl are known)
let walletAdi = '';
let walletRpcUrl = 'http://localhost:8080/rpc';
let unlocked = false;      // has the user unlocked signing this popup session?
let activeTab = 'activity';
let pendingPollTimer = null;
let backedUpAt = '';       // ISO of last encrypted-backup export ('' = never)
let pendingRestore = null; // a parsed backup awaiting an overwrite confirmation
let onbMnemonic = '';      // freshly-generated recovery phrase, held during onboarding only
let onbPassphrase = '';    // chosen passphrase, held across the reveal/verify steps
let onbVerifyPositions = []; // 1-based word positions the user must re-enter to confirm
let lockRemainingMs = 0;   // ms until idle auto-lock (mirrors background lockStatus)
let lockPollTimer = null;  // 1s poll keeping the popup lock state in sync

async function init() {
  // Error banner.
  document.getElementById('errorBannerClose').addEventListener('click', clearError);

  // Onboarding wiring.
  wireOnboarding();

  // Dashboard chrome wiring.
  document.getElementById('lockBtn').addEventListener('click', toggleLock);
  document.getElementById('unlockBtn').addEventListener('click', unlock);
  document.getElementById('keyPassphraseInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  document.getElementById('idCopy').addEventListener('click', copyAdi);
  document.getElementById('generateKeyBtn').addEventListener('click', generateKey);
  document.getElementById('openConsole').addEventListener('click', () => openConsole());
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }

  // Backup / restore (WB-02).
  document.getElementById('exportBackupBtn').addEventListener('click', exportBackup);
  document.getElementById('restoreFileInput').addEventListener('change', onRestoreFile);
  document.getElementById('restoreReplaceBtn').addEventListener('click', () => tryImport(true));
  document.getElementById('restoreCancelBtn').addEventListener('click', cancelRestore);
  const nudge = document.getElementById('backupNudge');
  nudge.addEventListener('click', () => switchTab('settings'));
  nudge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') switchTab('settings'); });

  // Reveal recovery phrase (Settings, WB-03).
  document.getElementById('revealPhraseBtn').addEventListener('click', revealRecoveryPhrase);
  document.getElementById('revealSeedHint').addEventListener('click', () => {
    document.getElementById('revealPhraseBox').classList.remove('blurred');
  });
  document.getElementById('revealPhraseHide').addEventListener('click', hideRecoveryPhrase);
  document.getElementById('idleTimeoutSelect').addEventListener('change', async (e) => {
    const res = await sendMessage({ type: 'wallet.setIdleTimeout', ms: Number(e.target.value) });
    if (res && res.idleTimeoutMs) lockRemainingMs = res.idleTimeoutMs;
  });

  // Change passphrase (WB-05).
  document.getElementById('cpBtn').addEventListener('click', changePassphrase);
  const cpNew = document.getElementById('cpNew');
  const cpConfirm = document.getElementById('cpConfirm');
  const cpOnInput = () => {
    const s = passStrength(cpNew.value);
    const bar = document.getElementById('cpStrengthBar');
    bar.style.width = (s.score * 25) + '%';
    bar.style.background = s.color;
    const hint = document.getElementById('cpHint');
    if (cpConfirm.value && cpNew.value !== cpConfirm.value) { hint.textContent = 'New passphrases do not match'; hint.className = 'settings-status'; hint.style.color = 'var(--error)'; }
    else { hint.textContent = cpNew.value ? s.label : ''; hint.className = 'settings-status'; hint.style.color = ''; }
  };
  cpNew.addEventListener('input', cpOnInput);
  cpConfirm.addEventListener('input', cpOnInput);

  await refreshState();

  // Auto-refresh pending approvals every 2s (diff-aware — see refreshPending).
  pendingPollTimer = setInterval(refreshPending, 2000);
}

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// ---- View management -------------------------------------------------------
function showView(name) {
  document.getElementById('onboardingView').hidden = name !== 'onboarding';
  document.getElementById('dashboardView').hidden = name !== 'dashboard';
}

async function refreshState() {
  const state = await sendMessage({ type: 'wallet.getState' });
  walletAdi = (state && state.adi) || '';
  walletRpcUrl = (state && state.rpcUrl) || walletRpcUrl;
  api = new window.InfrixWalletApi(walletRpcUrl, walletAdi);

  if (!walletAdi) {
    showView('onboarding');
    return;
  }
  showView('dashboard');
  renderIdentity(state);
  await syncLockStatus(); // reflect the real background session (may be unlocked or evicted)
  startLockPoll();
  backedUpAt = (state && state.backedUpAt) || '';
  updateBackupUI(state);
  await Promise.all([refreshNetwork(), refreshKeys(), refreshSessions(), refreshActivity()]);
  await refreshPending();
}

// ---- Identity --------------------------------------------------------------
function renderIdentity(state) {
  document.getElementById('idAdi').textContent = walletAdi;
  document.getElementById('idIcon').innerHTML = window.InfrixWalletData.identiconSvg(walletAdi, 40);
  const n = (state && state.keyCount) || 0;
  document.getElementById('idKeyMeta').textContent = n === 0 ? 'no keys' : (n === 1 ? 'ed25519 · 1 key' : 'ed25519 · ' + n + ' keys');
}

async function copyAdi() {
  try {
    await navigator.clipboard.writeText(walletAdi);
    const btn = document.getElementById('idCopy');
    const prev = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  } catch (_) { /* clipboard may be unavailable; ignore */ }
}

// ---- Network pill ----------------------------------------------------------
async function refreshNetwork() {
  const dot = document.getElementById('netDot');
  const label = document.getElementById('netLabel');
  try {
    const body = await api.networkStatus();
    const d = (body && (body.data || body)) || {};
    const chain = d.chainId || d.chain || 'devnet';
    const height = d.blockHeight != null ? d.blockHeight : (d.height != null ? d.height : null);
    label.textContent = chain + (height != null ? ' · #' + height : '');
    dot.className = 'net-dot' + (d.syncing ? ' syncing' : '');
  } catch (_) {
    label.textContent = 'offline';
    dot.className = 'net-dot down';
  }
}

// ---- Governed-activity feed (the differentiator) ---------------------------
async function refreshActivity() {
  const list = document.getElementById('activityList');
  let intents;
  try {
    const body = await api.listIntents(25);
    intents = extractIntents(body);
  } catch (e) {
    list.innerHTML = '<div class="empty">Activity unavailable (' + escapeHTML(e.message) + ')</div>';
    return;
  }
  if (!intents.length) {
    list.innerHTML = '<div class="empty">No governed activity yet</div>';
    return;
  }
  list.innerHTML = '';
  for (const it of intents) {
    const id = it.id || it.ID || it.intentId || '';
    const goal = it.goal || it.goalType || it.type || 'intent';
    const status = it.status || it.state || '';
    const kind = window.InfrixWalletData.statusKind(status);
    const grade = gradeIntent(it);
    const when = formatWhen(it.createdAt || it.created_at || it.timestamp);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'activity-row';
    row.innerHTML =
      '<span class="act-dot ' + kind + '"></span>' +
      '<span class="act-body">' +
        '<span class="act-goal">' + escapeHTML(humanizeGoal(goal)) + '</span>' +
        '<span class="act-meta">' + escapeHTML(status || kind) + (when ? ' · ' + escapeHTML(when) : '') + '</span>' +
      '</span>' +
      '<span class="assurance-badge" data-assurance="' + grade.id + '">' + escapeHTML(grade.label) + '</span>';
    if (id) row.addEventListener('click', () => openConsole(id));
    list.appendChild(row);
  }
}

// extractIntents pulls the intent array out of the v4 envelope, tolerant of
// the several shapes the list endpoint may use.
function extractIntents(body) {
  if (!body) return [];
  const d = body.data != null ? body.data : body;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.intents)) return d.intents;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(body.intents)) return body.intents;
  return [];
}

// gradeIntent grades an activity row by the strongest proof the API reports for
// it — honestly, never over-claiming. Prefers explicit governance fields;
// falls back to lifecycle status keywords; defaults to Structural.
function gradeIntent(it) {
  const A = window.InfrixWalletData.ASSURANCE;
  const gov = it.governance || it.gov || {};
  const status = String(it.status || it.state || '').toLowerCase();
  if (gov.anchorId || gov.anchorTx || /anchor/.test(status)) return A.l0;
  if (gov.witnessId || /witness/.test(status)) return A.witness;
  if (gov.evidenceId || /(evidence|executed|outcome|complete|verified)/.test(status)) return A.replay;
  return A.offline;
}

function humanizeGoal(goal) {
  return String(goal).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatWhen(ts) {
  if (!ts) return '';
  let d;
  if (typeof ts === 'number') d = new Date(ts > 1e12 ? ts : ts * 1000);
  else d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return secs + 's ago';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// ---- Lock / unlock model (WB-04) -------------------------------------------
// The background keystore is the source of truth: wallet.unlock opens a session
// that signs instantly (one PBKDF2 derivation per unlock, not per signature),
// and an idle timer / SW eviction / explicit lock ends it. The popup mirrors
// that state by polling wallet.lockStatus, and shows a live countdown. The
// passphrase field is the unlock input AND a re-unlock fallback if the session
// was evicted while the popup was closed.
function currentPassphrase() {
  const el = document.getElementById('keyPassphraseInput');
  return el ? el.value : '';
}

function isUnlocked() { return unlocked; }

async function unlock() {
  clearError();
  const passphrase = currentPassphrase();
  if (!passphrase) { showError('Enter your passphrase to unlock.'); return; }
  const res = await sendMessage({ type: 'wallet.unlock', passphrase });
  if (res && res.unlocked) {
    unlocked = true;
    lockRemainingMs = res.remainingMs || 0;
    applyLockUI();
    startLockPoll();
  } else {
    unlocked = false;
    applyLockUI();
    showError((res && res.error) || 'Wrong passphrase.');
  }
}

async function toggleLock() {
  if (unlocked) {
    await sendMessage({ type: 'wallet.lock' });
    unlocked = false;
    lockRemainingMs = 0;
    const el = document.getElementById('keyPassphraseInput');
    if (el) el.value = '';
  }
  applyLockUI();
}

function fmtRemaining(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function applyLockUI() {
  const on = unlocked;
  document.getElementById('unlockBar').hidden = on;
  const lockEl = document.getElementById('idLock');
  lockEl.textContent = on ? ('Unlocked · ' + fmtRemaining(lockRemainingMs)) : 'Locked';
  lockEl.classList.toggle('unlocked', on);
  const btn = document.getElementById('lockBtn');
  btn.textContent = on ? '\u{1F513}' : '\u{1F512}'; // 🔓 / 🔒
  btn.classList.toggle('unlocked', on);
  btn.title = on ? 'Lock signing now' : 'Locked';
}

// syncLockStatus reads the background session state once and reflects it.
async function syncLockStatus() {
  const st = await sendMessage({ type: 'wallet.lockStatus' });
  unlocked = !!(st && st.unlocked);
  lockRemainingMs = (st && st.remainingMs) || 0;
  applyLockUI();
}

// startLockPoll keeps the popup's lock state + countdown in sync with the
// background session (catches idle auto-lock and SW eviction while open).
function startLockPoll() {
  if (lockPollTimer) return;
  lockPollTimer = setInterval(async () => {
    const st = await sendMessage({ type: 'wallet.lockStatus' });
    const was = unlocked;
    unlocked = !!(st && st.unlocked);
    lockRemainingMs = (st && st.remainingMs) || 0;
    if (!unlocked && was) {
      const el = document.getElementById('keyPassphraseInput');
      if (el) el.value = ''; // session ended → clear the stale passphrase
    }
    applyLockUI();
  }, 1000);
}

// requireUnlock surfaces the unlock bar + a hint when a signing op is attempted
// while locked. Returns true when the wallet is ready to sign.
function requireUnlock() {
  if (unlocked) return true;
  applyLockUI();
  document.getElementById('unlockBar').hidden = false;
  document.getElementById('keyPassphraseInput').focus();
  showError('Unlock your wallet to sign.');
  return false;
}

// handleLockedResult reacts to a background op that returned WALLET_LOCKED
// (e.g. the session was evicted while the popup thought it was unlocked):
// flip to locked and prompt. Returns true when it handled a locked result.
function handleLockedResult(result) {
  if (result && result.code === 'WALLET_LOCKED') {
    unlocked = false;
    lockRemainingMs = 0;
    applyLockUI();
    document.getElementById('unlockBar').hidden = false;
    showError('Your wallet locked. Unlock to continue.');
    return true;
  }
  return false;
}

// ---- Tabs ------------------------------------------------------------------
function switchTab(name) {
  activeTab = name;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.id !== 'panel-' + name;
  }
}

// ---- Keys ------------------------------------------------------------------
async function generateKey() {
  clearError();
  if (!requireUnlock()) return;
  const label = document.getElementById('newKeyLabel').value.trim();
  const purpose = document.getElementById('newKeyPurpose').value;
  const result = await sendMessage({ type: 'wallet.generateKey', algorithm: 'ed25519', passphrase: currentPassphrase(), label, purpose });
  if (handleLockedResult(result)) return;
  if (result && result.error) { showError(result.error); return; }
  document.getElementById('newKeyLabel').value = '';
  document.getElementById('newKeyPurpose').value = '';
  await refreshKeys();
  await refreshState(); // refresh identity key count
}

// renderKeyName falls back to "Key N" when a key has no label.
function keyDisplayName(key, index) {
  return key.label && key.label.length ? key.label : ('Key ' + (index + 1));
}

async function refreshKeys() {
  const result = await sendMessage({ type: 'wallet.listKeys' });
  const list = document.getElementById('keyList');
  const keys = (result && result.keys) || [];
  if (keys.length === 0) {
    list.innerHTML = '<div class="empty">No keys generated</div>';
    return;
  }
  list.innerHTML = '';
  keys.forEach((key, i) => {
    const short = key.publicKey.slice(0, 10) + '…' + key.publicKey.slice(-6);
    const created = formatWhen(key.createdAt);
    const used = key.lastUsedAt ? ('used ' + formatWhen(key.lastUsedAt)) : 'never used';
    const card = document.createElement('div');
    card.className = 'key-card';
    card.innerHTML =
      '<span class="key-identicon">' + window.InfrixWalletData.identiconSvg(key.publicKey, 32) + '</span>' +
      '<span class="key-card-body">' +
        '<input class="key-label" data-keyid="' + escapeHTML(key.keyId) + '" value="' + escapeHTML(keyDisplayName(key, i)) + '" aria-label="Key name">' +
        '<span class="key-card-meta">' + escapeHTML(short) + (created ? ' · ' + escapeHTML(created) : '') + ' · ' + escapeHTML(used) + '</span>' +
        (key.purpose ? '<span class="key-purpose">' + escapeHTML(key.purpose) + '</span>' : '') +
      '</span>' +
      '<button class="btn btn-danger btn-sm" onclick="deleteKey(\'' + escapeHTML(key.keyId) + '\')">Delete</button>';
    list.appendChild(card);
  });
  // Wire inline rename (commit on blur or Enter).
  for (const input of list.querySelectorAll('.key-label')) {
    const commit = async () => {
      const label = input.value.trim();
      await sendMessage({ type: 'wallet.renameKey', keyId: input.dataset.keyid, label });
      await refreshState(); // active-key label on the identity card may change
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }
  // Surface the active (first) signing key on the identity card.
  const idKeyMeta = document.getElementById('idKeyMeta');
  if (idKeyMeta) {
    idKeyMeta.textContent = keyDisplayName(keys[0], 0) + ' · ed25519 · ' + keys.length + (keys.length === 1 ? ' key' : ' keys');
  }
}

async function deleteKey(keyId) {
  clearError();
  if (!requireUnlock()) return;
  const result = await sendMessage({ type: 'wallet.deleteKey', keyId, passphrase: currentPassphrase() });
  if (handleLockedResult(result)) return;
  if (result && result.error) { showError(result.error); return; }
  await refreshKeys();
  await refreshState();
}
window.deleteKey = deleteKey;

// ---- Sessions --------------------------------------------------------------
async function refreshSessions() {
  const result = await sendMessage({ type: 'wallet.listSessions' });
  const list = document.getElementById('sessionList');
  if (!result.sessions || result.sessions.length === 0) {
    list.innerHTML = '<div class="empty">No active sessions</div>';
    return;
  }
  let html = '';
  for (const s of result.sessions) {
    const short = s.publicKey.slice(0, 12) + '…';
    html += '<div class="session-item">';
    html += '<div><strong>' + escapeHTML(short) + '</strong> (uses left: ' + (s.usesLeft === -1 ? 'unlimited' : s.usesLeft) + ')</div>';
    if (s.scope) {
      const parts = [];
      if (s.scope.contracts && s.scope.contracts.length) parts.push('contracts: ' + s.scope.contracts.join(', '));
      if (s.scope.functions && s.scope.functions.length) parts.push('functions: ' + s.scope.functions.join(', '));
      if (parts.length) html += '<div class="session-scope">' + escapeHTML(parts.join(' | ')) + '</div>';
    }
    html += '<button class="btn btn-danger btn-sm" style="margin-top:4px" onclick="revokeSession(\'' + escapeHTML(s.publicKey) + '\')">Revoke</button>';
    html += '</div>';
  }
  list.innerHTML = html;
}

async function revokeSession(publicKey) {
  await sendMessage({ type: 'wallet.revokeSession', publicKey });
  await refreshSessions();
}
window.revokeSession = revokeSession;

// ---- Pending approvals -----------------------------------------------------
// Diff-tracking: the 2s interval must not re-render an unchanged pending set
// (that would re-instantiate PlanApprovalView, re-fire its plan-detail RPCs,
// and discard typed input / mounted previews). renderedPendingSig holds what's
// on screen; pendingRefreshInFlight guards against overlapping invocations.
let renderedPendingSig = null;
let pendingRefreshInFlight = false;

async function refreshPending() {
  if (pendingRefreshInFlight) return;
  pendingRefreshInFlight = true;
  try {
    const result = await sendMessage({ type: 'wallet.getPendingRequests' });
    const walletState = await sendMessage({ type: 'wallet.getState' });
    const hero = document.getElementById('pendingHero');
    const list = document.getElementById('pendingList');
    if (!hero || !list) return; // dashboard not mounted (onboarding view)
    const requests = (result && result.requests) || [];
    const actor = (walletState && walletState.adi) || '';

    // Re-render only when the pending SET (or the ADI that gates the preview
    // widgets) actually changes. Pending requests are immutable once queued,
    // so an (id, type) signature plus the actor is sufficient.
    const sig = actor + '||' + requests.map((r) => r.id + ':' + (r.type || '')).join('|');
    if (sig === renderedPendingSig) return;
    renderedPendingSig = sig;

    document.getElementById('phCount').textContent = String(requests.length);
    if (requests.length === 0) {
      hero.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    hero.style.display = '';

    // P3 #20: render approveIntent / approveRequest types through the
    // PlanApprovalView — the gap-analysis-mandated default affordance.
    // Other request types (e.g. connect, sign-message) keep the simple
    // rendering. PlanApprovalView is exposed as window.PlanApprovalView.
    list.innerHTML = '';
    const planApprovalRpc = (method, params) => sendRPCThroughBackground(method, params);
    const planView = (typeof window.PlanApprovalView === 'function')
      ? new window.PlanApprovalView(planApprovalRpc, sendMessage, api)
      : null;

    for (const req of requests) {
      const item = document.createElement('div');
      item.className = 'pending-item';
      list.appendChild(item);

      if (planView && isPlanApprovalRequest(req)) {
        // Default affordance: the rich plan-detail / see-before-you-sign view.
        planView.render(item, req);
        continue;
      }

      // Fallback for non-plan requests (connect, sign, etc.).
      let html = '';
      html += '<div class="pending-origin">' + escapeHTML(req.origin || 'Unknown origin') + '</div>';
      html += '<div class="pending-action">' + escapeHTML(req.type) + '</div>';
      html += '<div class="cinema-widget-slot" id="cinema-slot-' + req.id + '"></div>';
      html += '<div class="debug-panel-slot" id="debug-slot-' + req.id + '"></div>';
      html += '<div class="btn-row">';
      html += '<button class="btn btn-primary btn-sm" onclick="approveRequest(' + req.id + ')">Approve</button>';
      html += '<button class="btn btn-danger btn-sm" onclick="rejectRequest(' + req.id + ')">Reject</button>';
      html += '</div>';
      item.innerHTML = html;
    }

    // Wire the preview + analyze widgets for any request that carries enough
    // context. Pending-request payload lives under req.params (background.js
    // preserves the raw approval envelope verbatim); the UI reads from it.
    //
    // Gap 15 §15: /v4/ghost/preview and /v4/debug/analyze are disclosure-gated
    // endpoints that require X-Actor / X-Purpose / X-Workflow-Instance. Build
    // the disclosure context from wallet state + pending-request id. If the
    // wallet has no configured ADI we skip widget instantiation entirely —
    // there is no sensible caller identity to stamp.
    const rpcUrl = (result.rpcUrl || 'http://localhost:8080').replace(/\/+$/, '');
    for (const req of requests) {
      const contractUrl = req.params && req.params.contractUrl;
      const fn = req.params && req.params.function;
      const args = (req.params && req.params.args) || null;
      if (!contractUrl || !fn) continue;
      if (!actor) continue; // no wallet ADI → no disclosure context → skip
      // Distinct purpose + workflow-instance for preview vs analyze so audit
      // trails stay separated between the two analytical reads.
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
  } finally {
    pendingRefreshInFlight = false;
  }
}

async function approveRequest(id) {
  clearError();
  if (!requireUnlock()) return;
  const result = await sendMessage({ type: 'wallet.approveRequest', requestId: id, passphrase: currentPassphrase() });
  if (handleLockedResult(result)) return;
  if (result && result.error) { showError(result.error); return; }
  await refreshPending();
  await refreshActivity();
}

async function rejectRequest(id) {
  await sendMessage({ type: 'wallet.rejectRequest', requestId: id });
  await refreshPending();
}
window.approveRequest = approveRequest;
window.rejectRequest = rejectRequest;
window.refreshPending = refreshPending;

// ---- Onboarding ------------------------------------------------------------
function wireOnboarding() {
  const name = document.getElementById('onbName');
  const hint = document.getElementById('onbNameHint');
  name.addEventListener('input', () => {
    const v = sanitizeName(name.value);
    if (name.value !== v) name.value = v;
    if (!v) { hint.textContent = ''; hint.className = 'onb-hint'; return; }
    hint.textContent = 'Your account will be acc://' + v + '.acme';
    hint.className = 'onb-hint ok';
  });

  const p1 = document.getElementById('onbPass');
  const p2 = document.getElementById('onbPass2');
  const bar = document.getElementById('onbStrengthBar');
  const phint = document.getElementById('onbPassHint');
  const onPass = () => {
    const s = passStrength(p1.value);
    bar.style.width = (s.score * 25) + '%';
    bar.style.background = s.color;
    if (p2.value && p1.value !== p2.value) { phint.textContent = 'Passphrases do not match'; phint.className = 'onb-hint bad'; }
    else if (p1.value) { phint.textContent = s.label; phint.className = 'onb-hint ' + (s.score >= 2 ? 'ok' : ''); }
    else { phint.textContent = ''; phint.className = 'onb-hint'; }
  };
  p1.addEventListener('input', onPass);
  p2.addEventListener('input', onPass);

  document.getElementById('onbCreate').addEventListener('click', onboardCreate);
  document.getElementById('onbImportBtn').addEventListener('click', onboardRestore);
  document.getElementById('onbRevealNext').addEventListener('click', () => showOnbPane('verify'));
  document.getElementById('onbVerifyBtn').addEventListener('click', onboardVerify);
  document.getElementById('onbVerifyBack').addEventListener('click', () => showOnbPane('reveal'));
  document.getElementById('onbToImport').addEventListener('click', () => showOnbPane('import'));
  document.getElementById('onbToCreate').addEventListener('click', () => showOnbPane('create'));
}

// showOnbPane toggles which onboarding pane is visible, rendering the reveal /
// verify content as it is shown.
function showOnbPane(pane) {
  const panes = { create: 'onbCreatePane', reveal: 'onbRevealPane', verify: 'onbVerifyPane', import: 'onbImportPane' };
  for (const [name, id] of Object.entries(panes)) {
    document.getElementById(id).hidden = name !== pane;
  }
  if (pane === 'reveal') renderSeedGrid('onbSeedGrid', onbMnemonic);
  if (pane === 'verify') renderVerifyInputs();
}

function sanitizeName(v) {
  return String(v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

function passStrength(p) {
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (/[^a-zA-Z0-9]/.test(p) || (/[a-z]/.test(p) && /[0-9]/.test(p))) score++;
  if (p.length >= 16) score++;
  score = Math.min(4, score);
  const map = [
    { label: 'Too short', color: 'var(--error)' },
    { label: 'Weak', color: '#f0a030' },
    { label: 'Okay', color: '#ffc107' },
    { label: 'Strong', color: 'var(--success)' },
    { label: 'Very strong', color: 'var(--success)' },
  ];
  return { score, label: map[score].label, color: map[score].color };
}

async function onboardCreate() {
  clearError();
  const name = sanitizeName(document.getElementById('onbName').value);
  const p1 = document.getElementById('onbPass').value;
  const p2 = document.getElementById('onbPass2').value;
  if (!name) { showError('Pick a name for your account.'); return; }
  if (!p1) { showError('Set a passphrase.'); return; }
  if (p1 !== p2) { showError('Passphrases do not match.'); return; }
  if (passStrength(p1).score < 1) { showError('Choose a longer passphrase (8+ characters).'); return; }
  const adi = 'acc://' + name + '.acme';
  // Background generates the recovery phrase + key #0 and stores the seed.
  const res = await sendMessage({ type: 'wallet.createAccount', adi, passphrase: p1 });
  if (!res || res.error) { showError((res && res.error) || 'Account creation failed.'); return; }
  onbMnemonic = res.mnemonic;
  onbPassphrase = p1;
  showOnbPane('reveal');
}

async function onboardRestore() {
  clearError();
  const name = sanitizeName(document.getElementById('onbImportName').value);
  const phrase = document.getElementById('onbImportPhrase').value.trim().replace(/\s+/g, ' ');
  const pass = document.getElementById('onbImportPass').value;
  if (!name) { showError('Enter your account name.'); return; }
  if (!phrase) { showError('Enter your recovery phrase.'); return; }
  if (!pass) { showError('Set a passphrase for this device.'); return; }
  const adi = 'acc://' + name + '.acme';
  const res = await sendMessage({ type: 'wallet.restoreFromMnemonic', adi, mnemonic: phrase, passphrase: pass });
  if (!res || res.error) { showError((res && res.error) || 'Restore failed.'); return; }
  await finalizeOnboarding(pass);
}

// renderSeedGrid renders a numbered 12-word grid into the given container.
function renderSeedGrid(containerId, mnemonic) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const words = String(mnemonic || '').trim().split(/\s+/);
  el.innerHTML = words.map((w, i) =>
    '<div class="seed-word"><span class="sw-n">' + (i + 1) + '</span>' + escapeHTML(w) + '</div>').join('');
}

// renderVerifyInputs picks 3 distinct word positions and renders inputs.
function renderVerifyInputs() {
  const words = onbMnemonic.trim().split(/\s+/);
  const positions = [];
  while (positions.length < 3 && positions.length < words.length) {
    const p = 1 + Math.floor(Math.random() * words.length);
    if (!positions.includes(p)) positions.push(p);
  }
  positions.sort((a, b) => a - b);
  onbVerifyPositions = positions;
  document.getElementById('onbVerifyPrompt').textContent =
    'Enter words ' + positions.join(', ') + ' to confirm you saved your phrase.';
  document.getElementById('onbVerifyInputs').innerHTML = positions.map((p) =>
    '<div class="verify-row"><label>Word #' + p + '</label>' +
    '<input type="text" class="verify-word" data-pos="' + p + '" autocomplete="off" spellcheck="false"></div>').join('');
}

async function onboardVerify() {
  clearError();
  const words = onbMnemonic.trim().split(/\s+/);
  const inputs = document.querySelectorAll('#onbVerifyInputs .verify-word');
  for (const inp of inputs) {
    const pos = Number(inp.dataset.pos);
    if (inp.value.trim().toLowerCase() !== words[pos - 1]) {
      showError('Word #' + pos + " doesn't match. Check your written copy.");
      return;
    }
  }
  // Confirmed: the recovery phrase IS the backup → mark backed up.
  await sendMessage({ type: 'wallet.markBackedUp' });
  await finalizeOnboarding(onbPassphrase);
}

// finalizeOnboarding lands the freshly-created/restored account on the
// dashboard, unlocked, and clears the transient phrase from memory.
async function finalizeOnboarding(passphrase) {
  onbMnemonic = '';
  onbPassphrase = '';
  onbVerifyPositions = [];
  await refreshState();
  const el = document.getElementById('keyPassphraseInput');
  if (el) el.value = passphrase;
  unlocked = true;
  applyLockUI();
}

// ---- Reveal recovery phrase (Settings, WB-03) -----------------------------
async function revealRecoveryPhrase() {
  clearError();
  const passEl = document.getElementById('revealPhrasePass');
  const passphrase = passEl ? passEl.value : '';
  if (!passphrase) { showError('Enter your passphrase to reveal your phrase.'); return; }
  const res = await sendMessage({ type: 'wallet.revealMnemonic', passphrase });
  if (!res || res.error) { showError((res && res.error) || 'Could not reveal phrase.'); return; }
  renderSeedGrid('revealSeedGrid', res.mnemonic);
  const box = document.getElementById('revealPhraseBox');
  box.classList.add('blurred');
  box.hidden = false;
  document.getElementById('revealPhraseStart').hidden = true;
  if (passEl) passEl.value = '';
}

function hideRecoveryPhrase() {
  const box = document.getElementById('revealPhraseBox');
  document.getElementById('revealSeedGrid').innerHTML = ''; // drop the words from the DOM
  box.classList.add('blurred');
  box.hidden = true;
  document.getElementById('revealPhraseStart').hidden = false;
}

// ---- Change passphrase (WB-05) --------------------------------------------
async function changePassphrase() {
  clearError();
  const cur = document.getElementById('cpCurrent').value;
  const neu = document.getElementById('cpNew').value;
  const conf = document.getElementById('cpConfirm').value;
  if (!cur) { showError('Enter your current passphrase.'); return; }
  if (!neu) { showError('Enter a new passphrase.'); return; }
  if (neu !== conf) { showError('New passphrases do not match.'); return; }
  if (neu === cur) { showError('New passphrase must differ from the current one.'); return; }
  if (passStrength(neu).score < 1) { showError('Choose a longer new passphrase (8+ characters).'); return; }
  const res = await sendMessage({ type: 'wallet.rotatePassphrase', oldPassphrase: cur, newPassphrase: neu });
  if (!res || res.error) { showError((res && res.error) || 'Could not change passphrase.'); return; }
  // rotate left the keystore unlocked under the NEW key; sync the session + UI.
  document.getElementById('cpCurrent').value = '';
  document.getElementById('cpNew').value = '';
  document.getElementById('cpConfirm').value = '';
  document.getElementById('cpStrengthBar').style.width = '0';
  const el = document.getElementById('keyPassphraseInput');
  if (el) el.value = neu; // keep the session's unlock fallback current
  await syncLockStatus();
  const hint = document.getElementById('cpHint');
  hint.textContent = 'Passphrase changed.';
  hint.className = 'settings-status ok';
  hint.style.color = '';
}

// ---- Expanded Cinema console ----------------------------------------------
function openConsole(intentId) {
  const base = chrome.runtime.getURL('cinema/console.html');
  const url = intentId ? base + '?intent=' + encodeURIComponent(intentId) : base;
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, '_blank');
}
// Exposed so the approval sheet's "Expand" affordance can open the full console
// for the intent under review.
window.openWalletConsole = openConsole;

// ---- Backup / restore (WB-02) ---------------------------------------------
function updateBackupUI(state) {
  const keyCount = (state && state.keyCount) || 0;
  const nudge = document.getElementById('backupNudge');
  // Nudge only matters once there are keys to lose.
  if (nudge) nudge.classList.toggle('show', !backedUpAt && keyCount > 0);
  const status = document.getElementById('backupStatus');
  if (status) {
    if (backedUpAt) {
      status.textContent = 'Last backed up ' + (formatWhen(backedUpAt) || 'recently') + '.';
      status.classList.add('ok');
    } else {
      status.textContent = 'Not backed up yet.';
      status.classList.remove('ok');
    }
  }
}

async function exportBackup() {
  clearError();
  const res = await sendMessage({ type: 'wallet.exportBackup' });
  if (!res || res.error) { showError((res && res.error) || 'Export failed.'); return; }
  const safe = (walletAdi || 'wallet').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'wallet';
  downloadJson('infrix-backup-' + safe + '.json', res.backup);
  await refreshState(); // backedUpAt now set → nudge hides, status updates
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onRestoreFile(e) {
  clearError();
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (_) {
    showError('That file is not a valid Infrix backup.');
    return;
  }
  pendingRestore = backup;
  await tryImport(false);
}

async function tryImport(overwrite) {
  if (!pendingRestore) return;
  const confirmEl = document.getElementById('restoreConfirm');
  const res = await sendMessage({ type: 'wallet.importBackup', backup: pendingRestore, overwrite });
  if (res && res.needsOverwrite) {
    // Inline confirm (no native dialog): reveal Replace / Cancel.
    if (confirmEl) confirmEl.hidden = false;
    return;
  }
  if (confirmEl) confirmEl.hidden = true;
  if (!res || res.error) {
    showError((res && res.error) || 'Restore failed.');
    pendingRestore = null;
    return;
  }
  pendingRestore = null;
  const f = document.getElementById('restoreFileInput');
  if (f) f.value = '';
  // Land on the restored account, locked — the unlock bar is shown by
  // applyLockUI() so the user unlocks with that account's passphrase.
  await refreshState();
  switchTab('activity');
}

function cancelRestore() {
  pendingRestore = null;
  const c = document.getElementById('restoreConfirm');
  if (c) c.hidden = true;
  const f = document.getElementById('restoreFileInput');
  if (f) f.value = '';
}

/**
 * isPlanApprovalRequest reports whether a pending request should render through
 * the rich plan-detail view (P3 #20). The canonical shape carries either an
 * explicit type marker OR a params block with a planHash / intentId.
 */
function isPlanApprovalRequest(req) {
  if (!req) return false;
  const type = String(req.type || '');
  if (type === 'approveIntent' || type === 'wallet.approveIntent' || type === 'approval.signPlan') return true;
  if (req.params && (req.params.planHash || req.params.intentId || req.params.planId)) return true;
  return false;
}

/**
 * sendRPCThroughBackground proxies a JSON-RPC method through the background
 * service worker. The background translates wallet.rpc messages into HTTP
 * POSTs to the configured devnet RPC URL.
 */
async function sendRPCThroughBackground(method, params) {
  const result = await sendMessage({ type: 'wallet.rpc', method, params });
  if (!result) throw new Error('no response from background');
  if (result.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
  return result.result;
}

/**
 * showError surfaces a failure in the in-popup error banner instead of a
 * native alert(). Exposed as window.showWalletError so plan-approval.js can
 * report signing failures the same way. clearError hides the banner.
 */
function showError(msg) {
  const banner = document.getElementById('errorBanner');
  const msgEl = document.getElementById('errorBannerMsg');
  if (!banner || !msgEl) return;
  msgEl.textContent = (msg == null || msg === '') ? 'Unknown error' : String(msg);
  banner.classList.add('show');
}

function clearError() {
  const banner = document.getElementById('errorBanner');
  if (banner) banner.classList.remove('show');
}

window.showWalletError = showError;
window.clearWalletError = clearError;
// Exposed so plan-approval.js can gate signing on the unlock model (reveals the
// unlock bar + a hint when the wallet is locked) before attempting to sign.
window.walletEnsureUnlocked = requireUnlock;
// Exposed so plan-approval.js can react to a mid-session WALLET_LOCKED.
window.walletHandleLocked = handleLockedResult;
// Exposed so the approval sheet can show the session lock state at sign time (WB-10).
window.walletLockState = () => ({ unlocked, remainingMs: lockRemainingMs });

/**
 * escapeHTML protects against injection from dApp-supplied request fields. The
 * popup runs trusted code but request payloads originate from the page that
 * called window.infrix.* — they must be treated as untrusted.
 */
function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
