// Popup boot smoke test.
//
// The popup is plain DOM JS with no unit-test seams, so we boot it the way the
// browser does: load api.js → plan-approval.js → popup.js in a vm sandbox with
// a forgiving DOM + chrome.runtime + fetch shim, fire DOMContentLoaded, and
// assert the controller boots and runs a full dashboard refresh cycle WITHOUT
// throwing. This catches load-time reference errors and crashes in
// init/refreshState/render paths that lint cannot see — exactly the class of
// bug a heavy popup rewrite risks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readExtensionFile } from './harness.mjs';

// A permissive element stub: every property access that the popup might touch
// resolves to something callable/usable, and unknown element ids still return a
// usable element. This makes the boot resilient to exact-id coupling while
// still exercising the real control flow.
function makeEl() {
  const el = {
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', hidden: false, title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild() {}, append() {}, removeChild() {}, focus() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getContext() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 180 }; },
  };
  return el;
}

function boot(messageResponder) {
  const errors = [];
  const els = new Map();
  const document = {
    addEventListener(type, cb) { if (type === 'DOMContentLoaded') this._dcl = cb; },
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    head: makeEl(), body: makeEl(),
  };
  const sandbox = {
    window: {}, document, module: undefined, console,
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    location: { search: '' },
    fetch: async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ data: {} }) }),
    chrome: {
      runtime: {
        sendMessage(msg, cb) { Promise.resolve(messageResponder(msg)).then((r) => cb(r)); },
        getURL(p) { return 'chrome-extension://test/' + p; },
        lastError: null,
      },
      tabs: { create() {} },
    },
  };
  sandbox.window = sandbox; // popup scripts attach to window === global
  vm.createContext(sandbox);
  return { sandbox, document, errors };
}

async function loadPopup(sandbox) {
  for (const f of ['popup/api.js', 'popup/plan-approval.js', 'popup/popup.js']) {
    const src = await readExtensionFile(f);
    vm.runInContext(src, sandbox, { filename: f });
  }
}

test('popup boots into onboarding when no ADI is configured', async () => {
  const { sandbox, document } = boot((msg) => {
    if (msg.type === 'wallet.getState') return { adi: '', rpcUrl: 'http://localhost:8080/rpc' };
    if (msg.type === 'wallet.getPendingRequests') return { requests: [], rpcUrl: 'http://localhost:8080/rpc' };
    return {};
  });
  await loadPopup(sandbox);
  await document._dcl();            // fire DOMContentLoaded → init()
  await new Promise((r) => setTimeout(r, 10));
  // Onboarding view shown, dashboard hidden.
  assert.equal(document.getElementById('onboardingView').hidden, false);
  assert.equal(document.getElementById('dashboardView').hidden, true);
  // Required globals wired.
  assert.equal(typeof sandbox.window.showWalletError, 'function');
  assert.equal(typeof sandbox.window.walletEnsureUnlocked, 'function');
  assert.equal(typeof sandbox.window.openWalletConsole, 'function');
});

test('popup boots into the dashboard and runs a full refresh cycle without throwing', async () => {
  const { sandbox, document } = boot((msg) => {
    switch (msg.type) {
      case 'wallet.getState': return { adi: 'acc://alice.acme', connected: true, keyCount: 1, sessionCount: 0, rpcUrl: 'http://localhost:8080/rpc' };
      case 'wallet.getPendingRequests': return { requests: [], rpcUrl: 'http://localhost:8080/rpc' };
      case 'wallet.listKeys': return { keys: [{ keyId: 'k1', publicKey: 'aa'.repeat(32), algorithm: 'ed25519' }] };
      case 'wallet.listSessions': return { sessions: [] };
      case 'wallet.verifyPassphrase': return { ok: true };
      default: return {};
    }
  });
  await loadPopup(sandbox);
  await document._dcl();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(document.getElementById('dashboardView').hidden, false);
  assert.equal(document.getElementById('onboardingView').hidden, true);
  // Identity rendered (identicon SVG injected).
  assert.match(document.getElementById('idIcon').innerHTML, /<svg/);
  assert.equal(document.getElementById('idAdi').textContent, 'acc://alice.acme');
});
