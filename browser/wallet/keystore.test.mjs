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

// --- WB-01: AAD binding + v1→v2 migration -------------------------------

test('a fresh keystore is written at the current store version (v2)', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  assert.equal(storage.raw['infrix.keystore.v1'].version, 2);
});

test('AAD binding: swapping two entries\' ciphertext is rejected on decrypt', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  const privA = new Uint8Array(32).fill(0xA1);
  const privB = new Uint8Array(32).fill(0xB2);
  await ks.addKey('a', privA, new Uint8Array(32).fill(1));
  await ks.addKey('b', privB, new Uint8Array(32).fill(2));

  // Tamper: give entry 'a' the iv+ciphertext of entry 'b'. Without AAD this
  // would silently decrypt to privB; with keyId-bound AAD it must fail auth.
  const stored = storage.raw['infrix.keystore.v1'];
  const ea = stored.keys.find(k => k.keyId === 'a');
  const eb = stored.keys.find(k => k.keyId === 'b');
  ea.iv = eb.iv;
  ea.ciphertext = eb.ciphertext;

  const ks2 = new EncryptedKeystore(storage);
  await ks2.unlock(passphrase);
  await assert.rejects(() => ks2.getKey('a'), (err) => {
    // GCM auth failure (OperationError) — not a silent wrong-key return.
    assert.ok(err);
    return true;
  });
});

test('a legacy v1 store (no AAD) migrates to v2 on unlock and still round-trips', async () => {
  const storage = newStorage();
  const priv = new Uint8Array(32).map((_, i) => i + 5);
  const pub = new Uint8Array(32).map((_, i) => i + 60);
  // Hand-craft a genuine v1 store: PBKDF2(600k, SHA-256) wrapping key, AES-GCM
  // with NO additionalData, version 1 — exactly the pre-WB-01 format.
  const v1 = await makeV1Store(passphrase, [{ keyId: 'legacy', priv, pub }]);
  await storage.set({ 'infrix.keystore.v1': v1 });

  const ks = new EncryptedKeystore(storage);
  await ks.unlock(passphrase); // verifies (no-AAD path) then migrates in place
  assert.equal(storage.raw['infrix.keystore.v1'].version, 2, 'store upgraded to v2');
  const got = await ks.getKey('legacy'); // now AAD-bound; must still decrypt
  assert.deepEqual(got, priv);
});

test('a legacy v1 store still rejects the wrong passphrase', async () => {
  const storage = newStorage();
  const v1 = await makeV1Store(passphrase, []);
  await storage.set({ 'infrix.keystore.v1': v1 });
  const ks = new EncryptedKeystore(storage);
  await assert.rejects(() => ks.unlock(wrong), /invalid passphrase/);
});

// --- WB-09: key identity (label / purpose / last-used) ---------------------

test('addKey stores label + purpose; getKey stamps lastUsedAt; setKeyLabel renames', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.addKey('k', new Uint8Array(32).fill(9), new Uint8Array(32).fill(8), { label: 'Trading key', purpose: 'trading' });
  let list = await ks.listKeys();
  assert.equal(list[0].label, 'Trading key');
  assert.equal(list[0].purpose, 'trading');
  assert.equal(list[0].lastUsedAt, '');
  await ks.getKey('k');
  list = await ks.listKeys();
  assert.notEqual(list[0].lastUsedAt, '', 'getKey stamps lastUsedAt');
  assert.equal(await ks.setKeyLabel('k', 'Renamed'), true);
  assert.equal((await ks.listKeys())[0].label, 'Renamed');
  assert.equal(await ks.setKeyLabel('missing', 'x'), false);
});

test('overwriting a key preserves its createdAt + label when meta omits them', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.addKey('k', new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), { label: 'Original' });
  const before = (await ks.listKeys())[0];
  await ks.addKey('k', new Uint8Array(32).fill(3), new Uint8Array(32).fill(4)); // no meta
  const after = (await ks.listKeys())[0];
  assert.equal(after.label, 'Original', 'label preserved across overwrite');
  assert.equal(after.createdAt, before.createdAt, 'createdAt preserved across overwrite');
  assert.deepEqual(await ks.getKey('k'), new Uint8Array(32).fill(3), 'private key still overwritten');
});

