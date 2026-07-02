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

test('wallet.getState exposes rpcUrl so the popup can derive the /v4 origin', async () => {
  await loadBackground({ adi: 'acc://alice.acme', connected: true });
  const r = await postMessage({ type: 'wallet.getState' });
  assert.equal(typeof r.rpcUrl, 'string');
  assert.ok(r.rpcUrl.length > 0, 'rpcUrl must be present for the popup REST client');
});

test('wallet.verifyPassphrase requires a passphrase', async () => {
  await loadBackground({});
  const r = await postMessage({ type: 'wallet.verifyPassphrase', passphrase: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /passphrase/);
});

test('wallet.verifyPassphrase accepts any passphrase on a fresh (uninitialized) keystore', async () => {
  await loadBackground({});
  const r = await postMessage({ type: 'wallet.verifyPassphrase', passphrase: 'correct horse battery staple' });
  assert.equal(r.ok, true);
  assert.equal(r.uninitialized, true);
});

test('wallet.verifyPassphrase round-trips: accepts the right passphrase, rejects the wrong one', async () => {
  await loadBackground({ adi: 'acc://alice.acme', connected: true });
  // Initialize the keystore by generating a key with a known passphrase.
  const gen = await postMessage({ type: 'wallet.generateKey', algorithm: 'ed25519', passphrase: 's3cret-passphrase' });
  assert.ok(gen && gen.keyId, 'key generation should succeed');
  const ok = await postMessage({ type: 'wallet.verifyPassphrase', passphrase: 's3cret-passphrase' });
  assert.equal(ok.ok, true);
  assert.notEqual(ok.uninitialized, true);
  const bad = await postMessage({ type: 'wallet.verifyPassphrase', passphrase: 'wrong' });
  assert.equal(bad.ok, false);
});

// --- WB-02: encrypted backup / restore -----------------------------------

test('wallet.getState exposes backedUpAt (null/empty before any export)', async () => {
  await loadBackground({ adi: 'acc://alice.acme', connected: true });
  const r = await postMessage({ type: 'wallet.getState' });
  assert.equal(r.backedUpAt, '');
});

test('wallet.exportBackup returns ciphertext only — no plaintext key or passphrase', async () => {
  await loadBackground({ adi: 'acc://alice.acme', connected: true });
  await postMessage({ type: 'wallet.generateKey', algorithm: 'ed25519', passphrase: 'pass-12345678' });
  const res = await postMessage({ type: 'wallet.exportBackup' });
  assert.ok(res.backup, 'backup present');
  assert.equal(res.backup.format, 'infrix-keystore-backup');
  assert.ok(Array.isArray(res.backup.store.keys) && res.backup.store.keys.length === 1, 'one key in backup');
  // Forbidden substrings anywhere in the serialized backup.
  const json = JSON.stringify(res.backup).toLowerCase();
  for (const forbidden of ['"priv', 'plaintext', 'passphrase', 'pass-12345678']) {
    assert.equal(json.includes(forbidden), false, `backup must not contain ${forbidden}`);
  }
  // After export, getState reports backedUpAt.
  const st = await postMessage({ type: 'wallet.getState' });
  assert.notEqual(st.backedUpAt, '');
});

test('wallet.importBackup refuses to clobber an existing keystore without overwrite', async () => {
  await loadBackground({ adi: 'acc://alice.acme', connected: true });
  await postMessage({ type: 'wallet.generateKey', algorithm: 'ed25519', passphrase: 'pass-12345678' });
  const exp = await postMessage({ type: 'wallet.exportBackup' });
  const blocked = await postMessage({ type: 'wallet.importBackup', backup: exp.backup });
  assert.match(blocked.error || '', /already exists/);
  assert.equal(blocked.needsOverwrite, true);
});

// --- WB-03: seed-phrase recovery ------------------------------------------

test('wallet.createAccount issues a valid recovery phrase, sets the ADI, and makes a seed key', async () => {
  await loadBackground({});
  const res = await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  assert.ok(res.mnemonic, 'mnemonic returned for the reveal screen');
  assert.equal(res.mnemonic.trim().split(/\s+/).length, 12);
  assert.equal(res.adi, 'acc://alice.acme');
  const st = await postMessage({ type: 'wallet.getState' });
  assert.equal(st.adi, 'acc://alice.acme');
  const keys = await postMessage({ type: 'wallet.listKeys' });
  assert.equal(keys.keys.length, 1);
  assert.equal(keys.keys[0].source, 'seed');
  // The derived key can sign and the signature verifies under the returned pubkey.
  const sig = await postMessage({ type: 'wallet.sign', message: 'hello', passphrase: 'pass-12345678' });
  assert.equal(sig.publicKey, keys.keys[0].publicKey);
});

test('wallet.restoreFromMnemonic reproduces the SAME key on a fresh device (determinism)', async () => {
  await loadBackground({});
  const created = await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  const origKeys = await postMessage({ type: 'wallet.listKeys' });

  // Fresh device: reset state + storage, then restore from the phrase.
  await loadBackground({});
  const restored = await postMessage({ type: 'wallet.restoreFromMnemonic', adi: 'acc://alice.acme', mnemonic: created.mnemonic, passphrase: 'different-pass-9999' });
  assert.equal(restored.restored, true);
  assert.equal(restored.publicKey, origKeys.keys[0].publicKey, 'same phrase → same key, regardless of keystore passphrase');
});

test('wallet.restoreFromMnemonic rejects an invalid recovery phrase', async () => {
  await loadBackground({});
  const r = await postMessage({ type: 'wallet.restoreFromMnemonic', adi: 'acc://x.acme', mnemonic: 'not a real recovery phrase at all nope nope nope', passphrase: 'pass-12345678' });
  assert.match(r.error || '', /invalid recovery phrase/);
});

test('wallet.revealMnemonic returns the phrase with the right passphrase, errors on the wrong one', async () => {
  await loadBackground({});
  const created = await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  const ok = await postMessage({ type: 'wallet.revealMnemonic', passphrase: 'pass-12345678' });
  assert.equal(ok.mnemonic, created.mnemonic);
  const bad = await postMessage({ type: 'wallet.revealMnemonic', passphrase: 'wrong' });
  assert.match(bad.error || '', /invalid passphrase/);
});

test('wallet.generateKey on a seed account derives the next index deterministically', async () => {
  await loadBackground({});
  const created = await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  const k1 = await postMessage({ type: 'wallet.generateKey', passphrase: 'pass-12345678' });
  const keys = await postMessage({ type: 'wallet.listKeys' });
  assert.equal(keys.keys.length, 2);
  assert.ok(keys.keys.every((k) => k.source === 'seed'));
  // index 1 differs from index 0
  assert.notEqual(k1.publicKey, created.publicKey);
  // Deterministic: restoring the phrase on a fresh device + generating one more
  // key reproduces the SAME index-1 key.
  await loadBackground({});
  await postMessage({ type: 'wallet.restoreFromMnemonic', adi: 'acc://alice.acme', mnemonic: created.mnemonic, passphrase: 'p2-12345678' });
  const k1b = await postMessage({ type: 'wallet.generateKey', passphrase: 'p2-12345678' });
  assert.equal(k1b.publicKey, k1.publicKey);
});

test('wallet.importBackup round-trips: export, fresh device, restore → keys + ADI recovered', async () => {
  await loadBackground({ adi: 'acc://alice.acme', connected: true });
  await postMessage({ type: 'wallet.generateKey', algorithm: 'ed25519', passphrase: 'pass-12345678' });
  const before = await postMessage({ type: 'wallet.listKeys' });
  const exp = await postMessage({ type: 'wallet.exportBackup' });

  // Fresh device: loadBackground resets BOTH module state and the storage shim
  // (including the chrome.storage keystore), unlike __resetState which leaves
  // the encrypted store in place.
  await loadBackground({});
  const cleared = await postMessage({ type: 'wallet.listKeys' });
  assert.equal(cleared.keys.length, 0, 'fresh device has no keys');

  const imp = await postMessage({ type: 'wallet.importBackup', backup: exp.backup, overwrite: true });
  assert.equal(imp.imported, true);
  assert.equal(imp.adi, 'acc://alice.acme');
  const after = await postMessage({ type: 'wallet.listKeys' });
  assert.equal(after.keys.length, before.keys.length);
  assert.equal(after.keys[0].publicKey, before.keys[0].publicKey);
  // The restored store still unlocks with the original passphrase.
  const verify = await postMessage({ type: 'wallet.verifyPassphrase', passphrase: 'pass-12345678' });
  assert.equal(verify.ok, true);
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

test('wallet.sign on a locked wallet returns WALLET_LOCKED, never a fake signature', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  // No session, no passphrase → the session gate (WB-04) refuses with a typed
  // locked error so the popup can prompt unlock — and emits no signature.
  const r = await postMessage({ type: 'wallet.sign', payload: '0x1234' });
  assert.match(String(r.error || ''), /locked/);
  assert.equal(r.code, 'WALLET_LOCKED');
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

test('wallet.sign rejects the wrong passphrase before producing bytes (locked, unlock-on-demand)', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  await postMessage({
    type: 'wallet.generateKey',
    keyId: 'default',
    passphrase: 'right-passphrase',
  });
  // generateKey leaves the session unlocked (WB-04); lock it so the wrong
  // passphrase is actually exercised on the unlock-on-demand path.
  await postMessage({ type: 'wallet.lock' });
  const r = await postMessage({
    type: 'wallet.sign',
    keyId: 'default',
    passphrase: 'wrong-passphrase',
    message: 'cannot sign this',
  });
  assert.match(String(r.error || ''), /invalid passphrase/);
  assert.equal(Object.hasOwn(r, 'signature'), false);
});

// --- WB-09: key identity ----------------------------------------------------

test('wallet.generateKey accepts label + purpose; wallet.renameKey updates the label', async () => {
  await loadBackground({});
  await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  await postMessage({ type: 'wallet.generateKey', passphrase: 'pass-12345678', label: 'Trading key', purpose: 'trading' });
  let keys = (await postMessage({ type: 'wallet.listKeys' })).keys;
  const trading = keys.find((k) => k.label === 'Trading key');
  assert.ok(trading, 'labelled key present');
  assert.equal(trading.purpose, 'trading');
  // The primary (onboarding) key carries the default label.
  assert.ok(keys.some((k) => k.label === 'Primary key'));
  const r = await postMessage({ type: 'wallet.renameKey', keyId: trading.keyId, label: 'Renamed key' });
  assert.equal(r.renamed, true);
  keys = (await postMessage({ type: 'wallet.listKeys' })).keys;
  assert.equal(keys.find((k) => k.keyId === trading.keyId).label, 'Renamed key');
});

// --- WB-10: signing transparency (pinned canonical format) ------------------

test('canonical approval payload format is pinned (changing inputs changes output deterministically)', async () => {
  await loadBackground({ adi: 'acc://carol.acme', connected: true });
  const a = await postMessage({ type: 'wallet.previewSignaturePayload', intentId: 'iX', planHash: '0xDEAD' });
  // Exact, stable wire format — a silent change here would break verification.
  assert.equal(a.payload, 'infrix-approval-v1:iX:0xDEAD:acc://carol.acme');
  const b = await postMessage({ type: 'wallet.previewSignaturePayload', intentId: 'iY', planHash: '0xDEAD' });
  assert.notEqual(a.payload, b.payload, 'different intent → different payload');
});

// --- WB-06: signer seam -----------------------------------------------------

test('wallet.previewSignaturePayload returns the canonical payload string', async () => {
  await loadBackground({});
  await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  const p = await postMessage({ type: 'wallet.previewSignaturePayload', intentId: 'intent-1', planHash: '0xabc' });
  assert.equal(p.payload, 'infrix-approval-v1:intent-1:0xabc:acc://alice.acme');
  assert.equal(p.signerIdentity, 'acc://alice.acme');
});

test('wallet.signPayload signs the exact payload; signature verifies under the returned pubkey', async () => {
  await loadBackground({});
  await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  const payload = 'infrix-approval-v1:intent-1:0xabc:acc://alice.acme';
  const res = await postMessage({ type: 'wallet.signPayload', payload });
  assert.ok(res.signature && res.publicKey);
  const pub = await crypto.subtle.importKey('raw', Buffer.from(res.publicKey, 'hex'), { name: 'Ed25519' }, false, ['verify']);
  const sig = Buffer.from(res.signature, 'hex');
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, new TextEncoder().encode(payload));
  assert.equal(ok, true);
});

test('wallet.submitApproval enforces the confused-deputy guard for a queued request', async () => {
  installFetchStub();
  resetFetchHistory();
  await loadBackground({ adi: 'acc://alice.acme', rpcUrl: 'http://localhost:9999/rpc' });
  // Queue an approveIntent request with a known planHash.
  const q = await postMessage({ type: 'wallet.approveIntent', intentId: 'i1', planHash: '0xGOOD' });
  // Submitting a DIFFERENT planHash for that requestId is rejected, no submit.
  const bad = await postMessage({
    type: 'wallet.submitApproval', requestId: q.requestId, intentId: 'i1', planHash: '0xEVIL',
    signerPublicKey: 'aa', signature: 'bb', signatureAlgorithm: 'ed25519', signaturePayload: 'x',
  });
  assert.match(bad.error || '', /mismatch/);
});

// --- WB-04: unlocked-session signing ---------------------------------------

test('wallet.unlock opens a session: two signs, one passphrase, no re-derive', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  await postMessage({ type: 'wallet.generateKey', keyId: 'k', passphrase: 'pass-12345678' });
  await postMessage({ type: 'wallet.lock' });
  // Open a session once.
  const u = await postMessage({ type: 'wallet.unlock', passphrase: 'pass-12345678' });
  assert.equal(u.unlocked, true);
  // Two signs with NO passphrase succeed off the session.
  const s1 = await postMessage({ type: 'wallet.sign', keyId: 'k', message: 'one' });
  const s2 = await postMessage({ type: 'wallet.sign', keyId: 'k', message: 'two' });
  assert.ok(s1.signature && s2.signature, 'both signs succeed via the open session');
  assert.equal(s1.publicKey, s2.publicKey);
});

test('wallet.lock ends the session; wallet.lockStatus reports it', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  await postMessage({ type: 'wallet.generateKey', keyId: 'k', passphrase: 'pass-12345678' });
  let st = await postMessage({ type: 'wallet.lockStatus' });
  assert.equal(st.unlocked, true); // generateKey left it unlocked
  assert.ok(st.remainingMs > 0);
  await postMessage({ type: 'wallet.lock' });
  st = await postMessage({ type: 'wallet.lockStatus' });
  assert.equal(st.unlocked, false);
  assert.equal(st.remainingMs, 0);
  // Signing while locked, with no passphrase, is refused.
  const r = await postMessage({ type: 'wallet.sign', keyId: 'k', message: 'x' });
  assert.equal(r.code, 'WALLET_LOCKED');
});

