// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// P2-003 closure — integration test against a real local JSON-RPC
// handler.
//
// Differs from background.test.mjs in two important ways:
//   1. Uses a real Node http.Server bound to a free port instead of
//      the harness's in-process fetch stub. This proves the
//      background module honours the standard fetch API contract
//      (Content-Type header, JSON-RPC envelope shape, response
//      decoding) the way Chrome would dispatch it in production.
//   2. The mock server is allowlist-strict: requests whose method
//      string is not in CANONICAL_RPC_METHODS get a JSON-RPC error,
//      so a regression that ever called a forbidden method (e.g.
//      contract.deploy) would fail loud here even if the static
//      surface fence missed it.
//
// Together with content.test.mjs (provider surface) and
// background.test.mjs (handler unit tests) this gives the milestone's
// required "static test for provider method surface" + "integration
// test against local JSON-RPC handler" pair.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadBackground, postMessage, restoreRealFetch } from './harness.mjs';

// CANONICAL_RPC_METHODS is the closed allowlist of governance methods
// the wallet may invoke against the devnet /rpc. Any method outside
// this set is a regression toward the legacy raw-tx surface — the
// mock server returns -32601 (method not found) so the failing
// background path surfaces in the test diff.
//
// Adding a new method here is a deliberate doctrine choice — it
// means the wallet has a new authorised governance call.
const CANONICAL_RPC_METHODS = new Set([
  'intent.submit',
  'intent.plan',
  'intent.outcome',
  'intent.evidence',
  'approval.submit',
  'approval.get',
  'governed.submit',
  'governed.approve',
  'governed.status',
  'objects.list',
  'objects.get',
  'contract.query',
  'contract.inspect',
  'contract.schema',
  'contract.simulate',
  'events.history',
  'network.status',
]);

