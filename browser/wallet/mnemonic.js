// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// WB-03 — BIP39 mnemonic + SLIP-0010 (ed25519) key derivation.
//
// Recovery backbone: a 12-word BIP39 mnemonic deterministically derives the
// wallet's Ed25519 signing keys. All hashing (SHA-256, HMAC-SHA512, PBKDF2-
// SHA512) goes through Web Crypto — available in the background module worker.
// The one operation Web Crypto cannot do — derive an Ed25519 public key from a
// raw seed — is delegated to the vendored, audited @noble/ed25519 (see
// wallet/vendor/). The 32-byte derived private seed is wrapped into PKCS8 so the
// existing keystore/signing path (Web Crypto importKey('pkcs8') → sign) is
// unchanged; the public key comes from @noble. The two are cross-validated
// against Web Crypto's native Ed25519 in tests/mnemonic.test.mjs.

import { WORDLIST } from './vendor/bip39-english.js';
import * as ed from './vendor/noble-ed25519.js';

const enc = new TextEncoder();
const SLIP10_ED25519_KEY = enc.encode('ed25519 seed');
const HARDENED = 0x80000000;

// Accumulate SLIP-0044 coin type is 281 (ACME). Per-key index is appended as a
// hardened component. This is the wallet's derivation convention; recovering the
// same mnemonic + passphrase reproduces the identical keys.
export const ACCOUNT_PATH = "m/44'/281'/0'/0'";

// PKCS8 prefix for a raw Ed25519 private seed (RFC 8410): the 16-byte DER header
// + the 32-byte seed = a 48-byte PrivateKeyInfo importable via Web Crypto.
const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420');

// ---- byte helpers ----------------------------------------------------------
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function concat(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ---- Web Crypto primitives -------------------------------------------------
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
async function hmacSha512(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}
async function pbkdf2Sha512(passBytes, saltBytes, iterations, lenBytes) {
  const base = await crypto.subtle.importKey('raw', passBytes, { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-512' }, base, lenBytes * 8,
  );
  return new Uint8Array(bits);
}

// ---- BIP39 -----------------------------------------------------------------
export async function generateMnemonic(strengthBits = 128) {
  if (strengthBits % 32 !== 0 || strengthBits < 128 || strengthBits > 256) {
    throw new Error('strength must be 128..256 in steps of 32');
  }
  return entropyToMnemonic(crypto.getRandomValues(new Uint8Array(strengthBits / 8)));
}

export async function entropyToMnemonic(entropy) {
  const ENT = entropy.length * 8;
  const CS = ENT / 32;
  const hash = await sha256(entropy);
  const bits = [];
  for (const b of entropy) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  for (let i = 0; i < CS; i++) bits.push((hash[Math.floor(i / 8)] >> (7 - (i % 8))) & 1);
  const words = [];
  for (let i = 0; i < bits.length; i += 11) {
    let idx = 0;
    for (let j = 0; j < 11; j++) idx = (idx << 1) | bits[i + j];
    words.push(WORDLIST[idx]);
  }
  return words.join(' ');
}

export async function validateMnemonic(phrase) {
  const words = String(phrase).normalize('NFKD').trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  const indices = [];
  for (const w of words) {
    const idx = WORDLIST.indexOf(w);
    if (idx < 0) return false;
    indices.push(idx);
  }
  const bits = [];
  for (const idx of indices) for (let i = 10; i >= 0; i--) bits.push((idx >> i) & 1);
  const ENT = Math.floor(bits.length / 33) * 32;
  const CS = bits.length - ENT;
  const entropy = new Uint8Array(ENT / 8);
  for (let i = 0; i < ENT; i++) if (bits[i]) entropy[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
  const hash = await sha256(entropy);
  for (let i = 0; i < CS; i++) {
    const bit = (hash[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
    if (bit !== bits[ENT + i]) return false;
  }
  return true;
}

export async function mnemonicToSeed(phrase, passphrase = '') {
  const pass = enc.encode(String(phrase).normalize('NFKD'));
  const salt = enc.encode('mnemonic' + String(passphrase).normalize('NFKD'));
  return pbkdf2Sha512(pass, salt, 2048, 64); // BIP39: fixed 2048 rounds, 64-byte seed
}

// ---- SLIP-0010 (ed25519, hardened-only) ------------------------------------
async function slip10Master(seed) {
  const I = await hmacSha512(SLIP10_ED25519_KEY, seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}
async function slip10CKDpriv(node, index) {
  const idx = index >>> 0;
  const ser = new Uint8Array([(idx >>> 24) & 0xff, (idx >>> 16) & 0xff, (idx >>> 8) & 0xff, idx & 0xff]);
  const I = await hmacSha512(node.chainCode, concat(new Uint8Array([0]), node.key, ser));
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}
function parsePath(path) {
  const parts = String(path).split('/');
  if (parts[0] !== 'm') throw new Error('path must start with m');
  const out = [];
  for (const p of parts.slice(1)) {
    const hardened = /['hH]$/.test(p);
    const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
    if (!Number.isInteger(n) || n < 0) throw new Error('bad path component: ' + p);
    out.push((n + (hardened ? HARDENED : 0)) >>> 0);
  }
  return out;
}

// slip10DerivePath returns the { key, chainCode } node at `path`. ed25519 only
// supports hardened derivation, so every component must be hardened.
export async function slip10DerivePath(seed, path) {
  let node = await slip10Master(seed);
  for (const idx of parsePath(path)) {
    if (idx < HARDENED) throw new Error('ed25519 SLIP-0010 requires hardened derivation: ' + path);
    node = await slip10CKDpriv(node, idx);
  }
  return node;
}

// ---- wallet keypair derivation ---------------------------------------------
// seedToPkcs8 wraps a 32-byte Ed25519 private seed into a PKCS8 PrivateKeyInfo
// so it can be imported and signed with via Web Crypto, exactly like a
// generateKey()-produced key — no change to the signing path.
export function seedToPkcs8(seed32) {
  return concat(PKCS8_ED25519_PREFIX, seed32);
}

// deriveKey derives the index-th account key from a mnemonic + passphrase.
// Returns { path, pkcs8 (48 bytes), publicKey (32 bytes) }. Transient seed
// material is zeroized before returning.
export async function deriveKey(mnemonic, passphrase, index = 0) {
  const seed = await mnemonicToSeed(mnemonic, passphrase);
  let node;
  try {
    const path = ACCOUNT_PATH + '/' + (index >>> 0) + "'";
    node = await slip10DerivePath(seed, path);
    const publicKey = await ed.getPublicKeyAsync(node.key);
    const pkcs8 = seedToPkcs8(node.key); // copies node.key into a fresh buffer
    return { path, pkcs8, publicKey };
  } finally {
    seed.fill(0);
    if (node && node.key) node.key.fill(0);
  }
}

// Test/diagnostic surface (not for production callers).
export const _internal = { hexToBytes, concat, sha256, hmacSha512, ed };
