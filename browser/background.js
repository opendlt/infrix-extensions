/**
 * Infrix Wallet — Background Service Worker
 *
 * Handles key storage, transaction signing, session key validation,
 * and acts as an RPC proxy to the Infrix devnet/mainnet.
 */

import { EncryptedKeystore } from './wallet/keystore.js';
import { generateMnemonic, validateMnemonic, deriveKey } from './wallet/mnemonic.js';

// ---- State ----

let walletState = {
  adi: '',
  rpcUrl: 'http://localhost:8080/rpc',
  keys: [],         // { publicKey: hex, algorithm: string, createdAt: string }
  sessions: [],     // { publicKey: hex, scope: {...}, createdAt: string, usesLeft: number }
  sponsors: [],     // { sponsorAdi: string, ... }
  connected: false,
  backedUpAt: '',   // ISO timestamp of the last encrypted-backup export ('' = never)
  pendingRequests: new Map(),
};

let nextRequestId = 1;
let encryptedKeystore = null;

// Load state from chrome.storage on startup.
chrome.storage.local.get(['walletState'], (result) => {
  if (result.walletState) {
    walletState = { ...walletState, ...result.walletState };
  }
});

function saveState() {
  chrome.storage.local.set({ walletState });
}

// ---- Message Handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    // Carry a machine-readable code (e.g. WALLET_LOCKED) so the popup can react
    // (prompt unlock) rather than just surfacing a string.
    sendResponse({ error: err.message, code: err.code });
  });
  return true; // Keep the message channel open for async response.
});

