// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// G-25 phase 1a — keystore round-trip tests.
//
// Run with: node --test extension/wallet/keystore.test.mjs
// Requires Node 20+ (built-in webcrypto + node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedKeystore } from './keystore.js';

// In-memory storage shim (chrome.storage.local-shaped).
function newStorage() {
  const data = {};
  return {
    async get(key) {
      return key in data ? { [key]: data[key] } : null;
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    raw: data,
  };
}

const passphrase = 'correct horse battery staple';
const wrong = 'tr0ub4dor&3';

test('initialize then unlock round-trips with correct passphrase', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  ks.lock();
  await ks.unlock(passphrase);
  assert.equal(ks.isUnlocked(), true);
});

test('addKey + getKey round-trips ciphertext', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  const priv = new Uint8Array(32).map((_, i) => i + 1);
  const pub = new Uint8Array(32).map((_, i) => i + 100);
  await ks.addKey('default', priv, pub);
  const got = await ks.getKey('default');
  assert.deepEqual(got, priv);
});

test('wrong passphrase rejected after addKey', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  await ks.addKey('default', new Uint8Array(32).fill(7), new Uint8Array(32).fill(8));
  ks.lock();

  const ks2 = new EncryptedKeystore(storage);
  await assert.rejects(() => ks2.unlock(wrong), /invalid passphrase/);
});

test('wrong passphrase rejected before any keys exist', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  ks.lock();

  const ks2 = new EncryptedKeystore(storage);
  await assert.rejects(() => ks2.unlock(wrong), /invalid passphrase/);
});

test('rotate re-encrypts all keys under new passphrase', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  const priv = new Uint8Array(32).map((_, i) => i + 50);
  const pub = new Uint8Array(32).map((_, i) => i + 200);
  await ks.addKey('default', priv, pub);

  await ks.rotate(passphrase, wrong);
  // Old passphrase no longer unlocks
  ks.lock();
  await assert.rejects(() => ks.unlock(passphrase), /invalid passphrase/);
  // New passphrase unlocks; key still readable
  await ks.unlock(wrong);
  const got = await ks.getKey('default');
  assert.deepEqual(got, priv);
});

test('listKeys returns metadata without unlocking', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  await ks.addKey('alpha', new Uint8Array(32).fill(1), new Uint8Array(32).fill(11));
  await ks.addKey('beta', new Uint8Array(32).fill(2), new Uint8Array(32).fill(22));
  ks.lock();

  const ks2 = new EncryptedKeystore(storage);
  const list = await ks2.listKeys();
  assert.equal(list.length, 2);
  const ids = list.map(k => k.keyId).sort();
  assert.deepEqual(ids, ['alpha', 'beta']);
  // pubKey is plaintext-listable; private key is not.
  assert.equal(list[0].pubKey.length, 32);
});

test('addKey overwrites existing keyId', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.addKey('default', new Uint8Array(32).fill(1), new Uint8Array(32).fill(11));
  await ks.addKey('default', new Uint8Array(32).fill(2), new Uint8Array(32).fill(22));
  const got = await ks.getKey('default');
  assert.deepEqual(got, new Uint8Array(32).fill(2));
});

test('deleteKey removes only the requested keyId', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.addKey('one', new Uint8Array(32).fill(1), new Uint8Array(32).fill(11));
  await ks.addKey('two', new Uint8Array(32).fill(2), new Uint8Array(32).fill(22));
  assert.equal(await ks.deleteKey('one'), true);
  assert.equal(await ks.deleteKey('missing'), false);
  const list = await ks.listKeys();
  assert.equal(list.length, 1);
  assert.equal(list[0].keyId, 'two');
});

test('cannot initialize twice', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await assert.rejects(() => ks.initialize(passphrase), /already initialized/);
});

test('addKey requires unlocked keystore', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  ks.lock();
  await assert.rejects(
    () => ks.addKey('x', new Uint8Array(32), new Uint8Array(32)),
    /locked/,
  );
});

test('rotate requires different passphrase', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await assert.rejects(() => ks.rotate(passphrase, passphrase), /must differ/);
});

test('multiple ciphertexts use distinct IVs', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  const same = new Uint8Array(32).fill(0xAA);
  await ks.addKey('a', same, new Uint8Array(32).fill(1));
  await ks.addKey('b', same, new Uint8Array(32).fill(2));
  // Same plaintext + same wrapping key + different IV → different ciphertexts.
  const stored = storage.raw['infrix.keystore.v1'];
  assert.notEqual(stored.keys[0].ciphertext, stored.keys[1].ciphertext);
  assert.notEqual(stored.keys[0].iv, stored.keys[1].iv);
});
