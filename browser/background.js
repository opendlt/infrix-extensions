/**
 * Infrix Wallet — Background Service Worker
 *
 * Handles key storage, transaction signing, session key validation,
 * and acts as an RPC proxy to the Infrix devnet/mainnet.
 */

import { EncryptedKeystore } from './wallet/keystore.js';

// ---- State ----

let walletState = {
  adi: '',
  rpcUrl: 'http://localhost:8080/rpc',
  keys: [],         // { publicKey: hex, algorithm: string, createdAt: string }
  sessions: [],     // { publicKey: hex, scope: {...}, createdAt: string, usesLeft: number }
  sponsors: [],     // { sponsorAdi: string, ... }
  connected: false,
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
    sendResponse({ error: err.message });
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
      const passphrase = requirePassphrase(message.passphrase);
      const ks = getKeystore();
      await unlockOrInitializeKeystore(ks, passphrase);
      try {
        const generated = await crypto.subtle.generateKey(
          { name: 'Ed25519' },
          true,
          ['sign', 'verify'],
        );
        const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', generated.privateKey));
        const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey));
        const keyId = message.keyId || 'key_' + Date.now();
        await ks.addKey(keyId, privateKeyBytes, publicKeyBytes);
        privateKeyBytes.fill(0);
        ks.lock();
        return {
          keyId,
          publicKey: bytesToHex(publicKeyBytes),
          algorithm: 'ed25519',
        };
      } catch (err) {
        ks.lock();
        throw err;
      }
    }

    case 'wallet.listKeys':
      return { keys: await listStoredKeys() };

    case 'wallet.deleteKey': {
      const passphrase = requirePassphrase(message.passphrase);
      const ks = getKeystore();
      await ks.unlock(passphrase);
      const keys = await listStoredKeys();
      const key = keys.find(k => k.keyId === message.keyId || k.publicKey === message.publicKey);
      if (!key) {
        ks.lock();
        return { deleted: false };
      }
      const deleted = await ks.deleteKey(key.keyId);
      ks.lock();
      return { deleted };
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
        const planHash = req.signedPlanHash || (req.params && req.params.planHash);
        const signaturePayload = approvalSignaturePayload(req.params && req.params.intentId, planHash, walletState.adi);
        const signature = await signWithStoredKey({
          passphrase: message.passphrase,
          message: signaturePayload,
          keyId: message.keyId,
          publicKey: message.publicKey,
        });
        const params = augmentDisclosureContext({
          intentId: req.params && req.params.intentId,
          planHash,
          signerIdentity: walletState.adi,
          signerPublicKey: signature.publicKey,
          signature: signature.signature,
          signatureAlgorithm: signature.algorithm,
          signaturePayload,
        });
        return rpcProxy('approval.submit', params);
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
  const checkedPassphrase = requirePassphrase(passphrase);
  const messageBytes = signableMessageBytes(message);
  const ks = getKeystore();
  await ks.unlock(checkedPassphrase);
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
    ks.lock();
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