async function handleMessage(message, sender) {
  switch (message.type) {
    // ---- Account ----
    case 'wallet.getState': {
      const keys = await listStoredKeys();
      return {
        adi: walletState.adi,
        connected: walletState.connected,
        keyCount: keys.length,
        sessionCount: walletState.sessions.length,
        // rpcUrl lets the popup derive the /v4 REST origin for governed
        // reads (activity, balance, evidence). The popup is an extension
        // page, so it may fetch the localhost host_permissions origin
        // directly — the same path the Cinema/Debug widgets already use.
        rpcUrl: walletState.rpcUrl,
        // backedUpAt drives the "back up your account" nudge: '' until the user
        // has exported an encrypted backup at least once.
        backedUpAt: walletState.backedUpAt || '',
      };
    }

    case 'wallet.setADI':
      walletState.adi = message.adi;
      walletState.connected = true;
      saveState();
      return { adi: walletState.adi };

    case 'wallet.setRpcUrl':
      walletState.rpcUrl = message.rpcUrl;
      saveState();
      return { rpcUrl: walletState.rpcUrl };

    // ---- Key Management ----
    case 'wallet.generateKey': {
      const ks = getKeystore();
      // Use the open session if there is one; otherwise a passphrase is required
      // to unlock (or initialize the first time). No lock afterward — WB-04.
      if (!ks.isUnlocked()) {
        await unlockOrInitializeKeystore(ks, requirePassphrase(message.passphrase));
      }
      let privateKeyBytes;
      try {
        const keyId = message.keyId || newKeyId();
        let publicKeyBytes;
        let meta;
        if (await ks.hasSeed()) {
          // Seed account: derive the next account index deterministically from
          // the stored recovery phrase, so every key is recoverable from the
          // 12 words alone.
          const mnemonic = await ks.getSeed();
          const existing = await ks.listKeys();
          const nextIndex = existing.filter((k) => k.source === 'seed').length;
          const derived = await deriveKey(mnemonic, '', nextIndex);
          privateKeyBytes = derived.pkcs8;
          publicKeyBytes = derived.publicKey;
          meta = { source: 'seed', derivationPath: derived.path };
        } else {
          // Legacy / non-seed account: random Ed25519 key.
          const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
          privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', generated.privateKey));
          publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey));
          meta = { source: 'random', derivationPath: '' };
        }
        // Key identity (WB-09): carry the optional human label + purpose.
        meta.label = typeof message.label === 'string' ? message.label : '';
        meta.purpose = typeof message.purpose === 'string' ? message.purpose : '';
        await ks.addKey(keyId, privateKeyBytes, publicKeyBytes, meta);
        return { keyId, publicKey: bytesToHex(publicKeyBytes), algorithm: 'ed25519' };
      } finally {
        if (privateKeyBytes) privateKeyBytes.fill(0);
      }
    }

    // ---- Recovery phrase (WB-03) ----
    case 'wallet.createAccount': {
      // Onboarding: generate a fresh BIP39 phrase, store it (encrypted), derive
      // key #0, and return the phrase ONCE for the reveal-and-verify screen.
      const passphrase = requirePassphrase(message.passphrase);
      const adi = message.adi;
      if (!adi) return { error: 'adi required' };
      const ks = getKeystore();
      await unlockOrInitializeKeystore(ks, passphrase);
      try {
        const mnemonic = await generateMnemonic(128);
        await ks.setSeed(mnemonic);
        const derived = await deriveKey(mnemonic, '', 0);
        const keyId = newKeyId();
        await ks.addKey(keyId, derived.pkcs8, derived.publicKey, { source: 'seed', derivationPath: derived.path, label: 'Primary key' });
        derived.pkcs8.fill(0);
        // Leave the keystore unlocked (WB-04): the user just created it, so the
        // session is live and the dashboard lands unlocked.
        walletState.adi = adi;
        walletState.connected = true;
        saveState();
        return { mnemonic, adi, keyId, publicKey: bytesToHex(derived.publicKey) };
      } catch (err) {
        throw err;
      }
    }

    case 'wallet.restoreFromMnemonic': {
      const passphrase = requirePassphrase(message.passphrase);
      const adi = message.adi;
      const mnemonic = String(message.mnemonic || '').trim().replace(/\s+/g, ' ');
      if (!adi) return { error: 'adi required' };
      if (!(await validateMnemonic(mnemonic))) return { error: 'invalid recovery phrase' };
      const ks = getKeystore();
      await unlockOrInitializeKeystore(ks, passphrase);
      try {
        await ks.setSeed(mnemonic);
        const derived = await deriveKey(mnemonic, '', 0);
        const keyId = newKeyId();
        await ks.addKey(keyId, derived.pkcs8, derived.publicKey, { source: 'seed', derivationPath: derived.path, label: 'Primary key' });
        derived.pkcs8.fill(0);
        // Leave unlocked (WB-04): restore lands the dashboard unlocked.
        walletState.adi = adi;
        walletState.connected = true;
        saveState();
        return { restored: true, adi, keyId, publicKey: bytesToHex(derived.publicKey) };
      } catch (err) {
        throw err;
      }
    }

    case 'wallet.revealMnemonic': {
      // Re-auth-gated: the user must re-enter the passphrase to view the phrase
      // (verified by unlock), even within an open session. Never logged;
      // returned once for the reveal screen. On success the session stays
      // unlocked (the unlock above proved the passphrase); only a failed reveal
      // locks.
      const passphrase = requirePassphrase(message.passphrase);
      const ks = getKeystore();
      try {
        await ks.unlock(passphrase);
        const mnemonic = await ks.getSeed();
        return { mnemonic };
      } catch (err) {
        ks.lock();
        return { error: String(err.message || err).includes('invalid passphrase') ? 'invalid passphrase' : (err.message || 'reveal failed') };
      }
    }

    // ---- Unlock session (WB-04) ----
    // Derive the wrapping key ONCE and keep the keystore unlocked for a bounded,
    // user-visible idle window, so signing is instant (no 600k PBKDF2 per
    // signature). The idle timer (or SW eviction, or an explicit lock) ends the
    // session. No secret is ever persisted across eviction.
    case 'wallet.unlock': {
      const passphrase = requirePassphrase(message.passphrase);
      const ks = getKeystore();
      await ks.unlock(passphrase); // throws 'invalid passphrase' on mismatch
      return { unlocked: true, remainingMs: ks.remainingMs(), idleTimeoutMs: ks.idleTimeoutMs };
    }

    case 'wallet.lock': {
      getKeystore().lock();
      return { unlocked: false };
    }

    // Change passphrase (WB-05): re-encrypt every key + the recovery-phrase
    // record under a new passphrase. rotate() verifies the current passphrase
    // first (atomic — a wrong current never writes) and leaves the keystore
    // unlocked under the new key.
    case 'wallet.rotatePassphrase': {
      const oldPass = message.oldPassphrase;
      const newPass = message.newPassphrase;
      if (typeof oldPass !== 'string' || oldPass.length === 0) return { error: 'current passphrase required' };
      if (typeof newPass !== 'string' || newPass.length === 0) return { error: 'new passphrase required' };
      if (oldPass === newPass) return { error: 'new passphrase must differ from the current one' };
      try {
        await getKeystore().rotate(oldPass, newPass);
        const keys = await listStoredKeys();
        return { rotated: true, keyCount: keys.length };
      } catch (err) {
        const msg = String(err.message || err);
        return { error: msg.includes('invalid passphrase') ? 'current passphrase is incorrect' : msg };
      }
    }

    case 'wallet.lockStatus': {
      const ks = getKeystore();
      return { unlocked: ks.isUnlocked(), remainingMs: ks.remainingMs(), idleTimeoutMs: ks.idleTimeoutMs };
    }

    case 'wallet.setIdleTimeout': {
      const ms = Number(message.ms);
      // Clamp to [1 min, 1 hour].
      const clamped = Math.max(60_000, Math.min(3_600_000, Number.isFinite(ms) ? ms : 15 * 60_000));
      getKeystore().setIdleTimeout(clamped);
      return { idleTimeoutMs: clamped };
    }

    // ---- Signer seam (WB-06) ----
    // Split "produce a signature" from "assemble + submit the approval", so a
    // signature can come from the software keystore OR a hardware device (the
    // popup, where WebHID/WebAuthn live), while the background remains the sole
    // assembler/submitter of the approval envelope.

    // previewSignaturePayload returns the canonical bytes the user/device will
    // sign — the single source of truth (also surfaced in the UI by WB-10).
    case 'wallet.previewSignaturePayload': {
      try {
        const signerIdentity = walletState.adi;
        const payload = approvalSignaturePayload(message.intentId, message.planHash, signerIdentity);
        return { payload, signerIdentity };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    }

    // signPayload produces a detached Ed25519 signature over the EXACT payload
    // bytes using the unlocked software keystore. It never assembles an
    // envelope. (Hardware signing happens in the popup, not here.)
    case 'wallet.signPayload': {
      if (typeof message.payload !== 'string' || message.payload.length === 0) {
        return { error: 'payload required' };
      }
      const sig = await signWithStoredKey({
        passphrase: message.passphrase,
        message: message.payload,
        keyId: message.keyId,
        publicKey: message.publicKey,
      });
      return { signature: sig.signature, publicKey: sig.publicKey, algorithm: sig.algorithm, keyId: sig.keyId };
    }

    // submitApproval assembles the approval envelope from a signature produced
    // anywhere (software or hardware) and submits it. When a queued requestId is
    // supplied it applies the same confused-deputy plan-hash guard as
    // approveRequest before submitting.
    case 'wallet.submitApproval': {
      if (message.requestId != null) {
        const req = walletState.pendingRequests.get(message.requestId);
        if (req) {
          const requestHash = req.params && (req.params.planHash || (req.params.plan && req.params.plan.hash));
          if (requestHash && message.planHash !== requestHash) {
            return { error: 'Plan hash mismatch — popup submitted a different plan than the one queued (aborted to prevent confused-deputy attack)' };
          }
          walletState.pendingRequests.delete(message.requestId);
        }
      }
      return submitApprovalEnvelope({
        intentId: message.intentId,
        planHash: message.planHash,
        signerIdentity: message.signerIdentity || walletState.adi,
        signerPublicKey: message.signerPublicKey,
        signature: message.signature,
        signatureAlgorithm: message.signatureAlgorithm || 'ed25519',
        signaturePayload: message.signaturePayload,
      });
    }

    case 'wallet.listKeys':
      return { keys: await listStoredKeys() };

    // Rename a key's human label (WB-09). Metadata-only — no key decryption,
    // so no unlock is required.
    case 'wallet.renameKey': {
      if (!message.keyId) return { error: 'keyId required' };
      const ok = await getKeystore().setKeyLabel(message.keyId, message.label || '');
      return { renamed: ok };
    }

    // Verify a passphrase without performing a signing operation, so the popup
    // can implement an explicit unlock with immediate feedback on a wrong
    // passphrase (rather than failing only at sign time). A not-yet-initialized
    // keystore (fresh wallet, no keys) accepts any passphrase — the first
    // generateKey initializes the keystore with it.
    case 'wallet.verifyPassphrase': {
      const passphrase = message.passphrase;
      if (typeof passphrase !== 'string' || passphrase.length === 0) {
        return { ok: false, error: 'wallet passphrase required' };
      }
      const ks = getKeystore();
      try {
        await ks.unlock(passphrase);
        ks.lock();
        return { ok: true };
      } catch (err) {
        if (String(err.message || err).includes('keystore not initialized')) {
          return { ok: true, uninitialized: true };
        }
        return { ok: false, error: err.message };
      }
    }

    case 'wallet.deleteKey': {
      const ks = getKeystore();
      await ensureUnlocked(ks, message.passphrase); // session or passphrase; no lock after (WB-04)
      const keys = await listStoredKeys();
      const key = keys.find(k => k.keyId === message.keyId || k.publicKey === message.publicKey);
      if (!key) return { deleted: false };
      const deleted = await ks.deleteKey(key.keyId);
      return { deleted };
    }

    // ---- Backup / Restore (WB-02) ----
    // The stored keystore is already AES-GCM encrypted under the passphrase, so
    // a backup is the ciphertext store handed to the user as a file. It never
    // contains a plaintext key or the passphrase. The ADI is public and is
    // included so a restore is complete.
    case 'wallet.exportBackup': {
      const store = await getKeystore().exportStore();
      if (!store) return { error: 'nothing to back up: no keystore yet' };
      walletState.backedUpAt = new Date().toISOString();
      saveState();
      return {
        backup: {
          format: 'infrix-keystore-backup',
          formatVersion: 1,
          exportedAt: walletState.backedUpAt,
          adi: walletState.adi || '',
          store,
        },
      };
    }

    // Mark the account as backed up (e.g. the user wrote down + confirmed their
    // recovery phrase, which is itself a complete backup) so the nudge clears.
    case 'wallet.markBackedUp': {
      walletState.backedUpAt = walletState.backedUpAt || new Date().toISOString();
      saveState();
      return { backedUpAt: walletState.backedUpAt };
    }

    case 'wallet.importBackup': {
      const backup = message.backup;
      if (!backup || backup.format !== 'infrix-keystore-backup' || !backup.store) {
        return { error: 'not a valid Infrix backup file' };
      }
      const existing = await getKeystore().exportStore();
      const hasKeys = existing && Array.isArray(existing.keys) && existing.keys.length > 0;
      if (hasKeys && !message.overwrite) {
        // Refuse to clobber an existing keystore unless explicitly confirmed.
        return { error: 'a keystore already exists on this device', needsOverwrite: true };
      }
      try {
        await getKeystore().importStore(backup.store);
      } catch (e) {
        return { error: e.message || String(e) };
      }
      encryptedKeystore = null; // force reload of the freshly-written store
      if (backup.adi) {
        walletState.adi = backup.adi;
        walletState.connected = true;
      }
      // A restored store is, by definition, already backed up.
      walletState.backedUpAt = walletState.backedUpAt || new Date().toISOString();
      saveState();
      const keys = await listStoredKeys();
      return { imported: true, keyCount: keys.length, adi: walletState.adi };
    }

    // ---- Transaction Signing ----
    case 'wallet.sign': {
      return signWithStoredKey({
        passphrase: message.passphrase,
        message: message.message ?? message.payload,
        keyId: message.keyId,
        publicKey: message.publicKey,
      });
    }

    // ---- Governance Submission (RPC Proxy) ----
    // State-changing actions (including contract deploy/call) flow through
    // the governance spine as intents; there is no raw contract proxy.
    //
    // P2-003 closure: augmentDisclosureContext stamps actor/purpose/
    // workflowInstance on every governed RPC submission, including
    // direct wallet.submitIntent calls. The Gap 12 disclosure gate on
    // governed read endpoints rejects bare submissions with 400; the
    // augmentation here is the governance spine's required envelope on
    // every wallet-originated RPC, not just popup-driven plan reads.
    case 'wallet.submitIntent': {
      const params = augmentDisclosureContext({
        userAddress: walletState.adi,
        goal: message.goal,
        ...(message.opts || {}),
      });
      return rpcProxy('intent.submit', params);
    }

    case 'wallet.approveIntent': {
      // P3 #20 closure: dApp approval requests MUST route through
      // the user-prompt queue, NOT auto-submit. Pre-closure this
      // handler auto-submitted approval.submit on the dApp's behalf
      // without ANY user interaction — a confused-deputy attack
      // vector where a malicious page could ratify plans the user
      // never saw. Post-closure, the request is queued as a pending
      // approval; the popup renders it through PlanApprovalView
      // (showing steps + sim hash + trust profiles); only after the
      // user clicks "Sign & approve" does background.js call
      // approval.submit (in the wallet.approveRequest case arm).
      const id = nextRequestId++;
      const request = {
        id,
        type: 'approveIntent',
        origin: (sender && sender.origin) || (sender && sender.url) || 'unknown',
        params: {
          intentId: message.intentId,
          planHash: message.planHash,
        },
      };
      walletState.pendingRequests.set(id, request);
      return { queued: true, requestId: id };
    }

    // ---- Session Keys ----
    case 'wallet.createSession': {
      const session = {
        publicKey: generateRandomHex(64),
        scope: message.scope,
        createdAt: new Date().toISOString(),
        usesLeft: message.scope.maxUses || -1,
      };
      walletState.sessions.push(session);
      saveState();
      return { session };
    }

    case 'wallet.listSessions':
      return { sessions: walletState.sessions };

    case 'wallet.revokeSession': {
      walletState.sessions = walletState.sessions.filter(s => s.publicKey !== message.publicKey);
      saveState();
      return { revoked: true };
    }

    case 'wallet.validateSession': {
      const session = walletState.sessions.find(s => s.publicKey === message.publicKey);
      if (!session) return { valid: false, error: 'Session not found' };
      if (session.usesLeft === 0) return { valid: false, error: 'No remaining uses' };
      if (session.scope.expiresAt && new Date() > new Date(session.scope.expiresAt)) {
        return { valid: false, error: 'Session expired' };
      }
      if (session.scope.contracts && session.scope.contracts.length > 0) {
        if (!session.scope.contracts.includes(message.contractUrl)) {
          return { valid: false, error: 'Contract not allowed' };
        }
      }
      if (session.scope.functions && session.scope.functions.length > 0) {
        if (!session.scope.functions.includes(message.function)) {
          return { valid: false, error: 'Function not allowed' };
        }
      }
      return { valid: true };
    }

    // ---- Approval Flow ----
    case 'wallet.requestApproval': {
      // Store pending request for the popup to approve/reject.
      const requestId = nextRequestId++;
      walletState.pendingRequests.set(requestId, {
        id: requestId,
        type: message.requestType,
        params: message.params,
        origin: sender.origin || sender.url,
        timestamp: Date.now(),
      });
      return { requestId, status: 'pending' };
    }

    case 'wallet.approveRequest': {
      const req = walletState.pendingRequests.get(message.requestId);
      if (!req) return { error: 'Request not found' };
      // P3 #20: when the popup supplies a planHash (the canonical
      // simulation-binding the user just signed off on), validate it
      // matches the request's planHash before completing the
      // approval. Mismatched hashes mean the popup rendered a
      // different plan than the one the dApp originally submitted —
      // refuse to sign.
      if (message.planHash) {
        const requestHash = req.params && (req.params.planHash || (req.params.plan && req.params.plan.hash));
        if (requestHash && message.planHash !== requestHash) {
          return { error: 'Plan hash mismatch — popup rendered a different plan than the one queued (signing aborted to prevent confused-deputy attack)' };
        }
        req.signedPlanHash = message.planHash;
      }
      walletState.pendingRequests.delete(message.requestId);
      // Execute the approved request. The wallet supports two
      // governance-submission shapes:
      //   - submitIntent: forward the original intent payload to
      //     intent.submit (the canonical spine entrypoint).
      //   - approveIntent: submit an ApprovalEnvelope to
      //     approval.submit so the plan-hash signature reaches the
      //     governance pipeline.
      if (req.type === 'submitIntent') {
        return rpcProxy('intent.submit', augmentDisclosureContext(req.params || {}));
      }
      if (req.type === 'approveIntent' || req.type === 'wallet.approveIntent' || req.type === 'approval.signPlan') {
        const intentId = req.params && req.params.intentId;
        const planHash = req.signedPlanHash || (req.params && req.params.planHash);
        const signaturePayload = approvalSignaturePayload(intentId, planHash, walletState.adi);
        const signature = await signWithStoredKey({
          passphrase: message.passphrase,
          message: signaturePayload,
          keyId: message.keyId,
          publicKey: message.publicKey,
        });
        // WB-06: share the one envelope-assembly + submit path with the
        // popup-orchestrated signer (wallet.submitApproval), so software and
        // hardware approvals are wire-identical.
        return submitApprovalEnvelope({
          intentId,
          planHash,
          signerIdentity: walletState.adi,
          signerPublicKey: signature.publicKey,
          signature: signature.signature,
          signatureAlgorithm: signature.algorithm,
          signaturePayload,
        });
      }
      return { approved: true, signedPlanHash: req.signedPlanHash || null };
    }

    case 'wallet.rejectRequest': {
      walletState.pendingRequests.delete(message.requestId);
      return { rejected: true };
    }

    case 'wallet.getPendingRequests': {
      const pending = [];
      walletState.pendingRequests.forEach((v, k) => pending.push(v));
      return { requests: pending, rpcUrl: walletState.rpcUrl };
    }

    // P3 #20: generic RPC proxy for popup-side renderers that need
    // to fetch plan detail (intent.plan, objects.list, approval.get,
    // etc.) The background service worker has the host_permissions
    // for arbitrary devnet endpoints; the popup does not. Every
    // governed RPC method requires a disclosure context — the
    // background stamps the wallet's ADI as actor and "wallet-plan-
    // approval" as purpose so audit trails attribute the read to
    // the wallet's signing flow.
    case 'wallet.rpc': {
      try {
        const params = augmentDisclosureContext(message.params || {});
        const result = await rpcProxy(message.method, params);
        return { result };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    }

    // P2-003 test-harness hook. Test-only reset path used by the
    // node --test integration suite (extension/tests/) so each test
    // can start from a known walletState without subprocess spawning.
    // Production callers never send this — Chrome's content script
    // does not expose it on window.infrix, the popup does not call
    // it, and the message type begins with "__" by convention to
    // mark it as private.
    case 'wallet.__resetState': {
      walletState.adi = (message.state && message.state.adi) || '';
      walletState.rpcUrl = (message.state && message.state.rpcUrl) || 'http://localhost:8080/rpc';
      walletState.keys = [];
      walletState.sessions = [];
      walletState.sponsors = [];
      walletState.connected = !!(message.state && message.state.adi);
      walletState.pendingRequests = new Map();
      encryptedKeystore = null;
      nextRequestId = 1;
      saveState();
      return { reset: true };
    }

    default:
      return { error: 'Unknown message type: ' + message.type };
  }
}

