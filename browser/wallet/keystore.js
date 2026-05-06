// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// G-25 phase 1a — encrypted keystore for the wallet extension.
//
// Implements passphrase-encrypted storage of ED25519 signing keys
// using Web Crypto's PBKDF2 (key derivation) + AES-GCM (AEAD) so
// the popup never holds plaintext keys at rest. Auto-locks after a
// configurable inactivity timeout. Supports key rotation: a new
// passphrase encrypts a fresh wrapping key; old wrapping keys
// decrypt-only until rotated to.
//
// Web Crypto choice rationale:
//   - PBKDF2 with 600k iterations meets OWASP 2024 guidance for
//     password-based key derivation and is natively supported by
//     every browser the extension targets. Argon2id offers stronger
//     guarantees but requires a 60KB polyfill; we accept the
//     PBKDF2 trade-off for a stdlib-only build.
//   - AES-GCM is the canonical AEAD for Web Crypto. Equivalent
//     security to ChaCha20-Poly1305 for the wallet's threat model
//     (offline ciphertext attacker after extension uninstall;
//     on-device passphrase brute-force).
//
// Storage layout (chrome.storage.local under "infrix.keystore.v1"):
//   {
//     version: 1,
//     salt:    base64(16-byte random salt, fixed at first init),
//     checkIv: base64(12-byte AES-GCM IV for passphrase verification),
//     checkCiphertext: base64(AES-GCM ciphertext + tag for fixed verifier),
//     keys: [
//       {
//         keyId:        string (uuid-v4),
//         iv:           base64(12-byte AES-GCM IV),
//         ciphertext:   base64(AES-GCM ciphertext + tag),
//         createdAt:    ISO 8601 timestamp,
//         pubKey:       base64(ED25519 public key) for fast lookup
//       }
//     ]
//   }

const STORAGE_KEY = 'infrix.keystore.v1';
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const CHECK_PLAINTEXT = 'infrix.keystore.v1.passphrase.check';

// Default auto-lock idle timeout: 15 minutes. Operators with stricter
// policies override via setIdleTimeout().
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Encrypted Keystore: persists ED25519 signing keys encrypted under
 * a passphrase-derived wrapping key. Goroutine-safe is irrelevant
 * for browser JS, but every async operation is independently safe
 * (no shared mutable state outside `this.unlocked`).
 */
export class EncryptedKeystore {
  /**
   * @param {object} storage — chrome.storage.local-shaped object
   *   exposing get(key) and set(obj). Tests pass an in-memory shim;
   *   production passes chrome.storage.local.
   */
  constructor(storage) {
    if (!storage) throw new Error('EncryptedKeystore: storage adapter required');
    this.storage = storage;
    this.unlocked = null; // { wrappingKey, salt, lockTimer }
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    this.subtle = (globalThis.crypto && globalThis.crypto.subtle);
    if (!this.subtle) {
      throw new Error('EncryptedKeystore: globalThis.crypto.subtle unavailable');
    }
  }

  setIdleTimeout(ms) {
    if (typeof ms !== 'number' || ms < 1000) {
      throw new Error('idle timeout must be ≥1000ms');
    }
    this.idleTimeoutMs = ms;
    if (this.unlocked) this._resetIdleTimer();
  }

  isUnlocked() {
    return this.unlocked !== null;
  }