function startMockRpc() {
  const calls = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('only POST');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      const entry = {
        method: parsed.method,
        params: parsed.params,
        contentType: req.headers['content-type'],
      };
      calls.push(entry);
      if (!CANONICAL_RPC_METHODS.has(parsed.method)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32601, message: 'P2-003 mock: method ' + parsed.method + ' is not in the canonical wallet RPC allowlist' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: { ok: true, echoMethod: parsed.method },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/rpc`,
        calls,
        async close() {
          server.close();
          await once(server, 'close');
        },
      });
    });
  });
}

test('wallet.submitIntent → mock server receives intent.submit with disclosure envelope', async () => {
  const mock = await startMockRpc();
  try {
    restoreRealFetch();
    await loadBackground({ adi: 'acc://alice.acme', rpcUrl: mock.url });
    const r = await postMessage({
      type: 'wallet.submitIntent',
      goal: { type: 'CONTRACT_DEPLOY', sourceAssets: [], targetState: { stateType: 'contract', parameters: { x: '1' } } },
    });
    assert.ok(r, 'submitIntent must return a result');
    assert.equal(mock.calls.length, 1, 'exactly one RPC call expected');
    const c = mock.calls[0];
    assert.equal(c.method, 'intent.submit',
      'P2-003: dApp-driven submitIntent must dispatch via intent.submit (governance spine entry)');
    assert.equal(c.params.userAddress, 'acc://alice.acme');
    assert.equal(c.params.actor, 'acc://alice.acme',
      'P2-003: every wallet RPC must carry actor on the wire');
    assert.equal(c.params.purpose, 'wallet-plan-approval',
      'P2-003: every wallet RPC must carry purpose on the wire');
    assert.ok(c.params.workflowInstance,
      'P2-003: every wallet RPC must carry workflowInstance on the wire');
  } finally {
    await mock.close();
  }
});

test('wallet.rpc → mock server rejects forbidden methods so any regression surfaces here', async () => {
  const mock = await startMockRpc();
  try {
    restoreRealFetch();
    await loadBackground({ adi: 'acc://alice.acme', rpcUrl: mock.url });
    const r = await postMessage({
      type: 'wallet.rpc',
      method: 'contract.deploy',
      params: { wasm: '0xdead' },
    });
    assert.ok(r.error, 'wallet.rpc(contract.deploy) must surface the mock server -32601');
    assert.match(r.error, /not in the canonical wallet RPC allowlist/,
      'mock server error must propagate so the test diff names the forbidden method');
  } finally {
    await mock.close();
  }
});

test('wallet.rpc → governed canonical methods reach the mock server with disclosure envelope', async () => {
  const mock = await startMockRpc();
  try {
    restoreRealFetch();
    await loadBackground({ adi: 'acc://alice.acme', rpcUrl: mock.url });
    const r = await postMessage({
      type: 'wallet.rpc',
      method: 'intent.plan',
      params: { intentId: 'intent-99' },
    });
    assert.ok(r && !r.error, 'intent.plan must succeed against the mock allowlist');
    assert.equal(mock.calls.length, 1);
    const c = mock.calls[0];
    assert.equal(c.method, 'intent.plan');
    assert.equal(c.params.intentId, 'intent-99');
    assert.equal(c.params.actor, 'acc://alice.acme');
    assert.equal(c.params.purpose, 'wallet-plan-approval');
    assert.ok(c.params.workflowInstance);
    assert.equal(c.contentType, 'application/json',
      'background must POST application/json so the JSON-RPC server parses correctly');
  } finally {
    await mock.close();
  }
});

test('wallet.approveRequest end-to-end → approval.submit lands on mock server', async () => {
  const mock = await startMockRpc();
  try {
    restoreRealFetch();
    await loadBackground({ adi: 'acc://alice.acme', rpcUrl: mock.url });
    await postMessage({
      type: 'wallet.generateKey',
      keyId: 'approval-key',
      passphrase: 'approval-passphrase',
    });
    const queued = await postMessage({
      type: 'wallet.approveIntent',
      intentId: 'intent-42',
      planHash: '0xcafebabe',
    });
    assert.ok(queued.queued, 'queued first');
    assert.equal(mock.calls.length, 0, 'queue must NOT auto-submit');
    await postMessage({
      type: 'wallet.approveRequest',
      requestId: queued.requestId,
      planHash: '0xcafebabe',
      keyId: 'approval-key',
      passphrase: 'approval-passphrase',
    });
    assert.equal(mock.calls.length, 1, 'exactly one approval RPC after user approval');
    const c = mock.calls[0];
    assert.equal(c.method, 'approval.submit');
    assert.equal(c.params.intentId, 'intent-42');
    assert.equal(c.params.planHash, '0xcafebabe');
    assert.equal(c.params.actor, 'acc://alice.acme');
    assert.match(c.params.signature, /^[0-9a-f]{128}$/);
    assert.match(c.params.signerPublicKey, /^[0-9a-f]{64}$/);
    assert.equal(c.params.signatureAlgorithm, 'ed25519');
    assert.equal(c.params.signaturePayload, 'infrix-approval-v1:intent-42:0xcafebabe:acc://alice.acme');
    assert.ok(c.params.workflowInstance);
  } finally {
    await mock.close();
  }
});

test('multiple wallet.rpc calls produce distinct workflowInstance values per call', async () => {
  const mock = await startMockRpc();
  try {
    restoreRealFetch();
    await loadBackground({ adi: 'acc://alice.acme', rpcUrl: mock.url });
    await postMessage({ type: 'wallet.rpc', method: 'intent.plan', params: { intentId: 'a' } });
    await postMessage({ type: 'wallet.rpc', method: 'intent.plan', params: { intentId: 'b' } });
    assert.equal(mock.calls.length, 2);
    assert.notEqual(mock.calls[0].params.workflowInstance, mock.calls[1].params.workflowInstance,
      'P2-003: workflowInstance must be unique per call so audit trails distinguish individual reads');
  } finally {
    await mock.close();
  }
});
