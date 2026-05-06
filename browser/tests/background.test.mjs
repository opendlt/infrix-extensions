// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// P2-003 closure — background service-worker handler unit tests.
//
// Drives extension/background.js's chrome.runtime.onMessage listener
// directly via the test harness's chrome.* shim. Each test starts
// from a freshly-loaded background module (cache-busted dynamic
// import) so module-level walletState does not leak between cases.
//
// The integration test (integration.test.mjs) is the wire-shape
// counterpart that asserts the actual JSON-RPC envelope sent to the
// devnet. This file is the in-memory-handler counterpart: it
// validates the response objects the background returns to the
// content script + popup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadBackground,
  postMessage,
  installFetchStub,
  lastFetch,
  resetFetchHistory,
} from './harness.mjs';

test('wallet.getState returns adi/connected/keyCount/sessionCount', async () => {
  await loadBackground({ adi: 'acc://alice.acme', connected: true });
  const r = await postMessage({ type: 'wallet.getState' });
  assert.equal(r.adi, 'acc://alice.acme');
  assert.equal(r.connected, true);
  assert.equal(typeof r.keyCount, 'number');
  assert.equal(typeof r.sessionCount, 'number');
});

test('wallet.setADI persists ADI and flips connected', async () => {
  await loadBackground({});
  const r = await postMessage({ type: 'wallet.setADI', adi: 'acc://bob.acme' });
  assert.equal(r.adi, 'acc://bob.acme');
  const state = await postMessage({ type: 'wallet.getState' });
  assert.equal(state.adi, 'acc://bob.acme');
  assert.equal(state.connected, true);
});

test('unknown message type returns explicit error', async () => {
  await loadBackground({});
  const r = await postMessage({ type: 'wallet.totallyMadeUp' });
  assert.ok(r.error, 'unknown message types must return { error } not silently succeed');
  assert.match(r.error, /Unknown message type/);
});

test('wallet.generateKey requires a passphrase', async () => {
  await loadBackground({});
  const r = await postMessage({ type: 'wallet.generateKey', algorithm: 'ed25519' });
  assert.match(String(r.error || ''), /wallet passphrase required/);
  const state = await postMessage({ type: 'wallet.getState' });
  assert.equal(state.keyCount, 0, 'failed key generation must not persist public keys');
});

test('wallet.sign requires a passphrase instead of emitting fake signatures', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  const r = await postMessage({ type: 'wallet.sign', payload: '0x1234' });
  assert.match(String(r.error || ''), /wallet passphrase required/);
  assert.equal(Object.hasOwn(r, 'signature'), false, 'unsigned requests must not return signature-shaped bytes');
});

test('wallet.generateKey + wallet.sign produce a verifiable Ed25519 signature', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  const passphrase = 'correct horse battery staple';
  const generated = await postMessage({
    type: 'wallet.generateKey',
    algorithm: 'ed25519',
    keyId: 'default',
    passphrase,
  });
  assert.equal(generated.keyId, 'default');
  assert.match(generated.publicKey, /^[0-9a-f]{64}$/);
  const state = await postMessage({ type: 'wallet.getState' });
  assert.equal(state.keyCount, 1);

  const message = 'approve plan hash 0xfeedface';
  const signed = await postMessage({
    type: 'wallet.sign',
    keyId: 'default',
    passphrase,
    message,
  });
  assert.equal(signed.keyId, 'default');
  assert.equal(signed.publicKey, generated.publicKey);
  assert.match(signed.signature, /^[0-9a-f]{128}$/);

  const publicKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(signed.publicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    hexToBytes(signed.signature),
    new TextEncoder().encode(message),
  );
  assert.equal(verified, true, 'signature must verify against the stored public key');
});

