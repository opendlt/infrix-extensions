// Unit tests for the popup-side governance API client (popup/api.js).
//
// api.js is a classic script (it attaches to window and guards a CJS export),
// so we run its source in a vm sandbox — the same approach content.test.mjs
// uses — and exercise the pure helpers + the disclosure-header construction.
// The fetch-backed reads are covered by the integration suite against the mock
// server; here we fence the logic that must be correct regardless of network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readExtensionFile } from './harness.mjs';

const source = await readExtensionFile('popup/api.js');
const sandbox = { window: {}, URL, module: undefined };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'api.js' });
const api = sandbox.window.InfrixWalletData;

test('api.js attaches the client + helpers to window', () => {
  assert.equal(typeof api, 'object');
  assert.equal(typeof api.InfrixWalletApi, 'function');
  assert.equal(typeof sandbox.window.InfrixWalletApi, 'function');
});

test('originOf derives the REST origin from the rpc url', () => {
  const o = api.InfrixWalletApi.originOf;
  assert.equal(o('http://localhost:8080/rpc'), 'http://localhost:8080');
  assert.equal(o('http://localhost:9090/v4/jsonrpc'), 'http://localhost:9090');
  assert.equal(o('not-a-url'), 'http://localhost:8080'); // safe fallback
});

test('headers carry the full disclosure trio with the wallet actor', () => {
  const c = new api.InfrixWalletApi('http://localhost:8080/rpc', 'acc://alice.acme');
  const h = c.headers('wallet-activity');
  assert.equal(h['X-Actor'], 'acc://alice.acme');
  assert.equal(h['X-Purpose'], 'wallet-activity');
  assert.equal(h['X-Workflow-Instance'], 'wallet-activity-1');
  // distinct per call
  assert.equal(c.headers('wallet-activity')['X-Workflow-Instance'], 'wallet-activity-2');
});

test('a disconnected client refuses to read (Gap 12 needs an actor)', async () => {
  const c = new api.InfrixWalletApi('http://localhost:8080/rpc', '');
  assert.equal(c.isConnected(), false);
  await assert.rejects(() => c.get('/v4/network/status'), /not connected/);
});

test('gradeAssurance is fail-closed and never over-claims', () => {
  assert.equal(api.gradeAssurance(null).id, 'offline');
  assert.equal(api.gradeAssurance({}).id, 'offline');
  assert.equal(api.gradeAssurance({ replayVerified: true }).id, 'replay');
  assert.equal(api.gradeAssurance({ anchor: { txHash: '0xabc' } }).id, 'l0');
  assert.equal(api.gradeAssurance({ Anchor: { TxHash: '0xabc' } }).id, 'l0');
  // witness outranks anchor
  assert.equal(api.gradeAssurance({ witnessed: true, anchor: { txHash: '0xabc' } }).id, 'witness');
});

test('statusKind maps lifecycle states to a coarse visual state', () => {
  assert.equal(api.statusKind('approved'), 'ok');
  assert.equal(api.statusKind('anchored'), 'ok');
  assert.equal(api.statusKind('pending_approval'), 'pending');
  assert.equal(api.statusKind('denied'), 'failed');
  assert.equal(api.statusKind('reverted'), 'failed');
  assert.equal(api.statusKind('whatever'), 'neutral');
});

test('identicon is deterministic, seed-sensitive, and valid SVG', () => {
  const a = api.identiconSvg('acc://alice.acme');
  const b = api.identiconSvg('acc://alice.acme');
  const c = api.identiconSvg('acc://bob.acme');
  assert.equal(a, b, 'same seed → identical glyph');
  assert.notEqual(a, c, 'different seed → different glyph');
  assert.match(a, /^<svg /);
  assert.match(a, /<\/svg>$/);
});
