// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// P2-003 test harness for the Chrome MV3 service-worker entry point
// (extension/background.js). The service-worker module reads / writes
// chrome.storage.local, registers a chrome.runtime.onMessage listener
// at module-load time, and uses globalThis.fetch + globalThis.crypto.
// Node 22's global fetch + globalThis.crypto satisfy two of the three;
// the chrome.* API surface is shimmed in-process here so the
// background module can be imported and exercised under `node --test`
// without touching the extension source.
//
// Usage:
//
//   import { loadBackground, postMessage, lastFetch, resetFetchHistory }
//     from './harness.mjs';
//
//   const bg = await loadBackground({ rpcUrl: 'http://...', adi: 'acc://...' });
//   const reply = await postMessage({ type: 'wallet.submitIntent', goal: ... });
//
// The harness provides:
//   * a captured chrome.runtime.onMessage listener (postMessage()
//     drives it directly with a Promise-resolving sendResponse);
//   * a chrome.storage.local in-memory backing store;
//   * a globalThis.fetch interceptor recording every outbound request
//     so integration tests can assert payload shape (lastFetch()).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.dirname(here);

let _onMessage = null;
let _storage = {};
let _fetchHistory = [];
let _fetchHandler = null;

// Capture Node's built-in fetch at module load. installFetchStub
// replaces globalThis.fetch with a recording stub; restoreRealFetch
// puts the built-in back so integration tests can hit a real http
// server. Without this, deleting globalThis.fetch would leave it
// undefined (Node's built-in is a normal property, not a getter).
const _builtInFetch = globalThis.fetch;

/**
 * Replace globalThis.fetch with a recording stub. If `handler` is
 * non-null it owns the response (must return a Response-shaped
 * object). Otherwise calls return a 200 OK with an empty JSON-RPC
 * envelope so background.js does not crash on the json() decode.
 */