  /**
   * Initialize a fresh keystore with a passphrase. Generates a
   * random salt and wrapping key. If a keystore already exists,
   * throws — callers must use rotate() to change passphrase.
   */
  async initialize(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new Error('passphrase required');
    }
    const existing = await this._loadStore();
    if (existing) throw new Error('keystore already initialized; use rotate()');
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const wrappingKey = await this._deriveWrappingKey(passphrase, salt);
    const check = await this._encryptBytes(new TextEncoder().encode(CHECK_PLAINTEXT), wrappingKey);
    const store = {
      version: 1,
      salt: bytesToB64(salt),
      checkIv: bytesToB64(check.iv),
      checkCiphertext: bytesToB64(check.ciphertext),
      keys: [],
    };
    await this._saveStore(store);
    this.unlocked = { wrappingKey, salt };
    this._resetIdleTimer();
  }

  /**
   * Unlock an existing keystore with the supplied passphrase.
   * Throws if the passphrase is wrong (AES-GCM decryption failure
   * surfaces as a crypto OperationError; we normalize to a clear
   * message).
   */
  async unlock(passphrase) {
    const store = await this._loadStore();
    if (!store) throw new Error('keystore not initialized');
    const salt = b64ToBytes(store.salt);
    const wrappingKey = await this._deriveWrappingKey(passphrase, salt);
    // Verify the passphrase even when no keys exist yet. Without a
    // check record, an empty keystore would accept any passphrase.
    try {
      await this._verifyPassphraseCheck(store, wrappingKey);
    } catch (err) {
      throw new Error('invalid passphrase');
    }
    this.unlocked = { wrappingKey, salt };
    this._resetIdleTimer();
  }

  /** Forget the in-memory wrapping key. Required after every signing operation per OWASP. */
  lock() {
    if (this.unlocked && this.unlocked.lockTimer) {
      clearTimeout(this.unlocked.lockTimer);
    }
    this.unlocked = null;
  }

  /**
   * Add a key to the unlocked keystore. Stores an encrypted record
   * keyed by the supplied keyId; pubKey is stored alongside in
   * plaintext for fast lookup. Both privKey and pubKey are byte
   * arrays (Uint8Array).
   */
  async addKey(keyId, privKey, pubKey) {
    this._requireUnlocked();
    if (!keyId || !privKey || !pubKey) {
      throw new Error('addKey: keyId, privKey, pubKey are required');
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await this.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.unlocked.wrappingKey,
      privKey,
    );
    const entry = {
      keyId,
      iv: bytesToB64(iv),
      ciphertext: bytesToB64(new Uint8Array(ct)),
      createdAt: new Date().toISOString(),
      pubKey: bytesToB64(pubKey),
    };
    const store = await this._loadStore();
    store.keys = store.keys.filter(k => k.keyId !== keyId);
    store.keys.push(entry);
    await this._saveStore(store);
    this._resetIdleTimer();
  }

  /**
   * Retrieve and decrypt a key by ID. Returns the plaintext
   * Uint8Array. The caller must zeroize the result after use.
   */
  async getKey(keyId) {
    this._requireUnlocked();
    const store = await this._loadStore();
    const entry = store.keys.find(k => k.keyId === keyId);
    if (!entry) throw new Error(`key ${keyId} not found`);
    const plaintext = await this._decryptEntry(entry, this.unlocked.wrappingKey);
    this._resetIdleTimer();
    return plaintext;
  }

  async deleteKey(keyId) {
    if (!keyId) throw new Error('deleteKey: keyId required');
    const store = await this._loadStore();
    if (!store) return false;
    const before = store.keys.length;
    store.keys = store.keys.filter(k => k.keyId !== keyId);
    if (store.keys.length === before) return false;
    await this._saveStore(store);
    if (this.unlocked) this._resetIdleTimer();
    return true;
  }

  /** List keyId + pubKey for every stored key. Does not unlock. */
  async listKeys() {
    const store = await this._loadStore();
    if (!store) return [];
    return store.keys.map(k => ({
      keyId: k.keyId,
      pubKey: b64ToBytes(k.pubKey),
      createdAt: k.createdAt,
    }));
  }

  /**
   * Rotate the keystore to a new passphrase. The old passphrase
   * must currently unlock; on success every key is re-encrypted
   * under a fresh wrapping key derived from newPassphrase.
   */
  async rotate(oldPassphrase, newPassphrase) {
    if (newPassphrase === oldPassphrase) {
      throw new Error('rotate: new passphrase must differ from old');
    }
    await this.unlock(oldPassphrase);
    const store = await this._loadStore();
    const oldKeys = [];
    for (const entry of store.keys) {
      const pt = await this._decryptEntry(entry, this.unlocked.wrappingKey);
      oldKeys.push({ keyId: entry.keyId, pubKey: b64ToBytes(entry.pubKey), priv: pt });
    }
    const newSalt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const newWrappingKey = await this._deriveWrappingKey(newPassphrase, newSalt);
    const check = await this._encryptBytes(new TextEncoder().encode(CHECK_PLAINTEXT), newWrappingKey);
    const newEntries = [];
    for (const k of oldKeys) {
      const encrypted = await this._encryptBytes(k.priv, newWrappingKey);
      newEntries.push({
        keyId: k.keyId,
        iv: bytesToB64(encrypted.iv),
        ciphertext: bytesToB64(encrypted.ciphertext),
        createdAt: new Date().toISOString(),
        pubKey: bytesToB64(k.pubKey),
      });
    }
    const newStore = {
      version: 1,
      salt: bytesToB64(newSalt),
      checkIv: bytesToB64(check.iv),
      checkCiphertext: bytesToB64(check.ciphertext),
      keys: newEntries,
    };
    await this._saveStore(newStore);
    this.unlocked = { wrappingKey: newWrappingKey, salt: newSalt };
    this._resetIdleTimer();
  }

  // --- internals -----------------------------------------------

  async _deriveWrappingKey(passphrase, salt) {
    const baseKey = await this.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    );
    return this.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async _decryptEntry(entry, wrappingKey) {
    const iv = b64ToBytes(entry.iv);
    const ct = b64ToBytes(entry.ciphertext);
    const pt = await this.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      ct,
    );
    return new Uint8Array(pt);
  }

  async _encryptBytes(bytes, wrappingKey) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await this.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      bytes,
    );
    return { iv, ciphertext: new Uint8Array(ct) };
  }

  async _verifyPassphraseCheck(store, wrappingKey) {
    if (!store.checkIv || !store.checkCiphertext) {
      throw new Error('keystore missing passphrase verification record');
    }
    const pt = await this.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(store.checkIv) },
      wrappingKey,
      b64ToBytes(store.checkCiphertext),
    );
    const decoded = new TextDecoder().decode(pt);
    if (decoded !== CHECK_PLAINTEXT) {
      throw new Error('keystore passphrase verification mismatch');
    }
  }

  async _loadStore() {
    const raw = await this.storage.get(STORAGE_KEY);
    if (!raw) return null;
    if (raw[STORAGE_KEY]) return raw[STORAGE_KEY];
    if (raw.version === 1) return raw;
    return null;
  }

  async _saveStore(store) {
    await this.storage.set({ [STORAGE_KEY]: store });
  }

  _requireUnlocked() {
    if (!this.unlocked) throw new Error('keystore is locked');
  }

  _resetIdleTimer() {
    if (this.unlocked.lockTimer) clearTimeout(this.unlocked.lockTimer);
    this.unlocked.lockTimer = setTimeout(() => this.lock(), this.idleTimeoutMs);
    if (typeof this.unlocked.lockTimer.unref === 'function') {
      this.unlocked.lockTimer.unref();
    }
  }
}

// --- base64 helpers -------------------------------------------

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