/**
 * augmentDisclosureContext stamps the wallet's ADI as the disclosure
 * actor + a purpose marker on every RPC call from the popup. Most
 * governed read methods (intent.plan, objects.list, approval.get)
 * require these headers/params under the Gap 12 disclosure gate.
 *
 * P3 #20: the wallet running locally on the operator's machine
 * is the canonical caller for plan-approval reads; recording its
 * ADI lets audit trails distinguish wallet-driven approval reads
 * from cinema viewers, RPC clients, and other consumers.
 */
function augmentDisclosureContext(params) {
  const out = Object.assign({}, params);
  if (!out.actor && walletState.adi) out.actor = walletState.adi;
  if (!out.purpose) out.purpose = 'wallet-plan-approval';
  if (!out.workflowInstance) out.workflowInstance = 'wallet-plan-approval-' + Date.now();
  return out;
}

function getKeystore() {
  if (!encryptedKeystore) {
    encryptedKeystore = new EncryptedKeystore(chromeStorageAdapter());
  }
  return encryptedKeystore;
}

/**
 * ensureUnlocked is the WB-04 session gate. If the keystore is already unlocked
 * (an active session), it returns immediately — no re-derivation, instant
 * signing. If locked, it unlocks with the supplied passphrase (unlock-on-demand
 * for callers that still pass one). If locked and no passphrase is available, it
 * throws a typed WALLET_LOCKED so the popup can prompt the user to unlock rather
 * than failing opaquely. It never locks afterward — the idle timer, an explicit
 * wallet.lock, or SW eviction ends the session.
 */
