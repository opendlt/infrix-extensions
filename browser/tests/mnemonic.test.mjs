// WB-03 — BIP39 + SLIP-0010 (ed25519) derivation tests.
//
// These are the correctness gates that make seed-phrase recovery safe to ship:
//   * the vendored BIP39 wordlist matches the canonical SHA-256 (one wrong word
//     would silently break recovery);
//   * the vendored @noble/ed25519 file matches its pinned SHA-256 (no tampering);
//   * BIP39 + SLIP-0010 match the OFFICIAL published test vectors (interop);
//   * the @noble-derived public key cross-validates against Web Crypto's native
//     Ed25519 (sign with the PKCS8 we store, verify with the pubkey @noble gave)
//     — proving the vendored curve and our PKCS8 wrap agree with the platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORDLIST } from '../wallet/vendor/bip39-english.js';
import {
  entropyToMnemonic, validateMnemonic, mnemonicToSeed, slip10DerivePath,
  deriveKey, seedToPkcs8, _internal,
} from '../wallet/mnemonic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const hex = (u8) => Buffer.from(u8).toString('hex');
const fromHex = _internal.hexToBytes;

// Canonical integrity constants.
const WORDLIST_FILE_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';
const NOBLE_ED25519_SHA256 = '39fb70069dd6668828313d76f40229c1d771609cff786192e2868b68ca7b492f';

test('vendored BIP39 wordlist is the canonical 2048-word list (SHA-256 gate)', () => {
  assert.equal(WORDLIST.length, 2048);
  assert.equal(WORDLIST[0], 'abandon');
  assert.equal(WORDLIST[2047], 'zoo');
  // The canonical english.txt is the words joined by \n WITH a trailing newline.
  const sha = createHash('sha256').update(WORDLIST.join('\n') + '\n').digest('hex');
  assert.equal(sha, WORDLIST_FILE_SHA256, 'wordlist drifted from the canonical BIP39 english list');
});

test('vendored @noble/ed25519 is unmodified (pinned SHA-256)', async () => {
  const bytes = await readFile(path.join(here, '..', 'wallet', 'vendor', 'noble-ed25519.js'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), NOBLE_ED25519_SHA256);
});

test('BIP39 official vector: all-zero entropy → known phrase → known seed', async () => {
  const phrase = await entropyToMnemonic(new Uint8Array(16)); // 128 bits of zero
  assert.equal(
    phrase,
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  assert.equal(await validateMnemonic(phrase), true);
  // Trezor BIP39 vector: passphrase "TREZOR".
  const seed = await mnemonicToSeed(phrase, 'TREZOR');
  assert.equal(
    hex(seed),
    'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
  );
});

test('validateMnemonic rejects a bad checksum and non-wordlist words', async () => {
  // valid phrase with the last word swapped → checksum fails
  const bad = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
  assert.equal(await validateMnemonic(bad), false);
  assert.equal(await validateMnemonic('zzzz not real words at all here one two three four five six'), false);
  assert.equal(await validateMnemonic('abandon'), false); // wrong length
});

test('SLIP-0010 ed25519 official vector (m/0\'/1\'/2\'/2\')', async () => {
  const seed = fromHex('000102030405060708090a0b0c0d0e0f');
  const node = await slip10DerivePath(seed, "m/0'/1'/2'/2'");
  assert.equal(hex(node.key), '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662');
  const pub = await _internal.ed.getPublicKeyAsync(node.key);
  assert.equal(hex(pub), '8abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c');
});

test('cross-check: @noble pubkey + our PKCS8 agree with Web Crypto native Ed25519', async () => {
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const { pkcs8, publicKey } = await deriveKey(phrase, '', 0);
  // Sign with the PKCS8 we would store, using Web Crypto's own Ed25519.
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const msg = new TextEncoder().encode('infrix cross-check');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, msg));
  // Verify with the public key @noble derived — if @noble's pubkey didn't match
  // the PKCS8 keypair, this verify would fail.
  const pub = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, msg), true);
  // And @noble verifies a Web-Crypto-made signature symmetrically.
  assert.equal(await _internal.ed.verifyAsync(sig, msg, publicKey), true);
});

test('derivation is deterministic and index-separated', async () => {
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const a0 = await deriveKey(phrase, '', 0);
  const a0b = await deriveKey(phrase, '', 0);
  const a1 = await deriveKey(phrase, '', 1);
  assert.equal(hex(a0.publicKey), hex(a0b.publicKey), 'same phrase+index → same key');
  assert.notEqual(hex(a0.publicKey), hex(a1.publicKey), 'different index → different key');
  // A passphrase changes the derived key (the BIP39 25th-word).
  const a0p = await deriveKey(phrase, 'extra', 0);
  assert.notEqual(hex(a0.publicKey), hex(a0p.publicKey));
  assert.equal(pkcs8Len(a0.pkcs8), 48);
});

function pkcs8Len(u8) { return u8.length; }