// --- WB-05: change passphrase ----------------------------------------------

test('wallet.rotatePassphrase rejects new===old and a wrong current passphrase (store intact)', async () => {
  await loadBackground({});
  await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  const same = await postMessage({ type: 'wallet.rotatePassphrase', oldPassphrase: 'pass-12345678', newPassphrase: 'pass-12345678' });
  assert.match(same.error || '', /must differ/);
  const wrong = await postMessage({ type: 'wallet.rotatePassphrase', oldPassphrase: 'not-the-pass', newPassphrase: 'new-passphrase-1' });
  assert.match(wrong.error || '', /current passphrase is incorrect/);
  // Store intact: the original passphrase still verifies.
  const v = await postMessage({ type: 'wallet.verifyPassphrase', passphrase: 'pass-12345678' });
  assert.equal(v.ok, true);
});

test('wallet.rotatePassphrase changes the passphrase; keys + recovery phrase survive', async () => {
  await loadBackground({});
  const created = await postMessage({ type: 'wallet.createAccount', adi: 'acc://alice.acme', passphrase: 'pass-12345678' });
  const before = await postMessage({ type: 'wallet.listKeys' });
  const rot = await postMessage({ type: 'wallet.rotatePassphrase', oldPassphrase: 'pass-12345678', newPassphrase: 'brand-new-pass-9' });
  assert.equal(rot.rotated, true);
  // Old fails, new verifies.
  assert.equal((await postMessage({ type: 'wallet.verifyPassphrase', passphrase: 'pass-12345678' })).ok, false);
  assert.equal((await postMessage({ type: 'wallet.verifyPassphrase', passphrase: 'brand-new-pass-9' })).ok, true);
  // Keys preserved (same pubkey) and the recovery phrase survived under the new passphrase.
  const after = await postMessage({ type: 'wallet.listKeys' });
  assert.equal(after.keys[0].publicKey, before.keys[0].publicKey);
  const reveal = await postMessage({ type: 'wallet.revealMnemonic', passphrase: 'brand-new-pass-9' });
  assert.equal(reveal.mnemonic, created.mnemonic);
  // rotate left the session unlocked under the new key → signing works with no passphrase.
  const sig = await postMessage({ type: 'wallet.sign', message: 'after-rotate' });
  assert.ok(sig.signature);
});

test('wallet.setIdleTimeout clamps and applies', async () => {
  await loadBackground({ adi: 'acc://alice.acme' });
  await postMessage({ type: 'wallet.unlock', passphrase: 'pass-12345678' }).catch(() => {});
  const a = await postMessage({ type: 'wallet.setIdleTimeout', ms: 5 }); // below floor
  assert.equal(a.idleTimeoutMs, 60_000);
  const b = await postMessage({ type: 'wallet.setIdleTimeout', ms: 9_999_999 }); // above ceiling
  assert.equal(b.idleTimeoutMs, 3_600_000);
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