async function ensureUnlocked(ks, passphrase) {
  if (ks.isUnlocked()) return;
  if (typeof passphrase === 'string' && passphrase.length > 0) {
    await ks.unlock(passphrase);
    return;
  }
  const err = new Error('wallet is locked');
  err.code = 'WALLET_LOCKED';
  throw err;
}

function chromeStorageAdapter() {
  return {
    get(key) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get([key], result => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(result);
        });
      });
    },
    set(obj) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set(obj, () => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      });
    },
  };
}

async function unlockOrInitializeKeystore(ks, passphrase) {
  try {
    await ks.unlock(passphrase);
  } catch (err) {
    if (String(err.message || err).includes('keystore not initialized')) {
      await ks.initialize(passphrase);
      return;
    }
    throw err;
  }
}

async function listStoredKeys() {
  const keys = await getKeystore().listKeys();
  return keys.map(k => ({
    keyId: k.keyId,
    publicKey: bytesToHex(k.pubKey),
    algorithm: 'ed25519',
    createdAt: k.createdAt,
    source: k.source || 'random',
    derivationPath: k.derivationPath || '',
    label: k.label || '',
    purpose: k.purpose || '',
    lastUsedAt: k.lastUsedAt || '',
  }));
}

function selectSigningKey(keys, keyId, publicKey) {
  if (keys.length === 0) throw new Error('no signing keys available');
  if (!keyId && !publicKey) return keys[0];
  const selected = keys.find(k => k.keyId === keyId || k.publicKey === publicKey);
  if (!selected) throw new Error('signing key not found');
  return selected;
}

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('wallet passphrase required');
  }
  return passphrase;
}

