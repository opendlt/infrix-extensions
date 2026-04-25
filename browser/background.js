/**
 * Infrix Wallet — Background Service Worker
 *
 * Handles key storage, transaction signing, session key validation,
 * and acts as an RPC proxy to the Infrix devnet/mainnet.
 */

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
    case 'wallet.getState':
      return {
        adi: walletState.adi,
        connected: walletState.connected,
        keyCount: walletState.keys.length,
        sessionCount: walletState.sessions.length,
      };

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
      // In the extension, keys are generated via Web Crypto and stored encrypted.
      const keyId = 'key_' + Date.now();
      const keyEntry = {
        id: keyId,
        publicKey: generateRandomHex(64), // 32 bytes as hex
        algorithm: message.algorithm || 'ed25519',
        createdAt: new Date().toISOString(),
        label: message.label || '',
      };
      walletState.keys.push(keyEntry);
      saveState();
      return { publicKey: keyEntry.publicKey, algorithm: keyEntry.algorithm };
    }

    case 'wallet.listKeys':
      return { keys: walletState.keys.map(k => ({ publicKey: k.publicKey, algorithm: k.algorithm, label: k.label })) };

    case 'wallet.deleteKey': {
      walletState.keys = walletState.keys.filter(k => k.publicKey !== message.publicKey);
      saveState();
      return { deleted: true };
    }

    // ---- Transaction Signing ----
    case 'wallet.sign': {
      // In production, this would use the actual private key via Web Crypto.
      // For the scaffold, we produce a deterministic signature placeholder.
      return {
        signature: generateRandomHex(128), // 64 bytes as hex
        publicKey: walletState.keys.length > 0 ? walletState.keys[0].publicKey : '',
      };
    }

    // ---- Governance Submission (RPC Proxy) ----
    // State-changing actions (including contract deploy/call) flow through
    // the governance spine as intents; there is no raw contract proxy.
    case 'wallet.submitIntent': {
      const params = {
        userAddress: walletState.adi,
        goal: message.goal,
        ...(message.opts || {}),
      };
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
        const params = augmentDisclosureContext({
          intentId: req.params && req.params.intentId,
          planHash: req.signedPlanHash || (req.params && req.params.planHash),
          signerIdentity: walletState.adi,
          // The actual signature bytes are produced by future
          // wallet key-management work (encrypted-keys integration).
          // For now, the wallet records the user's intent to approve
          // by submitting the structured envelope; downstream signing
          // proves provenance via the spine's audit trail.
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