test('wallet.sign rejects the wrong passphrase before producing bytes', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  await postMessage({
    type: 'wallet.generateKey',
    keyId: 'default',
    passphrase: 'right-passphrase',
  });
  const r = await postMessage({
    type: 'wallet.sign',
    keyId: 'default',
    passphrase: 'wrong-passphrase',
    message: 'cannot sign this',
  });
  assert.match(String(r.error || ''), /invalid passphrase/);
  assert.equal(Object.hasOwn(r, 'signature'), false);
});

test('wallet.submitIntent stamps actor + purpose + workflowInstance on the RPC params', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  await postMessage({
    type: 'wallet.submitIntent',
    goal: { type: 'SWAP', sourceAssets: [{ asset: 'ACME', amount: 100 }] },
  });
  const f = lastFetch();
  assert.ok(f, 'submitIntent must have produced an outbound fetch');
  assert.equal(f.body.method, 'intent.submit');
  assert.equal(f.body.params.userAddress, 'acc://alice.acme');
  assert.equal(f.body.params.actor, 'acc://alice.acme',
    'P2-003: submitIntent params must carry actor (Gap 12 disclosure gate envelope) — augmentDisclosureContext was bypassed');
  assert.equal(f.body.params.purpose, 'wallet-plan-approval',
    'P2-003: submitIntent params must carry the canonical wallet purpose marker');
  assert.match(String(f.body.params.workflowInstance || ''), /^wallet-plan-approval-/,
    'P2-003: submitIntent params must carry a per-call workflowInstance');
});

test('wallet.rpc forwards arbitrary methods with augmented disclosure context', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  await postMessage({
    type: 'wallet.rpc',
    method: 'intent.plan',
    params: { intentId: 'intent-123' },
  });
  const f = lastFetch();
  assert.ok(f);
  assert.equal(f.body.method, 'intent.plan');
  assert.equal(f.body.params.intentId, 'intent-123');
  assert.equal(f.body.params.actor, 'acc://alice.acme');
  assert.equal(f.body.params.purpose, 'wallet-plan-approval');
  assert.ok(f.body.params.workflowInstance);
});

test('wallet.rpc preserves caller-supplied actor / purpose if provided', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  await postMessage({
    type: 'wallet.rpc',
    method: 'intent.plan',
    params: { intentId: 'i1', actor: 'acc://override.acme', purpose: 'override-purpose', workflowInstance: 'override-wfi' },
  });
  const f = lastFetch();
  assert.equal(f.body.params.actor, 'acc://override.acme',
    'P2-003: caller-supplied actor must be preserved (override semantics for the popup-driven flow)');
  assert.equal(f.body.params.purpose, 'override-purpose');
  assert.equal(f.body.params.workflowInstance, 'override-wfi');
});

test('wallet.approveIntent does NOT auto-submit — queues a pending request', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  const r = await postMessage({
    type: 'wallet.approveIntent',
    intentId: 'intent-1',
    planHash: 'aabbcc',
  });
  assert.equal(r.queued, true,
    'P2-003: approveIntent from a dApp must queue a pending request, not auto-submit');
  assert.ok(r.requestId, 'queued request must surface a requestId for the popup to refer to');
  assert.equal(lastFetch(), null,
    'no fetch should fire until the user approves via the popup (confused-deputy guard)');
});

test('wallet.approveRequest with submitIntent payload sends intent.submit + augments disclosure', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  // Manually queue a submitIntent request via the canonical
  // wallet.requestApproval path so background's pendingRequests has
  // an entry to approve.
  const queued = await postMessage({
    type: 'wallet.requestApproval',
    requestType: 'submitIntent',
    params: { userAddress: 'acc://alice.acme', goal: { type: 'CONTRACT_DEPLOY' } },
  });
  assert.ok(queued.requestId);
  await postMessage({ type: 'wallet.approveRequest', requestId: queued.requestId });
  const f = lastFetch();
  assert.ok(f, 'approveRequest must trigger an outbound RPC');
  assert.equal(f.body.method, 'intent.submit');
  assert.equal(f.body.params.actor, 'acc://alice.acme');
  assert.ok(f.body.params.workflowInstance);
});