async function signWithStoredKey({ passphrase, message, keyId, publicKey }) {
  const messageBytes = signableMessageBytes(message);
  const ks = getKeystore();
  // WB-04: use the unlocked session if one is open (instant, no re-derive);
  // otherwise unlock-on-demand with the supplied passphrase, or throw
  // WALLET_LOCKED. We do NOT lock afterward — the idle timer / explicit lock /
  // SW eviction ends the session.
  await ensureUnlocked(ks, passphrase);
  let privateKeyBytes;
  try {
    const keys = await listStoredKeys();
    const selected = selectSigningKey(keys, keyId, publicKey);
    privateKeyBytes = await ks.getKey(selected.keyId);
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      messageBytes,
    ));
    return {
      keyId: selected.keyId,
      publicKey: selected.publicKey,
      algorithm: 'ed25519',
      signature: bytesToHex(signature),
    };
  } finally {
    if (privateKeyBytes) privateKeyBytes.fill(0);
    // No ks.lock() — the session persists for the idle window.
  }
}

function signableMessageBytes(message) {
  if (typeof message !== 'string') {
    throw new Error('wallet.sign requires a string message');
  }
  if (/^0x[0-9a-fA-F]*$/.test(message)) {
    return hexToBytes(message.slice(2));
  }
  return new TextEncoder().encode(message);
}

