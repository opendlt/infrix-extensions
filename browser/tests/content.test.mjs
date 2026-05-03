// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// P2-003 closure — provider-surface fence for the browser-extension
// content script.
//
// extension/content.js injects a `window.infrix` provider object into
// every page. The surface is GOVERNANCE-FIRST: dApps may only call
// methods that route through the canonical Intent → Plan → Approval →
// Execution → Outcome → Evidence → Anchor spine. The legacy Ethereum-
// style raw-mutation methods (window.infrix.deploy / .call / .upgrade)
// were deleted in earlier Gap closures and must never come back —
// they would silently train dApp authors to author opaque raw
// transactions and short-circuit governance.
//
// This test runs the content-script source through a JS sandbox that
// simulates the browser environment (window, document, no chrome
// runtime), captures the resulting window.infrix object, and asserts:
//
//   * the canonical method set is present;
//   * no forbidden Ethereum-style raw-tx method is exposed;
//   * isInfrix + version metadata fields are stable.
//
// The structural shape of the provider literal is also fenced via
// the existing pkg/devnet/gap15_dapp_window_infrix_fence_test.go (Go
// regex over the source). This JS-side test is the runtime
// counterpart: it actually constructs the provider and checks the
// object property bag a dApp would receive at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExtensionFile, evalContentScriptInWindowSandbox } from './harness.mjs';

const CANONICAL_METHODS = [
  'connect',
  'submitIntent',
  'approveIntent',
  'createSession',
  'revokeSession',
  'sign',
  'on',
];

const CANONICAL_METADATA_FIELDS = [
  'isInfrix',
  'version',
];

// FORBIDDEN_METHODS catalogues every Ethereum-style or legacy
// raw-mutation entrypoint that a dApp author might reach for if the
// provider surface drifted. The list is exhaustive within that
// vocabulary so a regression that re-introduces ANY of them fails.
// New additions are deliberate doctrine: governance-first means dApp
// surfaces never expose raw deploy/call/upgrade affordances.
const FORBIDDEN_METHODS = [
  'deploy',
  'call',
  'upgrade',
  'query',
  'invoke',
  'send',
  'sendTransaction',
  'signTransaction',
  'signTypedData',
  'eth_sendTransaction',
  'eth_call',
  'eth_signTransaction',
  'eth_sign',
  'eth_signTypedData',
  'wallet_addEthereumChain',
  'wallet_switchEthereumChain',
  'wallet_requestPermissions',
  'request',          // EIP-1193 generic dispatch — must not exist
  'enable',           // legacy MetaMask connect — must not exist
];

test('content.js parses cleanly under a window/document sandbox', async () => {
  const src = await readExtensionFile('content.js');
  const win = evalContentScriptInWindowSandbox(src);
  assert.ok(win.infrix, 'window.infrix must be injected by the content script');
});

test('window.infrix exposes the canonical governance-first method set', async () => {
  const src = await readExtensionFile('content.js');
  const win = evalContentScriptInWindowSandbox(src);
  for (const name of CANONICAL_METHODS) {
    assert.equal(typeof win.infrix[name], 'function',
      `window.infrix.${name} must be a function (canonical governance-first surface)`);
  }
});

test('window.infrix metadata fields stable', async () => {
  const src = await readExtensionFile('content.js');
  const win = evalContentScriptInWindowSandbox(src);
  for (const field of CANONICAL_METADATA_FIELDS) {
    assert.notEqual(win.infrix[field], undefined,
      `window.infrix.${field} must be present`);
  }
  assert.equal(win.infrix.isInfrix, true);
  assert.equal(typeof win.infrix.version, 'string');
});

test('window.infrix exposes NO Ethereum-style or legacy raw-mutation methods', async () => {
  const src = await readExtensionFile('content.js');
  const win = evalContentScriptInWindowSandbox(src);
  const offenders = [];
  for (const name of FORBIDDEN_METHODS) {
    if (typeof win.infrix[name] !== 'undefined') {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [],
    'P2-003: forbidden window.infrix surface re-introduced: ' + offenders.join(', ') +
    '. Governance-first dApp surface must NEVER expose raw deploy/call/upgrade or ' +
    'EIP-1193 dispatchers — every state change flows through submitIntent + the canonical spine.');
});

test('content.js source contains NO forbidden literal anywhere outside doc-comments', async () => {
  // Belt-and-braces fence on the source bytes themselves: even if
  // someone added a forbidden method via a runtime mutation that the
  // sandbox eval did not surface, the literal would still appear
  // here. False positives from prose comments are filtered: a
  // forbidden name must appear as a method-declaration shape
  // (`name: function` OR `name: (` OR `name(`) to count.
  const src = await readExtensionFile('content.js');
  const offenders = [];
  for (const name of FORBIDDEN_METHODS) {
    const re = new RegExp('(?:^|\\W)' + escapeRE(name) + '\\s*:\\s*(?:function\\b|\\()|(?:^|\\W)' + escapeRE(name) + '\\s*=\\s*function\\b', 'm');
    if (re.test(src)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [],
    'P2-003: extension/content.js source contains a forbidden method declaration: ' + offenders.join(', ') +
    '. Remove it and route the affordance through submitIntent / approveIntent.');
});

test('content.js dispatches infrix:ready event so dApps can detect the wallet', async () => {
  const src = await readExtensionFile('content.js');
  // Static check: the source must dispatch 'infrix:ready'. The
  // sandbox's CustomEvent doesn't propagate beyond the synchronous
  // eval, so we assert the literal directly. dApp detection depends
  // on this event firing at document_start.
  assert.ok(src.includes("'infrix:ready'") || src.includes('"infrix:ready"'),
    'content.js must dispatch infrix:ready so dApps can detect wallet presence at document_start');
});

function escapeRE(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