test('wallet.approveRequest aborts on plan-hash mismatch (confused-deputy guard)', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  const queued = await postMessage({
    type: 'wallet.approveIntent',
    intentId: 'intent-1',
    planHash: 'aabbcc',
  });
  resetFetchHistory();
  const r = await postMessage({
    type: 'wallet.approveRequest',
    requestId: queued.requestId,
    planHash: 'WRONG_HASH',
  });
  assert.match(String(r.error || ''), /Plan hash mismatch/,
    'P2-003: signing must abort on plan-hash mismatch (confused-deputy attack prevention)');
  assert.equal(lastFetch(), null,
    'no RPC must fire after plan-hash mismatch — the abort happens before approval.submit is sent');
});

test('wallet.approveRequest with matching planHash routes to approval.submit with augmented disclosure', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  const passphrase = 'approval-passphrase';
  const key = await postMessage({
    type: 'wallet.generateKey',
    keyId: 'approval-key',
    passphrase,
  });
  const queued = await postMessage({
    type: 'wallet.approveIntent',
    intentId: 'intent-7',
    planHash: '0xfeedface',
  });
  resetFetchHistory();
  await postMessage({
    type: 'wallet.approveRequest',
    requestId: queued.requestId,
    planHash: '0xfeedface',
    keyId: 'approval-key',
    passphrase,
  });
  const f = lastFetch();
  assert.ok(f);
  assert.equal(f.body.method, 'approval.submit');
  assert.equal(f.body.params.intentId, 'intent-7');
  assert.equal(f.body.params.planHash, '0xfeedface');
  assert.equal(f.body.params.actor, 'acc://alice.acme');
  assert.equal(f.body.params.purpose, 'wallet-plan-approval');
  assert.ok(f.body.params.workflowInstance);
  assert.equal(f.body.params.signerPublicKey, key.publicKey);
  assert.equal(f.body.params.signatureAlgorithm, 'ed25519');
  assert.equal(f.body.params.signaturePayload, 'infrix-approval-v1:intent-7:0xfeedface:acc://alice.acme');
  assert.match(f.body.params.signature, /^[0-9a-f]{128}$/);

  const publicKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(f.body.params.signerPublicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    hexToBytes(f.body.params.signature),
    new TextEncoder().encode(f.body.params.signaturePayload),
  );
  assert.equal(verified, true, 'approval signature must verify over the canonical approval payload');
});

test('wallet.createSession + listSessions + revokeSession round-trip in module state', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  const create = await postMessage({
    type: 'wallet.createSession',
    scope: { contracts: ['acc://contract.acme'], maxUses: 5 },
  });
  assert.ok(create.session);
  assert.ok(create.session.publicKey);
  const list = await postMessage({ type: 'wallet.listSessions' });
  assert.equal(list.sessions.length, 1);
  await postMessage({ type: 'wallet.revokeSession', publicKey: create.session.publicKey });
  const list2 = await postMessage({ type: 'wallet.listSessions' });
  assert.equal(list2.sessions.length, 0);
});

test('wallet.validateSession enforces scope.contracts allowlist', async () => {
  await loadBackground({});
  const create = await postMessage({
    type: 'wallet.createSession',
    scope: { contracts: ['acc://allowed.acme'] },
  });
  const ok = await postMessage({
    type: 'wallet.validateSession',
    publicKey: create.session.publicKey,
    contractUrl: 'acc://allowed.acme',
    function: 'transfer',
  });
  assert.equal(ok.valid, true);
  const denied = await postMessage({
    type: 'wallet.validateSession',
    publicKey: create.session.publicKey,
    contractUrl: 'acc://denied.acme',
    function: 'transfer',
  });
  assert.equal(denied.valid, false);
  assert.match(denied.error || '', /Contract not allowed/);
});

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