// --- WB-04: idle auto-lock -------------------------------------------------

test('idle timeout auto-locks the keystore and getKey then throws', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  ks.setIdleTimeout(1000); // minimum allowed
  await ks.addKey('k', new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  assert.equal(ks.isUnlocked(), true);
  assert.ok(ks.remainingMs() > 0 && ks.remainingMs() <= 1000);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(ks.isUnlocked(), false, 'auto-locked after the idle window');
  assert.equal(ks.remainingMs(), 0);
  await assert.rejects(() => ks.getKey('k'), /locked/);
});

test('getKey after an explicit lock throws', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.addKey('k', new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  ks.lock();
  await assert.rejects(() => ks.getKey('k'), /locked/);
});

test('rotate zeroizes the decrypted private keys it re-encrypts', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.addKey('k', new Uint8Array(32).fill(0x5a), new Uint8Array(32).fill(2));
  // Spy on _encryptBytes to capture the plaintext buffer rotate hands it; after
  // rotate resolves, that buffer must be all-zero (WB-01 zeroize-on-rotate).
  const captured = [];
  const orig = ks._encryptBytes.bind(ks);
  ks._encryptBytes = (bytes, wk, aad) => { captured.push(bytes); return orig(bytes, wk, aad); };
  await ks.rotate(passphrase, wrong);
  // At least one captured buffer is a 32-byte private key, and every captured
  // private-key buffer is zeroed (the check record is a short ASCII string, skip it).
  const privBufs = captured.filter((b) => b.length === 32);
  assert.ok(privBufs.length >= 1, 'rotate should re-encrypt at least one private key');
  for (const b of privBufs) assert.ok(b.every((x) => x === 0), 'decrypted private key must be zeroized after rotate');
});

// --- WB-03: recovery-phrase (seed) storage -------------------------------

test('setSeed / getSeed round-trips the recovery phrase; hasSeed reflects it', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  assert.equal(await ks.hasSeed(), false);
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  await ks.setSeed(phrase);
  assert.equal(await ks.hasSeed(), true);
  assert.equal(await ks.getSeed(), phrase);
});

test('getSeed requires an unlocked keystore', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.setSeed('legal winner thank year wave sausage worth useful legal winner thank yellow');
  ks.lock();
  await assert.rejects(() => ks.getSeed(), /locked/);
});

test('rotate carries the recovery phrase forward under the new passphrase', async () => {
  const storage = newStorage();
  const ks = new EncryptedKeystore(storage);
  await ks.initialize(passphrase);
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  await ks.setSeed(phrase);
  await ks.rotate(passphrase, wrong);
  ks.lock();
  await ks.unlock(wrong);
  assert.equal(await ks.getSeed(), phrase, 'seed survived rotation under the new passphrase');
});

test('addKey persists source + derivationPath metadata', async () => {
  const ks = new EncryptedKeystore(newStorage());
  await ks.initialize(passphrase);
  await ks.addKey('seedkey', new Uint8Array(48).fill(3), new Uint8Array(32).fill(4), { source: 'seed', derivationPath: "m/44'/281'/0'/0'/0'" });
  const list = await ks.listKeys();
  assert.equal(list[0].source, 'seed');
  assert.equal(list[0].derivationPath, "m/44'/281'/0'/0'/0'");
});

// makeV1Store reproduces the pre-WB-01 (v1, no-AAD) on-disk format so the
// migration path is exercised against a real legacy store, not a mock.
async function makeV1Store(pass, keys) {
  const enc = new TextEncoder();
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pass), { name: 'PBKDF2' }, false, ['deriveKey']);
  const wk = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const encNoAad = async (bytes) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, bytes));
    return { iv: b64(iv), ciphertext: b64(ct) };
  };
  const check = await encNoAad(enc.encode('infrix.keystore.v1.passphrase.check'));
  const keyEntries = [];
  for (const k of keys) {
    const e = await encNoAad(k.priv);
    keyEntries.push({ keyId: k.keyId, iv: e.iv, ciphertext: e.ciphertext, createdAt: new Date().toISOString(), pubKey: b64(k.pub) });
  }
  return { version: 1, salt: b64(salt), checkIv: check.iv, checkCiphertext: check.ciphertext, keys: keyEntries };
}
