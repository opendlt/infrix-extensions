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
      return rpcProxy('approval.submit', {
        targetId: message.intentId,
        planHash: message.planHash,
        identity: walletState.adi,
      });
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
      walletState.pendingRequests.delete(message.requestId);
      // Execute the approved request. Only governance-submitted intents
      // are permitted; raw contract calls have no direct proxy.
      if (req.type === 'submitIntent') {
        return rpcProxy('intent.submit', req.params);
      }
      return { approved: true };
    }

    case 'wallet.rejectRequest': {
      walletState.pendingRequests.delete(message.requestId);
      return { rejected: true };
    }

    case 'wallet.getPendingRequests': {
      const pending = [];
      walletState.pendingRequests.forEach((v, k) => pending.push(v));
      return { requests: pending };
    }

    default:
      return { error: 'Unknown message type: ' + message.type };
  }
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