export function installFetchStub(handler) {
  _fetchHandler = handler;
  _fetchHistory = [];
  globalThis.fetch = async (url, init) => {
    let parsedBody = null;
    if (init && init.body) {
      try { parsedBody = JSON.parse(init.body); } catch { /* leave null */ }
    }
    const entry = { url, init, body: parsedBody };
    _fetchHistory.push(entry);
    if (_fetchHandler) {
      return _fetchHandler(entry);
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: parsedBody && parsedBody.id, result: { ok: true } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

/**
 * Return the recorded fetch history (oldest first). Each entry has
 * { url, init, body } where body is the parsed JSON request body or
 * null. Tests typically assert lastFetch().body.method and
 * lastFetch().body.params.
 */
export function fetchHistory() {
  return _fetchHistory.slice();
}

/**
 * Convenience accessor for the most recent fetch.
 */
export function lastFetch() {
  return _fetchHistory[_fetchHistory.length - 1] || null;
}

/**
 * Reset the captured fetch history without uninstalling the stub.
 */
export function resetFetchHistory() {
  _fetchHistory = [];
}

/**
 * Restore the built-in Node fetch captured at harness load. Used by
 * integration tests that bring up a real http.Server and want
 * background.js to actually hit it instead of the recording stub.
 */
export function restoreRealFetch() {
  if (_builtInFetch) {
    globalThis.fetch = _builtInFetch;
  } else {
    delete globalThis.fetch;
  }
  _fetchHandler = null;
  _fetchHistory = [];
}

/**
 * Install the chrome.* shim and load extension/background.js under it.
 * Returns the captured onMessage listener so callers can drive
 * it directly. Pass a `state` object to seed walletState fields
 * (adi, rpcUrl, etc.) before background.js initialises.
 *
 * Background.js executes its `chrome.storage.local.get(['walletState'],
 * cb)` call at module load; the shim returns the seeded state via
 * that callback so the module-level walletState is populated by the
 * time the test sends its first message.
 *
 * Background.js is loaded ONCE per process (Node caches dynamic
 * imports by file path; query-string cache busting is unreliable
 * across versions). To support multiple tests in the same file,
 * loadBackground sends a wallet.__resetState message AFTER the
 * module is loaded, which clobbers the module-level walletState
 * with the supplied seed. This is a test-only path; production
 * callers never send wallet.__resetState (it's not on window.infrix
 * and the popup does not invoke it).
 */
export async function loadBackground(state = {}) {
  _storage = { walletState: { ...state } };

  const onMessageListeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
          for (const k of list) if (k in _storage) result[k] = _storage[k];
          // Chrome's storage callbacks are async; mimic that to avoid
          // ordering surprises for code that relies on the microtask gap.
          queueMicrotask(() => cb(result));
        },
        set(obj, cb) {
          Object.assign(_storage, obj);
          if (cb) queueMicrotask(cb);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(fn) {
          onMessageListeners.push(fn);
          // Always promote the latest listener to the harness's
          // active handler. Each loadBackground() call may reload
          // the background module under a cache-busting URL; the
          // newest registration owns its fresh module-level state.
          _onMessage = fn;
        },
      },
      lastError: null,
      sendMessage(_msg, cb) { if (cb) cb({ error: 'no peer in test harness' }); },
    },
  };
  if (!globalThis.crypto) {
    const { webcrypto } = await import('node:crypto');
    globalThis.crypto = webcrypto;
  }
  if (!globalThis.fetch) {
    installFetchStub();
  }

  // Background.js loads ONCE per process. The chrome.runtime.onMessage
  // listener is registered the first time and never re-registers
  // (Node caches the module by file path; query-string busting was
  // unreliable). On subsequent loadBackground() calls, the listener
  // is already there.
  if (!_onMessage) {
    const url = new URL('../background.js', import.meta.url);
    await import(url.href);
    // Wait one microtask flush so the storage.get callback has run
    // and populated walletState before the test posts its first
    // message.
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));
  }
  // Always reset module-level state to the requested seed so each
  // test starts from a known baseline regardless of prior test
  // residue. wallet.__resetState is the harness-only reset hook.
  await new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (r) => { if (settled) return; settled = true; resolve(r); };
    try {
      _onMessage({ type: 'wallet.__resetState', state }, {}, sendResponse);
    } catch (err) { if (!settled) reject(err); }
  });
  return { onMessage: _onMessage, storage: _storage, listeners: onMessageListeners };
}

/**
 * Drive the background.js onMessage listener with `message`. Returns
 * a Promise that resolves with the response object or rejects if
 * the listener throws.
 */
export async function postMessage(message, sender = {}) {
  if (!_onMessage) {
    throw new Error('background.js not loaded; call loadBackground() first');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      _onMessage(message, sender, sendResponse);
    } catch (err) {
      if (!settled) reject(err);
    }
  });
}

/**
 * Read the source of an extension JS file relative to the extension
 * root, so tests that statically scan content.js / popup.js can
 * share the same loader.
 */
export async function readExtensionFile(rel) {
  const full = path.join(extensionRoot, rel);
  return readFile(full, 'utf8');
}

/**
 * Compile + run a JS source string in a fresh VM sandbox so a test
 * can introspect the in-page provider object as the dApp would see
 * it. Used by the content.test.mjs fence to confirm window.infrix is
 * exactly the canonical surface.
 */
export function evalContentScriptInWindowSandbox(source) {
  const sandbox = {
    window: {},
    document: { dispatchEvent() {} },
    chrome: undefined, // content script falls into its non-extension path
    CustomEvent: class { constructor(name, opts) { this.type = name; this.detail = opts && opts.detail; } },
    setTimeout,
    clearTimeout,
    Promise,
  };
  sandbox.window.dispatchEvent = sandbox.document.dispatchEvent;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'content.js' });
  return sandbox.window;
}

export const ExtensionRoot = extensionRoot;