function approvalSignaturePayload(intentId, planHash, signerIdentity) {
  if (!intentId) throw new Error('approval signature requires intentId');
  if (!planHash) throw new Error('approval signature requires planHash');
  if (!signerIdentity) throw new Error('approval signature requires signer identity');
  return ['infrix-approval-v1', intentId, planHash, signerIdentity].join(':');
}

// submitApprovalEnvelope is the single approval-submission chokepoint (WB-06):
// it stamps the disclosure envelope and POSTs approval.submit. Both the queued
// software path (wallet.approveRequest) and the popup-orchestrated path
// (wallet.submitApproval, used by hardware signers) funnel through here, so the
// wire shape is identical regardless of where the signature came from.
function submitApprovalEnvelope({ intentId, planHash, signerIdentity, signerPublicKey, signature, signatureAlgorithm, signaturePayload }) {
  const params = augmentDisclosureContext({
    intentId,
    planHash,
    signerIdentity,
    signerPublicKey,
    signature,
    signatureAlgorithm: signatureAlgorithm || 'ed25519',
    signaturePayload,
  });
  return rpcProxy('approval.submit', params);
}

// ---- RPC Proxy ----

async function rpcProxy(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() });
  const res = await fetch(walletState.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ---- Helpers ----

// newKeyId returns a collision-free key id. A bare Date.now() collides when two
// keys are created in the same millisecond — which the WB-04 instant-signing
// session made reachable (no 600k PBKDF2 between key creations to advance the
// clock). The random suffix makes it unique regardless.
function newKeyId() {
  return 'key_' + Date.now().toString(36) + '_' + generateRandomHex(8);
}

function generateRandomHex(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('hex message must have an even number of digits');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
